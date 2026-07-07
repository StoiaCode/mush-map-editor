import { DIRS, GRID_N } from "./constants.js";
import { S } from "./state.js";
import { uid, clamp, escapeHtml } from "./utils.js";
import { roomInArea, roomsInArea, layersPresent, roomsOnLayer, clearSelection } from "./model.js";
import { commit, normalize, resetHistory, save, defaultMap } from "./persistence.js";
import { render, fitInitial } from "./app.js";
import { centerOnRoom, centerCellView } from "./render-flat.js";
import { positionPopover } from "./toolbar.js";

// ---------- Export (filtered / partial) ----------
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click(); URL.revokeObjectURL(a.href);
}
export function exportSelection() {
  // layers: checked ids; areas: checked ids (empty = no area restriction)
  const layers = new Set([...document.querySelectorAll("#expLayers input:checked")].map(c => parseInt(c.value, 10)));
  const areaIds = new Set([...document.querySelectorAll("#expAreas input:checked")].map(c => c.value));
  const chosenAreas = S.map.areas.filter(a => areaIds.has(a.id));
  const rooms = Object.values(S.map.rooms).filter(r => {
    if (!layers.has(r.z)) return false;
    if (chosenAreas.length && !chosenAreas.some(a => roomInArea(r, a))) return false;
    return true;
  });
  return { rooms, chosenAreas, layers };
}
export function buildExportPanel() {
  const lay = document.getElementById("expLayers");
  lay.innerHTML = layersPresent().map(z =>
    `<label><input type="checkbox" value="${z}" checked> Layer ${z}<span class="cnt">${roomsOnLayer(z).length}</span></label>`).join("");
  const ar = document.getElementById("expAreas");
  ar.innerHTML = S.map.areas.length
    ? S.map.areas.map(a => `<label><input type="checkbox" value="${a.id}"> ${escapeHtml(a.name)}<span class="cnt">${roomsInArea(a)}</span></label>`).join("")
    : `<div class="hint">No areas defined.</div>`;
  lay.querySelectorAll("input").forEach(c => c.onchange = updateExportCount);
  ar.querySelectorAll("input").forEach(c => c.onchange = updateExportCount);
  updateExportCount();
}
export function updateExportCount() {
  const { rooms, chosenAreas } = exportSelection();
  document.getElementById("expCount").textContent =
    `${rooms.length} room${rooms.length !== 1 ? "s" : ""}` + (chosenAreas.length ? ` · ${chosenAreas.length} area${chosenAreas.length !== 1 ? "s" : ""}` : "") + " will export";
}
export function doExport() {
  const { rooms } = exportSelection();
  if (!rooms.length) { alert("Nothing selected to export."); return; }
  const stripNames = document.getElementById("expStripNames").checked;
  const stripDesc = document.getElementById("expStripDesc").checked;
  const stripColor = document.getElementById("expStripColor").checked;
  const included = new Set(rooms.map(r => r.id));
  const outRooms = {};
  for (const r of rooms) {
    const copy = { ...r, exits: {}, exitFly: {} };
    for (const d of DIRS) {                    // prune exits leaving the sold set
      const t = r.exits[d];
      if (t && included.has(t)) { copy.exits[d] = t; if (r.exitFly && r.exitFly[d]) copy.exitFly[d] = true; }
    }
    if (stripNames) copy.name = "";
    if (stripDesc) copy.description = "";
    if (stripColor) copy.color = "Slate";
    outRooms[r.id] = copy;
  }
  // areas that contain at least one exported room
  const outAreas = S.map.areas.filter(a => rooms.some(r => roomInArea(r, a))).map(a => ({ ...a, rects: a.rects.map(rc => ({ ...rc })) }));
  // transit lines: keep real stations that made the cut, plus every stub (no room to be "in or
  // out" of the export); a dual stop collapses to whichever side survived, or is dropped if
  // neither did. A line needs 2+ remaining stops to be usable.
  const outLines = S.map.transitLines
    .map(l => ({ ...l, stations: l.stations.map(e => {
      if (typeof e === "string") return included.has(e) ? e : null;
      if (e.dual) {
        const a = included.has(e.a) ? e.a : null, b = included.has(e.b) ? e.b : null;
        return (a && b) ? { ...e } : (a || b);
      }
      return e;   // stub
    }).filter(Boolean) }))
    .filter(l => l.stations.length >= 2);
  const zs = rooms.map(r => r.z);
  const title = document.getElementById("expTitle").value.trim();
  const author = document.getElementById("expAuthor").value.trim();
  const out = {
    version: 2, partial: true,
    meta: { title, author, date: new Date().toISOString().slice(0, 10), rooms: rooms.length },
    rooms: outRooms, areas: outAreas, transitLines: outLines, tagLabels: S.map.tagLabels,
    currentLayer: Math.min(...zs)
  };
  const slug = (title || "mush-map-partial").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  downloadJSON(out, (slug || "mush-map-partial") + "-" + out.meta.date + ".json");
  document.getElementById("exportPanel").style.display = "none";
}
document.getElementById("exportBtn").onclick = () => {
  const panel = document.getElementById("exportPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildExportPanel();
  positionPopover(panel, document.getElementById("exportBtn"));
};
document.getElementById("expDo").onclick = doExport;

// ---------- Import (replace or additive) ----------
document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.rooms) throw new Error("Not a valid map file (no rooms).");
      S.pendingImport = data;
      const m = data.meta || {};
      const roomCount = Object.keys(data.rooms).length;
      document.getElementById("importSummary").innerHTML =
        (m.title ? `<b>${escapeHtml(m.title)}</b><br>` : "") +
        (m.author ? `by ${escapeHtml(m.author)}<br>` : "") +
        `${roomCount} room${roomCount !== 1 ? "s" : ""}` + (m.date ? ` · ${escapeHtml(m.date)}` : "") +
        (data.partial ? ` · partial map` : "");
      const panel = document.getElementById("importPanel");
      positionPopover(panel, document.getElementById("importBtn"));
    } catch (err) { alert("Import failed: " + err.message); }
  };
  reader.readAsText(file); e.target.value = "";
};
document.getElementById("importReplace").onclick = () => {
  if (!S.pendingImport) return;
  if (!confirm("Replace the current map entirely?")) return;
  S.map = S.pendingImport; normalize(); clearSelection();
  resetHistory(); save(); render(); fitInitial();
  S.pendingImport = null;
  document.getElementById("importPanel").style.display = "none";
};
document.getElementById("importAdd").onclick = () => {
  if (!S.pendingImport) return;
  mergeImport(S.pendingImport);
  S.pendingImport = null;
  document.getElementById("importPanel").style.display = "none";
};
export function mergeImport(data) {
  const src = Object.values(data.rooms || {});
  if (!src.length) return;
  const idMap = {};
  for (const r of src) idMap[r.id] = uid();
  // find a uniform cell shift so imported rooms don't overlap existing ones
  const occ = new Set(Object.values(S.map.rooms).map(r => r.z + ":" + r.x + ":" + r.y));
  const collides = (dx, dy) => src.some(r => occ.has(r.z + ":" + (r.x + dx) + ":" + (r.y + dy)));
  let dx = 0, dy = 0;
  if (collides(0, 0)) {
    const maxX = Math.max(0, ...Object.values(S.map.rooms).map(r => r.x));
    const minX = Math.min(...src.map(r => r.x));
    dx = maxX + 2 - minX;
    let guard = 0;
    while (collides(dx, dy) && guard++ < GRID_N) dx++;   // scan east until clear
  }
  const clampX = v => clamp(v, 0, GRID_N - 1), clampY = v => clamp(v, 0, GRID_N - 1);
  const newIds = [];
  for (const r of src) {
    const nid = idMap[r.id];
    const nr = { id: nid, name: r.name || "New Room", description: r.description || "",
      color: r.color || "Slate", size: r.size || "medium", imageUrl: r.imageUrl || "",
      x: clampX(r.x + dx), y: clampY(r.y + dy), z: r.z, exits: {}, exitFly: {} };
    for (const d of DIRS) {
      const t = r.exits && r.exits[d];
      if (t && idMap[t]) { nr.exits[d] = idMap[t]; if (r.exitFly && r.exitFly[d]) nr.exitFly[d] = true; }
    }
    S.map.rooms[nid] = nr; newIds.push(nid);
  }
  for (const a of (data.areas || [])) {
    const rects = (Array.isArray(a.rects) && a.rects.length) ? a.rects : [{ x: a.x, y: a.y, w: a.w, h: a.h }];  // accept new or legacy
    S.map.areas.push({ id: uid(), name: a.name, color: a.color,
      rects: rects.map(rc => ({ x: clampX(rc.x + dx), y: clampY(rc.y + dy), w: rc.w, h: rc.h })) });
  }
  for (const line of (data.transitLines || [])) {
    const stations = (line.stations || []).map(e => {
      if (typeof e === "string") return idMap[e] || null;   // real station: remap through the room id map, drop if it didn't survive
      if (e && e.dual) {
        const a = idMap[e.a], b = idMap[e.b];
        return (a && b) ? { dual: true, id: uid(), a, b } : (a || b || null);
      }
      return { stub: true, id: uid(), name: (e && e.name) || "Unknown Stop" };  // stub: keep, fresh id (avoid collisions on repeat imports)
    }).filter(Boolean);
    if (stations.length) S.map.transitLines.push({ id: uid(), name: line.name, color: line.color, stations });
  }
  S.selection = new Set(newIds);
  S.selectedId = newIds[0];
  S.map.currentLayer = S.map.rooms[newIds[0]].z;
  commit(); render(); centerOnRoom(S.map.rooms[newIds[0]]);
}
document.getElementById("newMapBtn").onclick = () => {
  if (!confirm("Start a new empty map? This clears the current map (export first if you want a backup).")) return;
  S.map = defaultMap(); clearSelection(); S.scale = 1; resetHistory(); save(); render(); centerCellView(GRID_N/2, GRID_N/2);
};

