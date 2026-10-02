import { STORE_KEY, PREFS_KEY, HIST_MAX } from "./constants.js";
import { emptyTagLabels } from "./constants.js";
import { S, saveStatus } from "./state.js";
import { layersPresent } from "./model.js";
import { render } from "./app.js";
import { announceLocation } from "./spaces.js";

// ---------- Persistence ----------
export function defaultMap() { return { version: 3, rooms: {}, areas: [], spaces: [], transitLines: [], traits: [], currentSpace: null, currentLayer: 0, tagLabels: emptyTagLabels() }; }

export function save() {
  if (S.previewMode) return;   // sandboxed preview map must never touch the real save slot
  if (S.saveTimer) clearTimeout(S.saveTimer);
  saveStatus.textContent = "saving…";
  S.saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S.map));
      saveStatus.textContent = "saved " + new Date().toLocaleTimeString();
    } catch (e) { saveStatus.textContent = "save failed!"; }
  }, 350);
}

export function load() {
  // try v2, then migrate v1
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { S.map = JSON.parse(raw); normalize(); return; }
  } catch (e) { console.warn(e); }
  try {
    const old = localStorage.getItem("mushMapEditor.v1");
    if (old) {
      const o = JSON.parse(old);
      S.map = { version: 2, rooms: o.rooms || {}, currentLayer: 0 };
      // v1 used `level` as a tag — treat it as the layer so existing work isn't lost
      for (const r of Object.values(S.map.rooms)) {
        if (r.z == null) r.z = (r.level != null ? r.level : 0);
        delete r.level;
      }
      normalize();
      return;
    }
  } catch (e) { console.warn(e); }
  S.map = defaultMap();
}

export function normalize() {
  const map = S.map;
  if (!map.rooms) map.rooms = {};
  // spaces (v3): drop malformed entries, then point every room/area at a space that exists
  // (anything else falls back to the main map) and make sure we're viewing a real one
  if (!Array.isArray(map.spaces)) map.spaces = [];
  map.spaces = map.spaces.filter(sp => sp && typeof sp.id === "string");
  for (const sp of map.spaces) {
    if (typeof sp.name !== "string" || !sp.name.trim()) sp.name = "Unnamed space";
    if (typeof sp.color !== "string") sp.color = "Purple";
  }
  const spaceIds = new Set(map.spaces.map(sp => sp.id));
  const fixSpace = o => { o.space = (o.space && spaceIds.has(o.space)) ? o.space : null; };
  if (!spaceIds.has(map.currentSpace)) map.currentSpace = null;
  map.version = 3;
  if (!Array.isArray(map.areas)) map.areas = [];
  for (const a of map.areas) {
    if (!Array.isArray(a.rects) || !a.rects.length) {
      a.rects = [{ x: a.x || 0, y: a.y || 0, w: a.w || 1, h: a.h || 1 }];  // migrate legacy single-rect areas
    }
    delete a.x; delete a.y; delete a.w; delete a.h;
    fixSpace(a);
  }
  if (!Array.isArray(map.transitLines)) map.transitLines = [];
  for (const line of map.transitLines) {
    if (!Array.isArray(line.stations)) line.stations = [];
    if (typeof line.loop !== "boolean") line.loop = false;
    delete line.forwardLabel; delete line.backwardLabel;   // superseded by per-stop dual bindings
    line.stations = line.stations.map(e => {
      if (typeof e === "string") return map.rooms[e] ? e : null;
      if (e && e.dual) {
        const a = map.rooms[e.a] ? e.a : null, b = map.rooms[e.b] ? e.b : null;
        if (a && b) return e;
        if (a || b) return a || b;   // one side is gone — collapse back to a single station
        return null;
      }
      return (e && typeof e.name === "string") ? e : null;   // stub: keep if well-formed
    }).filter(Boolean);
  }
  // drop malformed trait definitions (missing id/emoji/label), then filter every room's
  // assigned trait ids down to ones that still exist in the catalog
  if (!Array.isArray(map.traits)) map.traits = [];
  map.traits = map.traits.filter(t => t && typeof t.id === "string" && typeof t.emoji === "string" && typeof t.label === "string");
  const traitIds = new Set(map.traits.map(t => t.id));
  for (const r of Object.values(map.rooms)) {
    if (r.z == null) r.z = (r.level != null ? r.level : 0);
    delete r.level;
    fixSpace(r);
    if (!r.exits) r.exits = {};
    if (!r.exitFly) r.exitFly = {};   // directions on this room that require flight
    if (r.imageUrl == null) r.imageUrl = "";
    if (!Array.isArray(r.traits)) r.traits = [];
    r.traits = r.traits.filter(id => traitIds.has(id));
  }
  if (map.currentLayer == null) map.currentLayer = layersPresent()[0];
  // backfill tag labels (older saves / imports won't have them)
  const labels = emptyTagLabels();
  if (map.tagLabels) for (const k of Object.keys(labels)) if (map.tagLabels[k]) labels[k] = map.tagLabels[k];
  map.tagLabels = labels;
}

// ---------- Undo / redo ----------
export function cloneMap() { return JSON.parse(JSON.stringify(S.map)); }
export function resetHistory() { S.history = [cloneMap()]; S.histIdx = 0; updateUndoButtons(); }
export function commit() {
  S.history = S.history.slice(0, S.histIdx + 1);
  S.history.push(cloneMap());
  if (S.history.length > HIST_MAX) S.history.shift();
  S.histIdx = S.history.length - 1;
  save();
  updateUndoButtons();
}
// Each snapshot also records the space/layer being viewed when it was committed, i.e. where that
// edit happened. Undo restores the previous map but shows you the space of the edit it took back
// (otherwise undoing a change made inside a pocket space would happen somewhere off-screen).
export function undo() {
  if (S.histIdx <= 0 || S.capture) return;
  const was = S.map.currentSpace || null, undone = S.history[S.histIdx];
  S.histIdx--; S.map = JSON.parse(JSON.stringify(S.history[S.histIdx]));
  S.map.currentSpace = undone.currentSpace || null; S.map.currentLayer = undone.currentLayer;
  afterRestore(was, "Undid a change in");
}
export function redo() {
  if (S.histIdx >= S.history.length - 1 || S.capture) return;
  const was = S.map.currentSpace || null;
  S.histIdx++; S.map = JSON.parse(JSON.stringify(S.history[S.histIdx]));
  afterRestore(was, "Redid a change in");
}
function afterRestore(wasSpace, verb) {
  // prune stale selection / transient state, clamp the layer, redraw
  const map = S.map;
  for (const id of [...S.selection]) if (!map.rooms[id]) S.selection.delete(id);
  if (S.selectedId && !map.rooms[S.selectedId]) S.selectedId = null;
  if (!S.selectedId && S.selection.size) S.selectedId = [...S.selection][0];
  if (S.selectedAreaId && !(map.areas || []).some(a => a.id === S.selectedAreaId)) S.selectedAreaId = null;
  if (map.currentSpace && !(map.spaces || []).some(sp => sp.id === map.currentSpace)) map.currentSpace = null;
  // the restored snapshot may be viewing a different space: never keep a selection you can't see
  for (const id of [...S.selection]) if ((map.rooms[id].space || null) !== map.currentSpace) S.selection.delete(id);
  if (S.selectedId && (map.rooms[S.selectedId].space || null) !== map.currentSpace) S.selectedId = S.selection.size ? [...S.selection][0] : null;
  const ls = layersPresent();
  if (!ls.includes(map.currentLayer)) map.currentLayer = ls[0];
  S.pendingLink = null;
  const hint = document.getElementById("linkHint");
  if (hint) hint.style.display = "none";
  S.pathStart = null; S.pathRooms = new Set();
  save(); render(); updateUndoButtons();
  // an undo/redo that lands in a different space must say so, or the map seems to jump at random
  if ((map.currentSpace || null) !== wasSpace) { S.cam3d.fitted = false; announceLocation(verb); }
}
export function updateUndoButtons() {
  const u = document.getElementById("undoBtn"), r = document.getElementById("redoBtn");
  if (u) u.disabled = S.histIdx <= 0;
  if (r) r.disabled = S.histIdx >= S.history.length - 1;
}

// ---------- View preferences ----------
export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p.onion) Object.assign(S.onion, p.onion);
      if (typeof p.inspectorCollapsed === "boolean") S.inspectorCollapsed = p.inspectorCollapsed;
    }
  } catch (e) { /* ignore */ }
}
export function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ onion: S.onion, inspectorCollapsed: S.inspectorCollapsed })); } catch (e) { /* ignore */ }
}
