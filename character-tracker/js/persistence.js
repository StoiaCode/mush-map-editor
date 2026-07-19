import { STORE_KEY, HIST_MAX, CATALOG_KINDS } from "./constants.js";
import { S, saveStatus } from "./state.js";
import { render } from "./app.js";
import { createCatalogEntry } from "./model.js";

// ---------- Persistence ----------
export function defaultMap() { return { version: 2, characters: {}, relationships: [], annotations: [], clans: [], sects: [], coteries: [] }; }

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
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { S.map = JSON.parse(raw); normalize(); return; }
  } catch (e) { console.warn(e); }
  S.map = defaultMap();
}

export function normalize() {
  const map = S.map;
  if (!map.characters) map.characters = {};
  if (!Array.isArray(map.relationships)) map.relationships = [];
  if (!Array.isArray(map.annotations)) map.annotations = [];
  for (const kind of CATALOG_KINDS) if (!Array.isArray(map[kind.catalog])) map[kind.catalog] = [];
  for (const ch of Object.values(map.characters)) {
    if (!Array.isArray(ch.imageUrls)) ch.imageUrls = [];
    if (!Array.isArray(ch.tags)) ch.tags = [];
    for (const f of ["description","myRelationship","notableFeatures"]) if (ch[f] == null) ch[f] = "";
    if (ch.color == null) ch.color = "Slate";
    if (typeof ch.x !== "number") ch.x = 0;
    if (typeof ch.y !== "number") ch.y = 0;
    // migrate the old free-text clan/sect/coterie fields into shared catalog
    // entries (find-or-create by name, so characters that already share a
    // typed value converge on one entry instead of duplicating it)
    for (const { kind } of CATALOG_KINDS) {
      const idField = kind + "Id";
      if (ch[idField] === undefined && typeof ch[kind] === "string" && ch[kind].trim()) {
        ch[idField] = createCatalogEntry(kind, ch[kind]);
      }
      if (ch[idField] === undefined) ch[idField] = null;
      delete ch[kind];
    }
  }
  // drop dangling catalog references (entry deleted/missing since the character was saved)
  for (const { kind, catalog } of CATALOG_KINDS) {
    const ids = new Set(map[catalog].map(e => e.id));
    for (const ch of Object.values(map.characters)) if (ch[kind + "Id"] && !ids.has(ch[kind + "Id"])) ch[kind + "Id"] = null;
  }
  const charIds = new Set(Object.keys(map.characters));
  map.relationships = map.relationships.filter(r => r && charIds.has(r.fromId) && charIds.has(r.toId));
  map.annotations = map.annotations.filter(a => a && typeof a.cx === "number");
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
export function undo() { if (S.histIdx > 0) { S.histIdx--; S.map = cloneFrom(S.histIdx); afterRestore(); } }
export function redo() { if (S.histIdx < S.history.length - 1) { S.histIdx++; S.map = cloneFrom(S.histIdx); afterRestore(); } }
function cloneFrom(idx) { return JSON.parse(JSON.stringify(S.history[idx])); }
function afterRestore() {
  const map = S.map;
  if (S.selectedId && !map.characters[S.selectedId]) S.selectedId = null;
  if (S.selectedAnnotationId && !map.annotations.some(a => a.id === S.selectedAnnotationId)) S.selectedAnnotationId = null;
  S.pendingLink = null;
  S.linkMode = false;
  S.circleMode = false;
  S.circleDraft = null;
  save(); render(); updateUndoButtons();
}
export function updateUndoButtons() {
  const u = document.getElementById("undoBtn"), r = document.getElementById("redoBtn");
  if (u) u.disabled = S.histIdx <= 0;
  if (r) r.disabled = S.histIdx >= S.history.length - 1;
}
