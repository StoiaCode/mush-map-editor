import { GRID_N, COMPASS, VEC, OPP, DIRS } from "./constants.js";
import { S } from "./state.js";
import { uid, clamp } from "./utils.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { centerOnRoom } from "./render-flat.js";
import { gotoRoom } from "./inspector.js";

// ---------- Selection ----------
export function selectSingle(id) { S.selection = new Set(id ? [id] : []); S.selectedId = id || null; }
export function toggleSel(id) {
  if (S.selection.has(id)) {
    S.selection.delete(id);
    if (S.selectedId === id) S.selectedId = S.selection.size ? [...S.selection][S.selection.size - 1] : null;
  } else {
    S.selection.add(id);
    S.selectedId = id;
  }
}
export function clearSelection() { S.selection = new Set(); S.selectedId = null; }

// ---------- Layer helpers ----------
export function layersPresent() {
  const zs = [...new Set(Object.values(S.map.rooms).map(r => r.z))];
  if (!zs.length) return [0];
  return zs.sort((a, b) => a - b);
}
export function roomsOnLayer(z) { return Object.values(S.map.rooms).filter(r => r.z === z); }
export function roomAtCell(z, x, y) {
  return Object.values(S.map.rooms).find(r => r.z === z && r.x === x && r.y === y) || null;
}

// ---------- Room operations ----------
export function createRoom(z, x, y, name) {
  const id = uid();
  S.map.rooms[id] = { id, name: name || "New Room", description: "", color: "Slate",
                      size: "medium", x, y, z, exits: {}, exitFly: {}, imageUrl: "" };
  return S.map.rooms[id];
}
export function deleteRoom(id) {
  delete S.map.rooms[id];
  for (const r of Object.values(S.map.rooms))
    for (const d of Object.keys(r.exits))
      if (r.exits[d] === id) delete r.exits[d];
  for (const line of S.map.transitLines) line.stations = line.stations.filter(sid => sid !== id);
  S.selection.delete(id);
  if (S.selectedId === id) S.selectedId = S.selection.size ? [...S.selection][0] : null;
  if (!roomsOnLayer(S.map.currentLayer).length) {
    const ls = layersPresent();
    if (!ls.includes(S.map.currentLayer) && ls.length) S.map.currentLayer = ls[0];
  }
}
// Re-tag a room to a different layer (keeps its grid cell + exits as logical links).
export function changeRoomLayer(r, nz) {
  if (!Number.isFinite(nz)) { render(); return; }   // bad input → just re-sync the field
  nz = Math.round(nz);
  if (nz === r.z) return;
  if (roomAtCell(nz, r.x, r.y)) {
    alert(`A room already occupies cell (${r.x}, ${r.y}) on layer ${nz}. Move one of them first.`);
    render();   // reset the input back to the current value
    return;
  }
  r.z = nz;
  S.map.currentLayer = nz;       // follow the room to its new layer
  commit(); render();
  if (S.view === "flat") centerOnRoom(r);
}
export function deleteArea(id) { S.map.areas = S.map.areas.filter(a => a.id !== id); if (S.selectedAreaId === id) S.selectedAreaId = null; }
export function addExit(fromId, dir, toId) {
  const from = S.map.rooms[fromId], to = S.map.rooms[toId];
  if (!from || !to) return { ok:false, msg:"no source/target" };
  const opp = OPP[dir];
  // Hard rule: at most one UP and one DOWN per room — guard both ends.
  if (dir === "UP" || dir === "DOWN") {
    if (from.exits[dir] && from.exits[dir] !== toId)
      return { ok:false, msg:`This room already has a ${dir} exit. Each room may have at most one — remove the existing one first.` };
    if (to.exits[opp] && to.exits[opp] !== fromId)
      return { ok:false, msg:`The target already has a ${opp} exit (only one allowed). Remove it first.` };
  }
  // Connections are bidirectional: write the exit and its reciprocal.
  from.exits[dir] = toId;
  to.exits[opp] = fromId;
  return { ok:true };
}

// Mark/unmark an exit (and its reciprocal, if any) as flight-only.
export function setExitFly(roomId, dir, fly) {
  const r = S.map.rooms[roomId];
  if (!r || !r.exits[dir]) return;
  if (!r.exitFly) r.exitFly = {};
  if (fly) r.exitFly[dir] = true; else delete r.exitFly[dir];
  const t = S.map.rooms[r.exits[dir]];
  if (t) {
    if (!t.exitFly) t.exitFly = {};
    for (const d of DIRS) if (t.exits[d] === roomId) { if (fly) t.exitFly[d] = true; else delete t.exitFly[d]; }
  }
}

// Carve: works for all 10 directions.
//  compass -> same layer, neighbouring cell.
//  UP/DOWN -> same (x,y), layer above/below. Behaves exactly like a compass carve, on z.
export function carve(fromId, dir) {
  const from = S.map.rooms[fromId];
  if (!from) return;

  if (dir === "UP" || dir === "DOWN") {
    if (from.exits[dir]) { gotoRoom(from.exits[dir]); return; } // already linked: just travel
    const nz = from.z + (dir === "UP" ? 1 : -1);
    let target = roomAtCell(nz, from.x, from.y);
    if (!target) target = createRoom(nz, from.x, from.y, "New Room");
    from.exits[dir] = target.id;
    target.exits[OPP[dir]] = from.id;
    selectSingle(target.id);
    S.map.currentLayer = nz;          // follow the carve up/down
    commit(); render(); centerOnRoom(target);
    return;
  }

  if (!COMPASS.includes(dir)) return;
  const [dx, dy] = VEC[dir];
  const nx = clamp(from.x + dx, 0, GRID_N - 1);
  const ny = clamp(from.y + dy, 0, GRID_N - 1);
  let target = roomAtCell(from.z, nx, ny);
  if (!target) target = createRoom(from.z, nx, ny, "New Room");
  from.exits[dir] = target.id;
  target.exits[OPP[dir]] = from.id;
  selectSingle(target.id);
  commit(); render();
}
// ---------- Area helpers ----------
export function cellInRect(cx, cy, rc) { return cx >= rc.x && cx < rc.x + rc.w && cy >= rc.y && cy < rc.y + rc.h; }
export function roomInArea(r, ar) { return ar.rects.some(rc => cellInRect(r.x, r.y, rc)); }
export function roomsInArea(ar) { return Object.values(S.map.rooms).filter(r => roomInArea(r, ar)).length; }
export function areaCells(ar) {
  const s = new Set();
  for (const rc of ar.rects) for (let x = rc.x; x < rc.x + rc.w; x++) for (let y = rc.y; y < rc.y + rc.h; y++) s.add(x + ":" + y);
  return s;
}
export function areaBounds(ar) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rc of ar.rects) { minX = Math.min(minX, rc.x); minY = Math.min(minY, rc.y); maxX = Math.max(maxX, rc.x + rc.w); maxY = Math.max(maxY, rc.y + rc.h); }
  return { minX, minY, maxX, maxY };
}
export function areaLabelAnchor(ar) {
  // occupied cell with smallest y then x, so the label sits on the shape (not an empty L-corner)
  let best = null;
  for (const rc of ar.rects) {
    const c = { x: rc.x, y: rc.y };
    if (!best || c.y < best.y || (c.y === best.y && c.x < best.x)) best = c;
  }
  return best || { x: 0, y: 0 };
}
export function areaAtCell(cx, cy) { return S.map.areas.find(a => a.rects.some(rc => cellInRect(cx, cy, rc))) || null; }
export function mergeAreas(intoId, otherId) {
  const into = S.map.areas.find(a => a.id === intoId), other = S.map.areas.find(a => a.id === otherId);
  if (!into || !other || into === other) return;
  into.rects = into.rects.concat(other.rects.map(rc => ({ ...rc })));
  S.map.areas = S.map.areas.filter(a => a.id !== otherId);
  S.selectedAreaId = intoId;
}
export function splitArea(id) {
  const a = S.map.areas.find(x => x.id === id);
  if (!a || a.rects.length < 2) return;
  S.map.areas = S.map.areas.filter(x => x.id !== id);
  a.rects.forEach((rc, i) => S.map.areas.push({ id: uid(), name: a.name + (i ? " " + (i + 1) : ""), color: a.color, rects: [{ ...rc }] }));
  S.selectedAreaId = null;
}

// ---------- Transit lines ----------
// A room is a "station" purely by appearing in some line's `stations` array — nothing
// is stored on the room itself, so a station can belong to any number of lines.
// Stations are stored in physical route order (for stop-numbering display); lines are
// back-and-forth (not terminating), so every station on a line reaches every other —
// pathfinding treats this as all-pairs reachable, never as "adjacent stops only".
export function stationLinesFor(roomId) {
  return S.map.transitLines.filter(line => line.stations.includes(roomId));
}
export function createTransitLine(name, color) {
  const line = { id: uid(), name: name || "New Line", color: color || "Teal", stations: [] };
  S.map.transitLines.push(line);
  return line;
}
export function deleteTransitLine(id) {
  S.map.transitLines = S.map.transitLines.filter(l => l.id !== id);
  if (S.transitActiveLine === id) S.transitActiveLine = null;
}
// Add the room to the line if absent, or remove it (closing the gap) if already present.
export function toggleStation(lineId, roomId) {
  const line = S.map.transitLines.find(l => l.id === lineId);
  if (!line) return;
  const i = line.stations.indexOf(roomId);
  if (i === -1) line.stations.push(roomId);
  else line.stations.splice(i, 1);
}
// Swap a station with its neighbour (delta = -1 or +1) to reorder the route.
export function moveStation(lineId, roomId, delta) {
  const line = S.map.transitLines.find(l => l.id === lineId);
  if (!line) return;
  const i = line.stations.indexOf(roomId);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= line.stations.length) return;
  [line.stations[i], line.stations[j]] = [line.stations[j], line.stations[i]];
}
// True if some line contains both rooms — the pathfinder's "one board-and-ride step" test.
export function lineConnects(roomAId, roomBId) {
  return S.map.transitLines.some(l => l.stations.includes(roomAId) && l.stations.includes(roomBId));
}
