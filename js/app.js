import { GRID_N } from "./constants.js";
import { S, viewport, view3dEl } from "./state.js";
import { load, loadPrefs, resetHistory } from "./persistence.js";
import { roomsOnLayer } from "./model.js";
import { renderFlat, updateLayerLabel, resizeCanvas, centerOnRoom, centerCellView } from "./render-flat.js";
import { resize3d, render3d } from "./render-3d.js";
import { renderInspector } from "./inspector.js";
import { updateViewButtons } from "./toolbar.js";

// Side-effect-only imports: these modules wire up their own event listeners and
// nothing else imports named bindings from them, so without this line they'd
// never load and the app would have no pointer/keyboard/export/import behaviour.
import "./interactions.js";
import "./export-import.js";
import "./sync.js";

// ---------- Render dispatcher ----------
// Central so every other module can trigger a redraw via one import, instead of
// each needing to know about renderFlat/render3d/renderInspector individually.
export function render() {
  updateLayerLabel();
  if (S.view === "flat") {
    viewport.style.display = ""; view3dEl.classList.remove("active");
    renderFlat();
  } else {
    viewport.style.display = "none"; view3dEl.classList.add("active");
    resize3d();
    render3d();
  }
  renderInspector();
}

// ---------- Init ----------
export function fitInitial() {
  const rooms = roomsOnLayer(S.map.currentLayer);
  rooms.length ? centerOnRoom(rooms[0]) : centerCellView(GRID_N/2, GRID_N/2);
}
window.addEventListener("resize", () => {
  resizeCanvas();
  if (S.view === "3d") { resize3d(); render3d(); }
});

load();
loadPrefs();
resetHistory();
resizeCanvas();
updateViewButtons();
render();
fitInitial();
