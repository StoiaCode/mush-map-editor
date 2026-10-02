import { GRID_N } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml, escapeAttr, clamp } from "./utils.js";
import { spaceOf, curSpace, clearSelection, selectSingle, inSpace, areasInSpace, roomInArea } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { setMode, updateViewButtons } from "./toolbar.js";
import { setLayer, centerOnRoom, resizeCanvas } from "./render-flat.js";
import { spaceName, spaceColor, roomLocation, shortLayerName, setSpace, toast, roomsInSpace, layerName } from "./spaces.js";
import { createSpace } from "./spaces-panel.js";

// ---------- Capture: move rooms into a space (docs/plans/spaces.md, Phase 4) ----------
// S.capture holds the preview while it's open. Nothing in the map changes until "Move" is
// pressed, and then it's a single commit, so one Ctrl+Z puts everything back.
//
// Two ways in:
//   door      — pick an exit on a room (the "anchor"); everything reachable from the room behind
//               it (the "seed") without coming back through that exit gets captured. If the fill
//               reaches the anchor some other way, the building connects back to the outside
//               somewhere else: that's a leak, and moving is blocked until it's cut.
//   selection — exactly the rooms the mapper multi-selected, no fill.
// In both, clicking a room in the preview takes it out (door mode: plus everything that was
// only reachable through it) or puts it back.

const SOFT_MAX = 50;          // more rooms than this in one capture probably means a leak
const SOFT_FRACTION = 0.25;   // ...as does grabbing over a quarter of the source space

export function startDoorCapture(anchorId, dir) {
  const anchor = S.map.rooms[anchorId];
  const seed = anchor && S.map.rooms[anchor.exits[dir]];
  if (!seed) return;
  if (spaceOf(seed) !== spaceOf(anchor)) { alert("That exit already leads into another space."); return; }
  begin({ mode: "door", anchorId, cutDir: dir, seedId: seed.id, excluded: new Set(),
          name: anchor.name + " (inside)" });
}
export function startSelectionCapture(ids) {
  const rooms = ids.map(id => S.map.rooms[id]).filter(Boolean);
  if (!rooms.length) return;
  begin({ mode: "selection", ids: new Set(rooms.map(r => r.id)), name: rooms[0].name + " (space)" });
}
function begin(c) {
  setMode("none");
  if (S.view !== "flat") { S.view = "flat"; updateViewButtons(); }
  c.source = curSpace();
  c.target = "new";
  S.capture = c;
  clearSelection();
  recompute();
  // start on the seed's layer so the first thing you see is what's being moved
  const first = S.map.rooms[c.seedId] || S.map.rooms[[...c.ids][0]];
  if (first) { S.map.currentLayer = first.z; }
  renderBanner();
  render();
  if (first) centerOnRoom(first);
}
export function cancelCapture() {
  if (!S.capture) return;
  S.capture = null;
  document.getElementById("captureBanner").style.display = "none";
  resizeCanvas();
  render();
}

// Undirected neighbours: an exit in either direction joins two rooms for capture purposes, so a
// one-way exit into the building can't hide a room from the fill.
function adjacency() {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const r of Object.values(S.map.rooms))
    for (const t of Object.values(r.exits)) if (S.map.rooms[t]) { add(r.id, t); add(t, r.id); }
  return adj;
}
function recompute() {
  const c = S.capture;
  if (c.mode === "door") {
    const adj = adjacency();
    const ids = new Set([c.seedId]), parent = new Map();
    const q = [c.seedId];
    let leakFrom = null;
    while (q.length) {
      const cur = q.shift();
      for (const n of adj.get(cur) || []) {
        if (n === c.anchorId) {
          if (cur !== c.seedId && !leakFrom) leakFrom = cur;   // seed↔anchor is the cut itself
          continue;
        }
        if (ids.has(n) || c.excluded.has(n) || spaceOf(S.map.rooms[n]) !== c.source) continue;
        ids.add(n); parent.set(n, cur); q.push(n);
      }
    }
    c.ids = ids;
    c.leakPath = null;
    if (leakFrom) {
      const path = [c.anchorId, leakFrom];
      for (let n = leakFrom; parent.has(n); ) { n = parent.get(n); path.push(n); }
      c.leakPath = path.reverse();   // seed … → anchor
    }
  }
  // doors the new space will have: exits from a captured room to anything left outside
  const doors = new Map();
  for (const id of c.ids) {
    const r = S.map.rooms[id];
    for (const [dir, t] of Object.entries(r.exits)) {
      if (!S.map.rooms[t] || c.ids.has(t)) continue;
      if (!doors.has(t)) doors.set(t, { outside: S.map.rooms[t], inside: r, dir });
    }
    for (const o of Object.values(S.map.rooms))   // one-way exits pointing in count too
      if (!c.ids.has(o.id) && !doors.has(o.id) && Object.values(o.exits).includes(id))
        doors.set(o.id, { outside: o, inside: r, dir: null });
  }
  c.doors = [...doors.values()];
}

// A click on a room while the preview is open.
export function captureClick(id) {
  const c = S.capture;
  const r = S.map.rooms[id];
  if (!c || !r || spaceOf(r) !== c.source) return;
  if (c.mode === "selection") {
    if (c.ids.has(id)) c.ids.delete(id); else c.ids.add(id);
  } else {
    if (id === c.anchorId) { toast("That's the room outside the door; it stays where it is."); return; }
    if (id === c.seedId) { toast("That's the room right behind the door. To start from a different exit, cancel and pick another."); return; }
    if (c.excluded.has(id)) c.excluded.delete(id);
    else if (c.ids.has(id)) c.excluded.add(id);
    else { toast("That room isn't reachable through the door, so it isn't being moved."); return; }
  }
  recompute(); render(); renderBanner();
}

// How a room looks in the preview (render-flat.js adds these classes).
export function captureClass(r) {
  const c = S.capture;
  if (!c || c.kind === "release" || spaceOf(r) !== c.source) return "";
  if (r.id === c.anchorId) return " cap-anchor";
  if (c.excluded && c.excluded.has(r.id)) return " cap-excluded";
  if (c.ids.has(r.id)) return " cap-in" + (c.leakPath && c.leakPath.includes(r.id) ? " cap-leak" : "");
  return " cap-out";
}

function renderBanner() {
  const c = S.capture;
  const el = document.getElementById("captureBanner");
  if (!c) { el.style.display = "none"; return; }
  const n = c.ids.size;
  const byLayer = new Map();
  for (const id of c.ids) { const z = S.map.rooms[id].z; byLayer.set(z, (byLayer.get(z) || 0) + 1); }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const total = roomsInSpace(c.source).length;
  const big = n > SOFT_MAX || (total >= 40 && n > total * SOFT_FRACTION);   // small maps: a quarter is normal
  const blocked = !!c.leakPath || !n;
  const targets = S.map.spaces.filter(sp => sp.id !== c.source);
  const rn = id => escapeHtml(S.map.rooms[id] ? S.map.rooms[id].name : "?");

  let h = `<div class="cap-title">⧉ Move into a space — preview <span class="hint">(nothing changes until you press Move)</span></div>`;
  h += `<div class="cap-line">` + (c.mode === "door"
    ? `Everything behind <b>${rn(c.anchorId)}</b> → <b>${escapeHtml(c.cutDir)}</b>, starting at <b>${rn(c.seedId)}</b>.`
    : `The rooms you selected.`) +
    ` Layers: ` + layers.map(z => `<button class="cap-layer${z === S.map.currentLayer ? " active" : ""}" data-z="${z}">${escapeHtml(shortLayerName(z, c.source))} · ${byLayer.get(z)}</button>`).join(" ") + `</div>`;

  const nd = c.doors.length;
  h += `<div class="cap-line${nd > 1 ? " cap-warn" : ""}">🚪 This space will have <b>${nd} door${nd !== 1 ? "s" : ""}</b> to the outside: ` +
    (nd ? c.doors.map(d => `<b>${escapeHtml(d.outside.name)}</b> <span class="hint">(${escapeHtml(roomLocation(d.outside))})</span>`).join(", ") : "none") +
    (nd > 1 ? ` — expected just one? A side door or fire escape may have pulled in rooms that belong outside.` : "") + `</div>`;
  if (c.leakPath) {
    h += `<div class="cap-line cap-err">⛔ <b>Leak:</b> the rooms behind this door lead back to <b>${rn(c.anchorId)}</b> another way: ` +
      c.leakPath.map((id, i) => i === c.leakPath.length - 1 ? `<b>${rn(id)}</b>`
        : `<button class="cap-pathroom" data-id="${escapeAttr(id)}" title="Leave this room (and everything only reachable through it) out">${rn(id)}</button>`).join(" → ") +
      `. Click the room where the building ends to leave it out.</div>`;
  }
  if (big && !c.leakPath) h += `<div class="cap-line cap-warn">⚠ That's ${n} rooms${total ? ` (${Math.round(n / total * 100)}% of ${escapeHtml(spaceName(c.source))})` : ""}. Check the highlighted rooms. Did the fill escape into the street?</div>`;
  if (c.excluded && c.excluded.size) h += `<div class="cap-line hint">${c.excluded.size} room${c.excluded.size !== 1 ? "s" : ""} left out (crossed out on the map; click to put back).</div>`;

  h += `<div class="cap-line cap-controls">Move <b>${n} room${n !== 1 ? "s" : ""}</b> on <b>${layers.length} layer${layers.length !== 1 ? "s" : ""}</b> into
    <select id="capTarget"><option value="new"${c.target === "new" ? " selected" : ""}>a new space named…</option>` +
    targets.map(sp => `<option value="${escapeAttr(sp.id)}"${c.target === sp.id ? " selected" : ""}>existing: ${escapeHtml(sp.name)}</option>`).join("") +
    `</select>` +
    (c.target === "new" ? `<input type="text" id="capName" value="${escapeAttr(c.name)}" placeholder="Space name">` : "") +
    `<span class="spacer"></span>` +
    `<button id="capGo" class="primary"${blocked ? " disabled" : ""}>⧉ Move ${n} room${n !== 1 ? "s" : ""}</button>` +
    `<button id="capCancel">✕ Cancel</button></div>`;
  h += `<div class="hint">Click a highlighted room to leave it out${c.mode === "door" ? " (along with anything only reachable through it)" : ""}; click a crossed-out room to put it back. Esc cancels. One Ctrl+Z undoes the whole move.</div>`;
  el.innerHTML = h;
  el.style.display = "block";
  // on #app so both the banner and the highlighted rooms pick it up
  document.getElementById("app").style.setProperty("--cap-color", c.target === "new" ? "#a87ce8" : spaceColor(c.target));

  el.querySelectorAll(".cap-layer").forEach(b => b.onclick = () => { setLayer(+b.dataset.z); renderBanner(); });
  el.querySelectorAll(".cap-pathroom").forEach(b => b.onclick = () => captureClick(b.dataset.id));
  document.getElementById("capTarget").onchange = e => { c.target = e.target.value; renderBanner(); };
  const nameIn = document.getElementById("capName");
  if (nameIn) nameIn.oninput = e => { c.name = e.target.value; };
  document.getElementById("capCancel").onclick = cancelCapture;
  document.getElementById("capGo").onclick = applyCapture;
  resizeCanvas();   // banner height varies with its warnings
}

function applyCapture() {
  const c = S.capture;
  if (!c || c.leakPath || !c.ids.size) return;
  let sp;
  if (c.target === "new") {
    const name = (c.name || "").trim();
    if (!name) { alert("Give the new space a name."); return; }
    sp = createSpace(name);
  } else {
    sp = S.map.spaces.find(x => x.id === c.target);
    if (!sp) return;
  }
  const rooms = [...c.ids].map(id => S.map.rooms[id]);
  // keep the layout: shift the block as a whole. Lowest captured layer becomes the space's
  // lowest (0 for a new space); floors are labelled relative to the door anyway.
  const minX = Math.min(...rooms.map(r => r.x)), maxX = Math.max(...rooms.map(r => r.x));
  const minY = Math.min(...rooms.map(r => r.y)), maxY = Math.max(...rooms.map(r => r.y));
  const minZ = Math.min(...rooms.map(r => r.z));
  const existing = roomsInSpace(sp.id);
  let dx, dy, dz;
  if (!existing.length) {
    dx = Math.round(GRID_N / 2 - (minX + maxX) / 2);
    dy = Math.round(GRID_N / 2 - (minY + maxY) / 2);
    dz = -minZ;
  } else {
    // next to what's already there, with a gap, so nothing can overlap
    const eMaxX = Math.max(...existing.map(r => r.x));
    const eMinY = Math.min(...existing.map(r => r.y)), eMaxY = Math.max(...existing.map(r => r.y));
    dx = eMaxX + 3 - minX;
    dy = Math.round((eMinY + eMaxY) / 2 - (minY + maxY) / 2);
    dz = Math.min(...existing.map(r => r.z)) - minZ;
  }
  dx = clamp(dx, -minX, GRID_N - 1 - maxX); dy = clamp(dy, -minY, GRID_N - 1 - maxY);
  // areas on the source map that will lose all their rooms (reported, never deleted)
  const before = areasInSpace(c.source).filter(a => rooms.some(r => roomInArea(r, a)));
  for (const r of rooms) { r.x += dx; r.y += dy; r.z += dz; r.space = sp.id; }
  const emptied = before.filter(a => !Object.values(S.map.rooms).some(r => roomInArea(r, a)));

  const land = S.map.rooms[c.seedId] || rooms[0];
  S.capture = null;
  document.getElementById("captureBanner").style.display = "none";
  resizeCanvas();
  setSpace(sp.id, land.z);
  selectSingle(land.id);
  commit(); render(); centerOnRoom(land);
  toast(`Moved <b>${rooms.length} room${rooms.length !== 1 ? "s" : ""}</b> into <b>${escapeHtml(sp.name)}</b> · now on ${escapeHtml(layerName(land.z, sp.id))}.` +
    (emptied.length ? ` Area${emptied.length !== 1 ? "s" : ""} left empty on ${escapeHtml(spaceName(c.source))}: ${emptied.map(a => escapeHtml(a.name)).join(", ")}.` : "") +
    ` Ctrl+Z undoes it.`);
}
