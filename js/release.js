import { CELL, GRID_N, SIZE_PX } from "./constants.js";
import { S, viewport, world } from "./state.js";
import { escapeHtml, colorOf } from "./utils.js";
import { spaceOf, clearSelection, selectSingle, roomAtCell } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { setMode, updateViewButtons } from "./toolbar.js";
import { screenToWorld, resizeCanvas, centerCellView } from "./render-flat.js";
import { spaceName, shortLayerName, setSpace, toast, roomsInSpace, MAIN_NAME } from "./spaces.js";

// ---------- Release: move rooms from a space back onto the main map (Phase 5) ----------
// Shares the S.capture slot with capture.js (kind: "release") so every "the map is locked while
// a move is pending" guard applies to both. The rooms keep their layout; a ghost of them follows
// the mouse over the main map, red wherever it would land on an existing room, and a click drops
// it. Everything happens in one commit.

export function startRelease(ids) {
  const rooms = ids.map(id => S.map.rooms[id]).filter(r => r && spaceOf(r));
  if (!rooms.length) return;
  const from = spaceOf(rooms[0]);
  // the "handle" is the room that sits on the cursor: one with a door to the main map if any, so
  // it can line up with its door; its door also suggests which main-map layer it belongs on
  let handle = rooms[0], dz = 0;
  for (const r of rooms) {
    const out = Object.entries(r.exits).map(([dir, t]) => ({ dir, t: S.map.rooms[t] })).find(e => e.t && !spaceOf(e.t));
    if (out) {
      handle = r;
      dz = out.t.z + (out.dir === "DOWN" ? 1 : out.dir === "UP" ? -1 : 0) - r.z;   // UP from street = street z + 1
      break;
    }
  }
  setMode("none");
  if (S.view !== "flat") { S.view = "flat"; updateViewButtons(); }
  setSpace(null, handle.z + dz);
  clearSelection();
  S.capture = { kind: "release", source: null, from, ids: new Set(rooms.map(r => r.id)), handleId: handle.id, dz, cell: null,
                foot: rooms.map(r => ({ id: r.id, dx: r.x - handle.x, dy: r.y - handle.y, dz: r.z - handle.z })) };
  // start the ghost in the middle of the view so it's visible straight away
  const vr = viewport.getBoundingClientRect();
  const w = screenToWorld(vr.left + vr.width / 2, vr.top + vr.height / 2);
  S.capture.cell = { x: Math.floor(w.x / CELL), y: Math.floor(w.y / CELL) };
  renderReleaseBanner();
  render();
}

// Where each room would land with the handle on `cell`, and which of those spots are taken.
function placement(c, cell) {
  return c.foot.map(f => {
    const x = cell.x + f.dx, y = cell.y + f.dy, z = S.map.rooms[c.handleId].z + c.dz + f.dz;
    const oob = x < 0 || y < 0 || x >= GRID_N || y >= GRID_N;
    const hit = !oob && roomAtCell(z, x, y, null);
    return { id: f.id, x, y, z, bad: oob || !!hit };
  });
}

// Called at the end of renderFlat while releasing: ghosts for the rooms on the visible layer.
export function drawReleaseGhost() {
  const c = S.capture;
  if (!c || c.kind !== "release" || !c.cell) return;
  world.querySelectorAll(".rel-ghost").forEach(e => e.remove());
  for (const p of placement(c, c.cell)) {
    if (p.z !== S.map.currentLayer) continue;
    const r = S.map.rooms[p.id];
    const el = document.createElement("div");
    el.className = "rel-ghost" + (p.bad ? " bad" : "");
    const px = SIZE_PX[r.size] || SIZE_PX.medium;
    el.style.left = (p.x * CELL + CELL / 2) + "px"; el.style.top = (p.y * CELL + CELL / 2) + "px";
    el.style.width = px + "px"; el.style.height = px + "px";
    el.style.backgroundColor = colorOf(r);
    el.textContent = r.name;
    world.appendChild(el);
  }
}
viewport.addEventListener("mousemove", e => {
  const c = S.capture;
  if (!c || c.kind !== "release" || S.drag) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const cell = { x: Math.floor(w.x / CELL), y: Math.floor(w.y / CELL) };
  if (c.cell && cell.x === c.cell.x && cell.y === c.cell.y) return;
  c.cell = cell;
  drawReleaseGhost();
  renderReleaseBanner();
});

export function releaseDrop(e) {
  const c = S.capture;
  const w = screenToWorld(e.clientX, e.clientY);
  c.cell = { x: Math.floor(w.x / CELL), y: Math.floor(w.y / CELL) };
  const places = placement(c, c.cell);
  if (places.some(p => p.bad)) {
    toast("Some rooms would land on existing rooms (red). Move somewhere free, or change the layer shift.");
    render(); renderReleaseBanner();
    return;
  }
  for (const p of places) { const r = S.map.rooms[p.id]; r.x = p.x; r.y = p.y; r.z = p.z; r.space = null; }
  const from = c.from, n = places.length, handle = S.map.rooms[c.handleId];
  endRelease();
  S.map.currentLayer = handle.z;
  selectSingle(handle.id);
  commit(); render();
  const left = roomsInSpace(from).length;
  toast(`Moved <b>${n} room${n !== 1 ? "s" : ""}</b> from <b>${escapeHtml(spaceName(from))}</b> onto the ${MAIN_NAME.toLowerCase()}.` +
    (left ? "" : ` That space is now empty; you can delete it in ⧉ Spaces.`) + ` Ctrl+Z undoes it.`);
}
function endRelease() {
  S.capture = null;
  document.getElementById("captureBanner").style.display = "none";
  world.querySelectorAll(".rel-ghost").forEach(e => e.remove());
  resizeCanvas();
}
export function cancelRelease() {
  const from = S.capture.from;
  endRelease();
  render();
  toast(`Cancelled. The rooms are still in <b>${escapeHtml(spaceName(from))}</b>.`);
}

function renderReleaseBanner() {
  const c = S.capture;
  const el = document.getElementById("captureBanner");
  const places = c.cell ? placement(c, c.cell) : [];
  const byZ = new Map(), badZ = new Set();
  for (const p of places) { byZ.set(p.z, (byZ.get(p.z) || 0) + 1); if (p.bad) badZ.add(p.z); }
  const zs = [...byZ.keys()].sort((a, b) => a - b);
  const nBad = places.filter(p => p.bad).length;
  el.innerHTML =
    `<div class="cap-title">⧉ Move ${c.ids.size} room${c.ids.size !== 1 ? "s" : ""} from <b>${escapeHtml(spaceName(c.from))}</b> onto the ${MAIN_NAME.toLowerCase()} <span class="hint">(nothing changes until you click a spot)</span></div>` +
    `<div class="cap-line">Move the mouse to place them, then click to drop. <b>${escapeHtml(S.map.rooms[c.handleId].name)}</b> sits under the cursor. ` +
    `They'll land on: ` + zs.map(z => `<span class="rel-z${badZ.has(z) ? " bad" : ""}">${escapeHtml(shortLayerName(z, null))} · ${byZ.get(z)}</span>`).join(" ") +
    ` <span class="hint">(▲▼ in the toolbar to look at each layer)</span></div>` +
    (nBad ? `<div class="cap-line cap-err">⛔ ${nBad} room${nBad !== 1 ? "s" : ""} would land on existing rooms (red) — move somewhere free.</div>` : "") +
    `<div class="cap-line cap-controls">Layer shift <button id="relDn">−</button><b>${c.dz > 0 ? "+" : ""}${c.dz}</b><button id="relUp">+</button>` +
    `<span class="spacer"></span><button id="relCancel">✕ Cancel</button></div>` +
    `<div class="hint">Drag to pan, wheel to zoom. Esc cancels.</div>`;
  el.style.display = "block";
  document.getElementById("app").style.setProperty("--cap-color", "#8a93a3");
  document.getElementById("relDn").onclick = () => { c.dz--; S.map.currentLayer--; render(); renderReleaseBanner(); };
  document.getElementById("relUp").onclick = () => { c.dz++; S.map.currentLayer++; render(); renderReleaseBanner(); };
  document.getElementById("relCancel").onclick = cancelRelease;
  resizeCanvas();
}
