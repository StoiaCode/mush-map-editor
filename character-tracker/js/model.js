import { S } from "./state.js";
import { uid } from "./utils.js";

// ---------- Selection ----------
export function selectCharacter(id) { S.selectedId = id || null; S.selectedAnnotationId = null; }
export function selectAnnotation(id) { S.selectedAnnotationId = id || null; S.selectedId = null; }
export function clearSelection() { S.selectedId = null; S.selectedAnnotationId = null; S.fullProfileOpen = false; }

// ---------- Character CRUD ----------
export function createCharacter(x, y, name) {
  const id = uid();
  S.map.characters[id] = {
    id, name: name || "New Character", description: "",
    imageUrls: [], clan: "", sect: "", coterie: "",
    myRelationship: "", notableFeatures: "", tags: [],
    color: "Slate", x, y,
  };
  return S.map.characters[id];
}
export function deleteCharacter(id) {
  delete S.map.characters[id];
  S.map.relationships = S.map.relationships.filter(r => r.fromId !== id && r.toId !== id);
  if (S.selectedId === id) S.selectedId = null;
}
export function addTag(ch, tag) {
  tag = String(tag || "").trim();
  if (!tag || ch.tags.includes(tag)) return;
  ch.tags.push(tag);
}
export function removeTag(ch, tag) { ch.tags = ch.tags.filter(t => t !== tag); }

export function addImageUrl(ch, url) {
  url = String(url || "").trim();
  if (!url) return;
  ch.imageUrls.push(url);
}
export function removeImageUrl(ch, idx) { ch.imageUrls.splice(idx, 1); }
export function moveImageUrl(ch, idx, delta) {
  const j = idx + delta;
  if (j < 0 || j >= ch.imageUrls.length) return;
  [ch.imageUrls[idx], ch.imageUrls[j]] = [ch.imageUrls[j], ch.imageUrls[idx]];
}
export function primaryImage(ch) { return ch.imageUrls && ch.imageUrls[0] || ""; }

// ---------- Relationships (graph edges between characters) ----------
export function relationshipsFor(id) {
  return S.map.relationships.filter(r => r.fromId === id || r.toId === id);
}
export function otherEnd(rel, id) { return rel.fromId === id ? rel.toId : rel.fromId; }
export function createRelationship(fromId, toId, label) {
  if (fromId === toId) return null;
  // one edge per unordered pair — re-label the existing one instead of duplicating
  const existing = S.map.relationships.find(r =>
    (r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId));
  if (existing) { existing.label = label || existing.label; return existing; }
  const rel = { id: uid(), fromId, toId, label: label || "" };
  S.map.relationships.push(rel);
  return rel;
}
export function updateRelationshipLabel(id, label) {
  const r = S.map.relationships.find(x => x.id === id);
  if (r) r.label = label;
}
export function deleteRelationship(id) {
  S.map.relationships = S.map.relationships.filter(r => r.id !== id);
}

// ---------- Freeform grouping circles ----------
export function createAnnotation(x0, y0, x1, y1, name, color) {
  const ann = {
    id: uid(), name: name || "Group", color: color || "Slate",
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    rx: Math.max(40, Math.abs(x1 - x0) / 2), ry: Math.max(40, Math.abs(y1 - y0) / 2),
  };
  S.map.annotations.push(ann);
  return ann;
}
export function deleteAnnotation(id) {
  S.map.annotations = S.map.annotations.filter(a => a.id !== id);
  if (S.selectedAnnotationId === id) S.selectedAnnotationId = null;
}
export function charactersInAnnotation(ann) {
  return Object.values(S.map.characters).filter(ch => {
    const dx = (ch.x - ann.cx) / ann.rx, dy = (ch.y - ann.cy) / ann.ry;
    return dx * dx + dy * dy <= 1;
  });
}

// ---------- Search ----------
export function computeSearchMatches() {
  const term = S.searchTerm.trim().toLowerCase();
  if (!term) { S.searchMatches = []; return; }
  S.searchMatches = Object.values(S.map.characters)
    .filter(ch =>
      ch.name.toLowerCase().includes(term) ||
      ch.clan.toLowerCase().includes(term) ||
      ch.sect.toLowerCase().includes(term) ||
      ch.coterie.toLowerCase().includes(term) ||
      ch.tags.some(t => t.toLowerCase().includes(term)))
    .map(ch => ch.id);
}

// ---------- Grouping (for the Groups view) ----------
export function groupCharacters(field) {
  const groups = new Map();
  for (const ch of Object.values(S.map.characters)) {
    const key = (ch[field] || "").trim() || "(unspecified)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
