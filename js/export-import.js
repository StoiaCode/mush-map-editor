import { DIRS, GRID_N } from "./constants.js";
import { S } from "./state.js";
import { uid, clamp, escapeHtml } from "./utils.js";
import { roomInArea, roomsInArea, layersPresent, roomsOnLayer, clearSelection, spaceOf } from "./model.js";
import { spaceName, layerName, announceLocation } from "./spaces.js";
import { commit, resetHistory, save, defaultMap } from "./persistence.js";
import { render } from "./app.js";
import { centerOnRoom, centerCellView } from "./render-flat.js";
import { positionPopover } from "./toolbar.js";
import { enterPreview } from "./preview.js";

// ---------- Export (filtered / partial) ----------
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click(); URL.revokeObjectURL(a.href);
}
// Layers are per space, so the export checklist keys them as "spaceId|z" ("" = main map).
const layerKey = (space, z) => (space || "") + "|" + z;
export function exportSelection() {
  // layers: checked space|z keys; areas: checked ids (empty = no area restriction)
  const layers = new Set([...document.querySelectorAll("#expLayers input:checked")].map(c => c.value));
  const areaIds = new Set([...document.querySelectorAll("#expAreas input:checked")].map(c => c.value));
  const chosenAreas = S.map.areas.filter(a => areaIds.has(a.id));
  const rooms = Object.values(S.map.rooms).filter(r => {
    if (!layers.has(layerKey(spaceOf(r), r.z))) return false;
    if (chosenAreas.length && !chosenAreas.some(a => roomInArea(r, a))) return false;
    return true;
  });
  return { rooms, chosenAreas, layers };
}
export function buildExportPanel() {
  const lay = document.getElementById("expLayers");
  const spaces = [null, ...S.map.spaces.map(sp => sp.id)];
  const multi = S.map.spaces.length > 0;
  lay.innerHTML = spaces.flatMap(sp => {
    const zs = layersPresent(sp).filter(z => roomsOnLayer(z, sp).length || (!sp && !multi));
    return zs.map(z => `<label><input type="checkbox" value="${escapeHtml(layerKey(sp, z))}" checked> ` +
      (multi ? escapeHtml(spaceName(sp)) + " · " : "") + escapeHtml(layerName(z, sp)) +
      `<span class="cnt">${roomsOnLayer(z, sp).length}</span></label>`);
  }).join("");
  const ar = document.getElementById("expAreas");
  ar.innerHTML = S.map.areas.length
    ? S.map.areas.map(a => `<label><input type="checkbox" value="${a.id}"> ${multi ? escapeHtml(spaceName(spaceOf(a))) + " · " : ""}${escapeHtml(a.name)}<span class="cnt">${roomsInArea(a)}</span></label>`).join("")
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
  const usedSpaces = new Set(rooms.map(spaceOf));
  const outSpaces = S.map.spaces.filter(sp => usedSpaces.has(sp.id)).map(sp => ({ ...sp }));
  // open on the main map if it has any exported rooms, otherwise on the first exported space
  const startSpace = usedSpaces.has(null) ? null : spaceOf(rooms[0]);
  const zs = rooms.filter(r => spaceOf(r) === startSpace).map(r => r.z);
  const title = document.getElementById("expTitle").value.trim();
  const author = document.getElementById("expAuthor").value.trim();
  const out = {
    version: 3, partial: true,
    meta: { title, author, date: new Date().toISOString().slice(0, 10), rooms: rooms.length },
    rooms: outRooms, areas: outAreas, spaces: outSpaces, transitLines: outLines, tagLabels: S.map.tagLabels, traits: S.map.traits,
    currentSpace: startSpace, currentLayer: Math.min(...zs)
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
// File-based import and sync-code load (js/sync.js) both hand the parsed map to
// enterPreview() (js/preview.js), which renders it on the canvas for a real look
// before the user picks Merge/Replace/Discard.
document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { enterPreview(JSON.parse(reader.result)); }
    catch (err) { alert("Import failed: " + err.message); }
  };
  reader.readAsText(file); e.target.value = "";
};
export function mergeImport(data) {
  const src = Object.values(data.rooms || {});
  if (!src.length) return;
  const idMap = {};
  for (const r of src) idMap[r.id] = uid();
  // trait catalog entries always get fresh ids on import (same accepted-duplication
  // approach used for transit lines below), then each room's trait ids remap through it
  const traitIdMap = {};
  for (const t of (data.traits || [])) {
    if (!t || typeof t.id !== "string") continue;
    const nt = { id: uid(), emoji: t.emoji || "✨", label: t.label || "New Trait" };
    traitIdMap[t.id] = nt.id;
    S.map.traits.push(nt);
  }
  // imported spaces always become new spaces (fresh ids), so only main-map rooms can collide
  // with what's already here; space rooms keep their own coordinates untouched
  const spaceIdMap = {};
  for (const sp of (data.spaces || [])) {
    if (!sp || typeof sp.id !== "string") continue;
    const nsp = { id: uid(), name: sp.name || "Unnamed space", color: sp.color || "Purple" };
    spaceIdMap[sp.id] = nsp.id;
    S.map.spaces.push(nsp);
  }
  const newSpace = o => (o && o.space && spaceIdMap[o.space]) || null;
  const srcMain = src.filter(r => !newSpace(r));
  // find a uniform cell shift so imported main-map rooms don't overlap existing ones
  const mainRooms = Object.values(S.map.rooms).filter(r => !r.space);
  const occ = new Set(mainRooms.map(r => r.z + ":" + r.x + ":" + r.y));
  const collides = (dx, dy) => srcMain.some(r => occ.has(r.z + ":" + (r.x + dx) + ":" + (r.y + dy)));
  let dx = 0, dy = 0;
  if (collides(0, 0)) {
    const maxX = Math.max(0, ...mainRooms.map(r => r.x));
    const minX = Math.min(...srcMain.map(r => r.x));
    dx = maxX + 2 - minX;
    let guard = 0;
    while (collides(dx, dy) && guard++ < GRID_N) dx++;   // scan east until clear
  }
  const clampX = v => clamp(v, 0, GRID_N - 1), clampY = v => clamp(v, 0, GRID_N - 1);
  const newIds = [];
  for (const r of src) {
    const nid = idMap[r.id];
    const sp = newSpace(r), sx = sp ? 0 : dx, sy = sp ? 0 : dy;
    const nr = { id: nid, name: r.name || "New Room", description: r.description || "",
      color: r.color || "Slate", size: r.size || "medium", imageUrl: r.imageUrl || "",
      x: clampX(r.x + sx), y: clampY(r.y + sy), z: r.z, space: sp, exits: {}, exitFly: {},
      traits: Array.isArray(r.traits) ? r.traits.map(id => traitIdMap[id]).filter(Boolean) : [] };
    for (const d of DIRS) {
      const t = r.exits && r.exits[d];
      if (t && idMap[t]) { nr.exits[d] = idMap[t]; if (r.exitFly && r.exitFly[d]) nr.exitFly[d] = true; }
    }
    S.map.rooms[nid] = nr; newIds.push(nid);
  }
  for (const a of (data.areas || [])) {
    const rects = (Array.isArray(a.rects) && a.rects.length) ? a.rects : [{ x: a.x, y: a.y, w: a.w, h: a.h }];  // accept new or legacy
    const sp = newSpace(a), sx = sp ? 0 : dx, sy = sp ? 0 : dy;
    S.map.areas.push({ id: uid(), name: a.name, color: a.color, space: sp,
      rects: rects.map(rc => ({ x: clampX(rc.x + sx), y: clampY(rc.y + sy), w: rc.w, h: rc.h })) });
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
    if (stations.length) S.map.transitLines.push({ id: uid(), name: line.name, color: line.color, stations, loop: !!line.loop });
  }
  // select the imported rooms in whichever space we land on (selection never spans spaces):
  // the main map if anything landed there, else the first imported space
  const first = S.map.rooms[newIds.find(id => !S.map.rooms[id].space) || newIds[0]];
  const landed = newIds.filter(id => (S.map.rooms[id].space || null) === (first.space || null));
  S.selection = new Set(landed);
  S.selectedId = first.id;
  S.map.currentSpace = first.space || null;
  S.map.currentLayer = first.z;
  commit(); render(); centerOnRoom(first);
  if (first.space) announceLocation("Merged; now in");   // landed inside an imported space: say so
}
document.getElementById("newMapBtn").onclick = () => {
  if (!confirm("Start a new empty map? This clears the current map (export first if you want a backup).")) return;
  S.map = defaultMap(); clearSelection(); S.scale = 1; resetHistory(); save(); render(); centerCellView(GRID_N/2, GRID_N/2);
};

