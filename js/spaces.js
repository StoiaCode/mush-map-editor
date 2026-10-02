import { S } from "./state.js";
import { spaceOf, curSpace, layersPresent, clearSelection } from "./model.js";
import { escapeHtml, areaHex } from "./utils.js";
import { render, fitInitial } from "./app.js";
import { gotoRoom } from "./inspector.js";
import { save } from "./persistence.js";

// ---------- Spaces (pocket maps) ----------
// See docs/plans/spaces.md. The main map is the implicit space `null`; named spaces live in
// S.map.spaces as { id, name, color }. Which rooms are a space's "doors" is never stored —
// it's derived from exits that cross the space boundary.

export const MAIN_NAME = "Main map";
const MAIN_COLOR = "#8a93a3";

export function spaceById(id) { return id ? (S.map.spaces.find(sp => sp.id === id) || null) : null; }
export function spaceName(id) { const sp = spaceById(id); return sp ? sp.name : MAIN_NAME; }
export function spaceColor(id) { const sp = spaceById(id); return sp ? areaHex(sp) : MAIN_COLOR; }
export function roomsInSpace(id) { return Object.values(S.map.rooms).filter(r => spaceOf(r) === (id || null)); }
// Short "where is this room" label, e.g. "Highrise Apts · Floor +1" or "Main map · Layer 0".
export function roomLocation(r) { return spaceName(spaceOf(r)) + " · " + layerName(r.z, spaceOf(r)); }

// Every exit with exactly one end inside `spaceId`, as { outside, inside, dir, entering }.
// `dir` is the direction as written on the `from` room: entering = outside→inside.
// Sorted by outside room id, then direction, so "the first door" is stable.
export function doorsOf(spaceId) {
  const doors = [];
  for (const r of Object.values(S.map.rooms)) {
    for (const [dir, tid] of Object.entries(r.exits)) {
      const t = S.map.rooms[tid];
      if (!t) continue;
      const rIn = spaceOf(r) === spaceId, tIn = spaceOf(t) === spaceId;
      if (rIn === tIn) continue;
      doors.push(rIn ? { outside: t, inside: r, dir, entering: false }
                     : { outside: r, inside: t, dir, entering: true });
    }
  }
  doors.sort((a, b) => a.outside.id < b.outside.id ? -1 : a.outside.id > b.outside.id ? 1
                     : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
  return doors;
}
// This room's exits that lead into a different space, as [{ dir, target }].
export function crossExits(r) {
  const out = [];
  for (const [dir, tid] of Object.entries(r.exits)) {
    const t = S.map.rooms[tid];
    if (t && spaceOf(t) !== spaceOf(r)) out.push({ dir, target: t });
  }
  return out;
}

// Floors are numbered relative to the space's first door (docs/plans/spaces.md, Decisions):
// the room you enter by going UP from outside is Floor +1, by a compass exit Floor 0.
// Doors from the main map count first, so linking a neighbouring space later can't renumber a
// building that hangs off the street. Returns the z offset to add to a raw layer, or null when
// there's no door to anchor on.
export function floorOffset(spaceId) {
  if (!spaceId) return null;
  const entering = doorsOf(spaceId).filter(d => d.entering);
  const d = entering.find(d => !spaceOf(d.outside)) || entering[0];
  if (!d) return null;
  const dz = d.dir === "UP" ? 1 : d.dir === "DOWN" ? -1 : 0;
  return dz - d.inside.z;
}
export function layerName(z, spaceId) {
  const off = floorOffset(spaceId);
  if (off === null) return "Layer " + z;
  const f = z + off;
  return "Floor " + (f > 0 ? "+" + f : f);
}
// Compact form for stubs and exit lists: "L2" on the main map, "F+1" inside a floored space.
export function shortLayerName(z, spaceId) {
  const off = floorOffset(spaceId);
  if (off === null) return "L" + z;
  const f = z + off;
  return "F" + (f > 0 ? "+" + f : f);
}

// ---------- Changing space ----------
// The ONE way the viewed space changes, so no code path can switch silently: it clears the
// selection (a selection never spans spaces), drops area-edit state, refits the 3D camera and
// announces the new location. Callers render afterwards.
export function setSpace(id, layer) {
  id = id || null;
  if (S.capture && id !== S.capture.source) {
    toast("Finish or cancel the move into a space first.");
    return false;
  }
  const changed = id !== curSpace();
  S.map.currentSpace = id;
  if (layer != null) S.map.currentLayer = layer;
  else if (changed) S.map.currentLayer = layersPresent(id)[0];
  save();   // remember which space/layer you were viewing across reloads, like setLayer does
  if (!changed) return true;
  clearSelection();
  S.selectedAreaId = null; S.areaMergeSource = null;
  S.cam3d.fitted = false;
  announceLocation();
  return true;
}
export function announceLocation(verb = "Now in") {
  const sp = curSpace();
  toast(`<span class="tdot" style="background:${spaceColor(sp)}"></span>${escapeHtml(verb)} <b>${escapeHtml(spaceName(sp))}</b> · ${escapeHtml(layerName(S.map.currentLayer, sp))}`);
}

let toastTimer = null;
export function toast(html) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.innerHTML = html;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

// ---------- Location chrome (breadcrumb, frame, corner tag) ----------
// Called from every render(). Main map: plain crumb, no frame. Inside a space: the crumb gains
// the space name, the map gets a frame in the space's colour, and a tag pins the name top-left.
export function updateLocationUI() {
  const sp = curSpace();
  const crumb = document.getElementById("spaceCrumb");
  const tag = document.getElementById("spaceTag");
  const app = document.getElementById("app");
  const c = spaceColor(sp);
  app.classList.toggle("in-space", !!sp);
  app.style.setProperty("--space-color", c);
  if (!sp) {
    crumb.innerHTML = `<span class="crumb here">🗺 ${MAIN_NAME}</span>`;
    tag.style.display = "none";
    return;
  }
  const name = escapeHtml(spaceName(sp));
  crumb.innerHTML = `<button class="crumb link" data-leave-space title="Back to the main map, at this space's door">🗺 ${MAIN_NAME}</button>` +
    `<span class="crumbsep">›</span><span class="crumb here" style="color:${c}">⧉ ${name}</span>`;
  tag.style.display = "";
  tag.innerHTML = `<span class="tagname">⧉ ${name}</span><span class="taglayer">${escapeHtml(layerName(S.map.currentLayer, sp))}</span>` +
    `<button data-leave-space title="Back to the main map, at this space's door">↩ ${MAIN_NAME}</button>`;
}

// ---------- Deleting rooms ----------
// Every room delete goes through this so the dialog always says WHERE the rooms are, and warns
// when the delete would remove the last door into a space (its rooms survive, but orphaned).
export function confirmDeleteRooms(ids) {
  const gone = new Set(ids);
  const rooms = ids.map(id => S.map.rooms[id]).filter(Boolean);
  if (!rooms.length) return false;
  let msg;
  if (rooms.length === 1) {
    msg = `Delete "${rooms[0].name}" (in ${roomLocation(rooms[0])})?\nExits referencing it will be removed. The cell is left empty.`;
  } else {
    const where = [...new Set(rooms.map(r => spaceName(spaceOf(r))))].join(", ");
    msg = `Delete ${rooms.length} selected rooms (in ${where})?`;
  }
  for (const sp of S.map.spaces) {
    const doors = doorsOf(sp.id);
    if (!doors.length) continue;
    const left = roomsInSpace(sp.id).filter(r => !gone.has(r.id)).length;
    if (left && doors.every(d => gone.has(d.outside.id) || gone.has(d.inside.id))) {
      msg += `\n\n⚠ This removes the last door into "${sp.name}" (${left} room${left !== 1 ? "s" : ""}). ` +
             `Those rooms will NOT be deleted; the space will show as orphaned in the ⧉ Spaces panel.`;
    }
  }
  return confirm(msg);
}

// Back to the main map via the crumb / corner tag: land on the room this space is entered
// from (selected and centred) so you come out where you'd expect, not at some random spot.
export function leaveSpace() {
  const sp = curSpace();
  if (!sp) return;
  const d = doorsOf(sp).find(d => d.entering && !spaceOf(d.outside));
  if (d) { gotoRoom(d.outside.id); return; }
  setSpace(null);
  render(); fitInitial();
}
