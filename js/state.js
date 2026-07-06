// ---------- Shared mutable state ----------
// ES module bindings are read-only to importers, so every module-level `let` that
// used to be reassigned from anywhere in the old single file lives as a property on
// this one exported object instead. Modules do `S.map = x`, never `import { map }`.
//
// Room: { id, name, description, color, size, x, y, z, exits:{dir:targetId}, exitFly, imageUrl }
//   z = layer (true vertical axis). UP carve => same (x,y), z+1. DOWN => z-1.
export const S = {
  map: null,                // { version:2, rooms:{}, areas:[], currentLayer, tagLabels }
  selectedId: null,
  view: "flat",
  linkMode: false,
  pendingLink: null,        // source room id while picking a cross-layer link target
  pathMode: false,
  pathStart: null,          // start room id while picking a path destination
  areaMode: false,          // drawing/editing zone rectangles
  selectedAreaId: null,     // currently selected area (separate from room selection)
  areaMergeSource: null,    // area id awaiting a merge target (click another area)
  transitMode: false,       // adding/removing stations on the active transit line
  transitActiveLine: null,  // line id that room clicks toggle stations on, while in transit mode
  pathRooms: new Set(),     // rooms on the current shortest-path result (highlighted)
  pathCanFly: true,         // pathfinder may use flight-only exits
  pathLast: null,           // {startId, endId} of the last computed route, for recompute on toggle
  searchTerm: "",
  searchMatches: [],        // ids of rooms matching the search
  searchIdx: -1,            // cursor for "jump to next match"
  selection: new Set(),     // multi-selection; when non-empty, selectedId is the primary member
  scale: 1, panX: 0, panY: 0,
  drag: null,

  // 3D view camera (orbit). dist is perspective focal distance; cx/cy centre the projection.
  cam3d: { yaw: 0.7, pitch: 0.5, dist: 1400, cx: 0, cy: 0, fitted: false },
  drag3d: null,
  proj3dCache: [],          // [{id, sx, sy, r}] for hit-testing after a render

  // undo/redo: snapshots of the whole map (plain JSON-serialisable data)
  history: [],
  histIdx: -1,

  // view-only preferences (persisted separately from the map so they don't bloat exports)
  onion: { below: true, above: false, opacity: 0.30 },

  saveTimer: null,
  pickerCtx: null,          // { fromId, toId } while the direction picker is open
  pendingImport: null,      // parsed map data awaiting a replace/add choice
};

// ---------- DOM ----------
export const viewport = document.getElementById("viewport");
export const world = document.getElementById("world");
export const svg = document.getElementById("svglayer");
export const gridCanvas = document.getElementById("gridcanvas");
export const ctx = gridCanvas.getContext("2d");
export const inspector = document.getElementById("inspector");
export const view3dEl = document.getElementById("canvas3d");
export const ctx3d = view3dEl.getContext("2d");
export const layerLabel = document.getElementById("layerLabel");
export const zoomLabel = document.getElementById("zoomLabel");
export const saveStatus = document.getElementById("saveStatus");
export const dirpicker = document.getElementById("dirpicker");
export const dirGrid = document.getElementById("dirGrid");
