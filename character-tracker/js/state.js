// ---------- Shared mutable state ----------
// Same pattern as the map editor: ES module bindings are read-only to importers,
// so every value that needs reassigning from anywhere lives as a property on this
// one exported object. Modules do `S.map = x`, never `import { map }`.
//
// Character: { id, name, description, imageUrls:[], clan, sect, coterie,
//              myRelationship, notableFeatures, tags:[], color, x, y }
// Relationship: { id, fromId, toId, label }
// Annotation (freeform circle grouping): { id, name, color, cx, cy, rx, ry }
export const S = {
  map: null,                 // { version:1, characters:{}, relationships:[], annotations:[] }
  view: "web",                // "web" | "gallery" | "groups"
  groupField: "coterie",       // grouping key for the Groups view

  selectedId: null,            // selected character id
  selectedAnnotationId: null,  // selected freeform-circle id
  fullProfileOpen: false,      // whether the big profile panel is open

  linkMode: false,             // drawing relationship edges between characters
  pendingLink: null,           // source character id while picking a target
  edgePicker: null,            // { edgeId|null, fromId, toId, x, y } — labeling popover

  circleMode: false,           // drawing a freeform grouping circle
  circleDraft: null,           // { x0, y0, x1, y1 } while dragging a new circle

  searchTerm: "",
  searchMatches: [],           // ids of characters matching the search

  scale: 1, panX: 0, panY: 0,
  drag: null,                  // node drag info
  dragAnn: null,                // annotation move/resize info

  history: [],                  // undo/redo: snapshots of the whole map
  histIdx: -1,

  saveTimer: null,
  pendingImport: null,          // parsed data awaiting a replace/add choice
};

// ---------- DOM ----------
export const viewport = document.getElementById("viewport");
export const world = document.getElementById("world");
export const svg = document.getElementById("svglayer");
export const galleryEl = document.getElementById("galleryView");
export const groupsEl = document.getElementById("groupsView");
export const inspector = document.getElementById("inspector");
export const zoomLabel = document.getElementById("zoomLabel");
export const saveStatus = document.getElementById("saveStatus");
export const edgePicker = document.getElementById("edgePicker");
export const fullProfile = document.getElementById("fullProfile");
