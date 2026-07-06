import { GRID_N } from "./constants.js";
import { S, viewport } from "./state.js";
import { clamp } from "./utils.js";
import { savePrefs, undo, redo } from "./persistence.js";
import { roomsOnLayer } from "./model.js";
import { render } from "./app.js";
import { stepLayer, zoomAt, centerOnRoom, centerCellView } from "./render-flat.js";
import { render3d } from "./render-3d.js";
import { buildLegend, buildStats } from "./stats-legend.js";
import { runSearch, jumpNextMatch, setPathHint } from "./search-path.js";

// ---------- Toolbar wiring ----------
export function updateViewButtons() {
  document.querySelectorAll("#viewseg button").forEach(b => b.classList.toggle("active", b.dataset.view === S.view));
}
document.querySelectorAll("#viewseg button").forEach(b => {
  b.onclick = () => { S.view = b.dataset.view; updateViewButtons(); render(); };
});
document.getElementById("layerUp").onclick = () => stepLayer(+1);
document.getElementById("layerDown").onclick = () => stepLayer(-1);
// Link and Path are mutually exclusive interaction modes.
export function setMode(mode) {
  S.linkMode = (mode === "link");
  S.pathMode = (mode === "path");
  S.areaMode = (mode === "area");
  if (!S.linkMode) { S.pendingLink = null; const hint = document.getElementById("linkHint"); if (hint) hint.style.display = "none"; }
  if (!S.pathMode) S.pathStart = null;
  if (!S.areaMode && S.selectedAreaId) { S.selectedAreaId = null; }
  if (!S.areaMode) S.areaMergeSource = null;
  document.getElementById("linkBtn").classList.toggle("active", S.linkMode);
  document.getElementById("pathBtn").classList.toggle("active", S.pathMode);
  document.getElementById("areaBtn").classList.toggle("active", S.areaMode);
  viewport.classList.toggle("linkmode", S.linkMode || S.pathMode);
  viewport.classList.toggle("areamode", S.areaMode);
  if (S.pathMode) setPathHint();
  render();
}
document.getElementById("linkBtn").onclick = () => setMode(S.linkMode ? "none" : "link");
document.getElementById("pathBtn").onclick = () => setMode(S.pathMode ? "none" : "path");
document.getElementById("areaBtn").onclick = () => setMode(S.areaMode ? "none" : "area");
document.getElementById("searchBox").addEventListener("input", e => runSearch(e.target.value));
document.getElementById("searchBox").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); jumpNextMatch(); }
});
document.getElementById("undoBtn").onclick = undo;
document.getElementById("redoBtn").onclick = redo;

// ---------- Legend / onion / stats / export / import popovers ----------
export function positionPopover(panel, btn) {
  const r = btn.getBoundingClientRect();
  panel.style.display = "block";
  const w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + "px";
  panel.style.top = clamp(r.bottom + 6, 8, window.innerHeight - h - 8) + "px";
}
document.getElementById("legendBtn").onclick = () => {
  const panel = document.getElementById("legendPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildLegend();
  positionPopover(panel, document.getElementById("legendBtn"));
};
function syncOnionControls() {
  document.getElementById("onionBelow").checked = S.onion.below;
  document.getElementById("onionAbove").checked = S.onion.above;
  document.getElementById("onionOpacity").value = S.onion.opacity;
}
document.getElementById("onionBtn").onclick = () => {
  const panel = document.getElementById("onionPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  syncOnionControls();
  positionPopover(panel, document.getElementById("onionBtn"));
};
document.getElementById("onionBelow").onchange = e => { S.onion.below = e.target.checked; savePrefs(); render(); };
document.getElementById("onionAbove").onchange = e => { S.onion.above = e.target.checked; savePrefs(); render(); };
document.getElementById("onionOpacity").oninput = e => { S.onion.opacity = parseFloat(e.target.value); savePrefs(); render(); };
document.getElementById("statsBtn").onclick = () => {
  const panel = document.getElementById("statsPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildStats();
  positionPopover(panel, document.getElementById("statsBtn"));
};
document.querySelectorAll(".popclose").forEach(b => {
  b.onclick = () => { document.getElementById(b.dataset.close).style.display = "none"; };
});
// close popovers when clicking elsewhere
const POPS = { legendPanel: "legendBtn", onionPanel: "onionBtn", statsPanel: "statsBtn",
               exportPanel: "exportBtn", importPanel: "importBtn" };
document.addEventListener("mousedown", e => {
  for (const id of Object.keys(POPS)) {
    const panel = document.getElementById(id);
    const btn = document.getElementById(POPS[id]);
    if (panel.style.display === "block" && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target))
      panel.style.display = "none";
  }
});
document.getElementById("zoomIn").onclick = () => {
  if (S.view === "3d") { S.cam3d.dist = clamp(S.cam3d.dist / 1.2, 200, 12000); render3d(); return; }
  const r = viewport.getBoundingClientRect(); zoomAt(r.left+r.width/2, r.top+r.height/2, 1.2);
};
document.getElementById("zoomOut").onclick = () => {
  if (S.view === "3d") { S.cam3d.dist = clamp(S.cam3d.dist * 1.2, 200, 12000); render3d(); return; }
  const r = viewport.getBoundingClientRect(); zoomAt(r.left+r.width/2, r.top+r.height/2, 1/1.2);
};
document.getElementById("zoomReset").onclick = () => {
  if (S.view === "3d") {
    // recenter & reframe the orbit camera to the default ¾ view
    S.cam3d.yaw = 0.7; S.cam3d.pitch = 0.5; S.cam3d.fitted = false;
    render3d();
    return;
  }
  S.scale = 1;
  const sel = S.selectedId && S.map.rooms[S.selectedId];
  if (sel && sel.z === S.map.currentLayer) centerOnRoom(sel);
  else { const rooms = roomsOnLayer(S.map.currentLayer); rooms.length ? centerOnRoom(rooms[0]) : centerCellView(GRID_N/2, GRID_N/2); }
};
