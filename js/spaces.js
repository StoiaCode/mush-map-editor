import { S } from "./state.js";
import { spaceOf } from "./model.js";

// ---------- Spaces (pocket maps) ----------
// See docs/plans/spaces.md. The main map is the implicit space `null`; named spaces live in
// S.map.spaces as { id, name, color }. Which rooms are a space's "doors" is never stored —
// it's derived from exits that cross the space boundary.

export const MAIN_NAME = "Main map";

export function spaceById(id) { return id ? (S.map.spaces.find(sp => sp.id === id) || null) : null; }
export function spaceName(id) { const sp = spaceById(id); return sp ? sp.name : MAIN_NAME; }
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

// Floors are numbered relative to the space's first door (docs/plans/spaces.md, Decisions):
// the room you enter by going UP from outside is Floor +1, by a compass exit Floor 0.
// Returns the z offset to add to a raw layer, or null when there's no door to anchor on.
export function floorOffset(spaceId) {
  if (!spaceId) return null;
  const entering = doorsOf(spaceId).filter(d => d.entering);
  const d = entering[0];
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
