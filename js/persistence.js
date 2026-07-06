import { STORE_KEY, PREFS_KEY, HIST_MAX } from "./constants.js";
import { emptyTagLabels } from "./constants.js";
import { S, saveStatus } from "./state.js";
import { layersPresent } from "./model.js";
import { render } from "./app.js";

// ---------- Persistence ----------
export function defaultMap() { return { version: 2, rooms: {}, areas: [], currentLayer: 0, tagLabels: emptyTagLabels() }; }

export function save() {
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
  if (!Array.isArray(map.areas)) map.areas = [];
  for (const a of map.areas) {
    if (!Array.isArray(a.rects) || !a.rects.length) {
      a.rects = [{ x: a.x || 0, y: a.y || 0, w: a.w || 1, h: a.h || 1 }];  // migrate legacy single-rect areas
    }
    delete a.x; delete a.y; delete a.w; delete a.h;
  }
  for (const r of Object.values(map.rooms)) {
    if (r.z == null) r.z = (r.level != null ? r.level : 0);
    delete r.level;
    if (!r.exits) r.exits = {};
    if (!r.exitFly) r.exitFly = {};   // directions on this room that require flight
    if (r.imageUrl == null) r.imageUrl = "";
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
export function undo() { if (S.histIdx > 0) { S.histIdx--; S.map = JSON.parse(JSON.stringify(S.history[S.histIdx])); afterRestore(); } }
export function redo() { if (S.histIdx < S.history.length - 1) { S.histIdx++; S.map = JSON.parse(JSON.stringify(S.history[S.histIdx])); afterRestore(); } }
function afterRestore() {
  // prune stale selection / transient state, clamp the layer, redraw
  const map = S.map;
  for (const id of [...S.selection]) if (!map.rooms[id]) S.selection.delete(id);
  if (S.selectedId && !map.rooms[S.selectedId]) S.selectedId = null;
  if (!S.selectedId && S.selection.size) S.selectedId = [...S.selection][0];
  if (S.selectedAreaId && !(map.areas || []).some(a => a.id === S.selectedAreaId)) S.selectedAreaId = null;
  const ls = layersPresent();
  if (!ls.includes(map.currentLayer)) map.currentLayer = ls[0];
  S.pendingLink = null;
  const hint = document.getElementById("linkHint");
  if (hint) hint.style.display = "none";
  S.pathStart = null; S.pathRooms = new Set();
  save(); render(); updateUndoButtons();
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
    if (raw) { const p = JSON.parse(raw); if (p.onion) Object.assign(S.onion, p.onion); }
  } catch (e) { /* ignore */ }
}
export function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ onion: S.onion })); } catch (e) { /* ignore */ }
}
