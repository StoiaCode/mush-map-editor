import { S } from "./state.js";
import { uid, escapeHtml } from "./utils.js";
import { clearSelection } from "./model.js";
import { commit, normalize, resetHistory, save, defaultMap } from "./persistence.js";
import { render } from "./app.js";
import { centerOnPoint } from "./render-web.js";
import { positionPopover } from "./toolbar.js";

// ---------- Export (whole map — no layers/areas to filter here) ----------
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click(); URL.revokeObjectURL(a.href);
}
document.getElementById("exportBtn").onclick = () => {
  const n = Object.keys(S.map.characters).length;
  if (!n) { alert("Nothing to export yet."); return; }
  const out = { ...S.map, meta: { date: new Date().toISOString().slice(0, 10), characters: n } };
  downloadJSON(out, "character-tracker-" + out.meta.date + ".json");
};

// ---------- Import (replace or additive) ----------
export function stageImport(data, anchorBtn) {
  if (!data || !data.characters) throw new Error("Not a valid character map (no characters).");
  S.pendingImport = data;
  const m = data.meta || {};
  const n = Object.keys(data.characters).length;
  document.getElementById("importSummary").innerHTML =
    `${n} character${n !== 1 ? "s" : ""}` + (m.date ? ` · ${escapeHtml(m.date)}` : "");
  const panel = document.getElementById("importPanel");
  positionPopover(panel, anchorBtn);
}
document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { stageImport(JSON.parse(reader.result), document.getElementById("importBtn")); }
    catch (err) { alert("Import failed: " + err.message); }
  };
  reader.readAsText(file); e.target.value = "";
};
document.getElementById("importReplace").onclick = () => {
  if (!S.pendingImport) return;
  if (!confirm("Replace the current map entirely?")) return;
  S.map = S.pendingImport; normalize(); clearSelection();
  resetHistory(); save(); render();
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
  const src = Object.values(data.characters || {});
  if (!src.length) return;
  const idMap = {};
  for (const ch of src) idMap[ch.id] = uid();
  // offset imported positions so they don't stack exactly on top of existing nodes
  const maxX = Math.max(0, ...Object.values(S.map.characters).map(c => c.x));
  const minX = Math.min(0, ...src.map(c => c.x));
  const dx = Object.keys(S.map.characters).length ? (maxX + 150 - minX) : 0;
  const newIds = [];
  for (const ch of src) {
    const nid = idMap[ch.id];
    S.map.characters[nid] = {
      id: nid, name: ch.name || "New Character", description: ch.description || "",
      imageUrls: Array.isArray(ch.imageUrls) ? [...ch.imageUrls] : [],
      clan: ch.clan || "", sect: ch.sect || "", coterie: ch.coterie || "",
      myRelationship: ch.myRelationship || "", notableFeatures: ch.notableFeatures || "",
      tags: Array.isArray(ch.tags) ? [...ch.tags] : [], color: ch.color || "Slate",
      x: (ch.x || 0) + dx, y: ch.y || 0,
    };
    newIds.push(nid);
  }
  for (const rel of (data.relationships || [])) {
    const from = idMap[rel.fromId], to = idMap[rel.toId];
    if (from && to) S.map.relationships.push({ id: uid(), fromId: from, toId: to, label: rel.label || "" });
  }
  for (const ann of (data.annotations || [])) {
    S.map.annotations.push({ id: uid(), name: ann.name || "Group", color: ann.color || "Slate",
      cx: (ann.cx || 0) + dx, cy: ann.cy || 0, rx: ann.rx || 80, ry: ann.ry || 80 });
  }
  S.selectedId = newIds[0];
  commit(); render(); centerOnPoint(S.map.characters[newIds[0]].x, S.map.characters[newIds[0]].y);
}
document.getElementById("newMapBtn").onclick = () => {
  if (!confirm("Start a new empty map? This clears everything (export first if you want a backup).")) return;
  S.map = defaultMap(); clearSelection(); S.scale = 1; resetHistory(); save(); render(); centerOnPoint(0, 0);
};
