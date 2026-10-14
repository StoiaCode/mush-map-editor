import { CELL, SIZE_PX } from "./constants.js";
import { S, world } from "./state.js";
import { escapeHtml, clamp } from "./utils.js";
import { roomAtCell, curSpace, selectSingle, createRoom } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";

// ---------- Ghost tiles (auto-map, live.js) ----------
// Rooms the game's mini-map names around you that aren't on your map yet. Deliberately NOT map
// data: they live in this browser only, never in exports, sync or undo, so throwing them away can't
// touch anything real. A ghost shows only while its cell is empty; once a real room is there
// (walked into, or made real) it's dropped. Dismissed ghosts stay dismissed until reset.

const GHOST_KEY = "mushMapEditor.ghosts.v1";
const G = { ghosts: {}, dismissed: {} };   // key -> {space, z, x, y, name}; key -> true
const keyOf = (space, z, x, y, name) => `${space || ""}|${z}|${x}|${y}|${name}`;

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(GHOST_KEY) || "{}");
    if (o.ghosts && typeof o.ghosts === "object") G.ghosts = o.ghosts;
    if (o.dismissed && typeof o.dismissed === "object") G.dismissed = o.dismissed;
  } catch (e) { /* no storage: ghosts just don't survive a reload */ }
}
function save() {
  try { localStorage.setItem(GHOST_KEY, JSON.stringify(G)); } catch (e) { /* ignore */ }
}
load();

// cells that got a real room since: the ghost has done its job
function prune() {
  let changed = false;
  for (const [k, g] of Object.entries(G.ghosts)) {
    if (roomAtCell(g.z, g.x, g.y, g.space)) { delete G.ghosts[k]; changed = true; }
  }
  if (changed) save();
}

export function ghostCount() { prune(); return Object.keys(G.ghosts).length; }
export function dismissedCount() { return Object.keys(G.dismissed).length; }

// Returns true when anything new appeared, so the caller knows to redraw.
export function addGhosts(list) {
  let added = false;
  for (const g of list) {
    if (!g.name || roomAtCell(g.z, g.x, g.y, g.space)) continue;
    const k = keyOf(g.space, g.z, g.x, g.y, g.name);
    if (G.dismissed[k] || G.ghosts[k]) continue;
    // one ghost per cell: a newer name for the same cell replaces the old one
    for (const [ok, og] of Object.entries(G.ghosts))
      if (og.z === g.z && og.x === g.x && og.y === g.y && (og.space || null) === (g.space || null)) delete G.ghosts[ok];
    G.ghosts[k] = { space: g.space || null, z: g.z, x: g.x, y: g.y, name: g.name };
    added = true;
  }
  if (added) save();
  return added;
}
export function clearGhosts() { G.ghosts = {}; save(); render(); }
export function resetDismissed() { G.dismissed = {}; save(); }

function dismiss(k) { delete G.ghosts[k]; G.dismissed[k] = true; save(); render(); }
// A real room with just the name, marked auto-created (unverified) like auto-map's own rooms.
function makeReal(k) {
  const g = G.ghosts[k];
  if (!g || roomAtCell(g.z, g.x, g.y, g.space)) return;
  const r = createRoom(g.z, g.x, g.y, g.name, g.space);
  r.auto = true; r.autoAt = Date.now();
  delete G.ghosts[k]; save();
  selectSingle(r.id);
  commit(); render();
}

// ---------- Drawing (called from renderFlat) ----------
export function drawGhosts(z) {
  const space = curSpace();
  for (const [k, g] of Object.entries(G.ghosts)) {
    if (g.z !== z || (g.space || null) !== space || roomAtCell(g.z, g.x, g.y, g.space)) continue;
    const el = document.createElement("div");
    el.className = "ghosttile";
    el.dataset.ghost = k;
    const px = SIZE_PX.medium;
    el.style.left = (g.x * CELL + CELL / 2) + "px";
    el.style.top = (g.y * CELL + CELL / 2) + "px";
    el.style.width = px + "px"; el.style.height = px + "px";
    el.title = g.name + " · seen on the game's mini-map, not visited yet. Click for options.";
    el.innerHTML = `<span>${escapeHtml(g.name)}</span>`;
    // keep the map's own pan/click/double-click handlers out of it
    el.addEventListener("mousedown", e => e.stopPropagation());
    el.addEventListener("dblclick", e => e.stopPropagation());
    el.addEventListener("click", e => { e.stopPropagation(); openMenu(k, e.clientX, e.clientY); });
    world.appendChild(el);
  }
}

// ---------- Click menu ----------
let menu = null;
function closeMenu() { if (menu) { menu.remove(); menu = null; } }
function openMenu(k, x, y) {
  closeMenu();
  const g = G.ghosts[k];
  if (!g) return;
  menu = document.createElement("div");
  menu.id = "ghostMenu";
  menu.innerHTML = `<div class="gm-name">${escapeHtml(g.name)}</div>
    <div class="gm-sub">Seen on the game's mini-map</div>
    <button data-act="real">＋ Make real room</button>
    <button data-act="dismiss">✕ Dismiss</button>`;
  document.body.appendChild(menu);
  menu.style.left = clamp(x, 8, window.innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = clamp(y + 8, 8, window.innerHeight - menu.offsetHeight - 8) + "px";
  menu.addEventListener("mousedown", e => e.stopPropagation());
  menu.querySelector('[data-act="real"]').onclick = () => { closeMenu(); makeReal(k); };
  menu.querySelector('[data-act="dismiss"]').onclick = () => { closeMenu(); dismiss(k); };
}
document.addEventListener("mousedown", closeMenu);
window.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
