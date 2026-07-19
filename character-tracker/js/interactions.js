import { NODE_SIZE, CLICK_THRESH } from "./constants.js";
import { S, viewport, world, svg, edgePicker } from "./state.js";
import { clamp, escapeHtml } from "./utils.js";
import {
  createCharacter, deleteCharacter, selectCharacter, selectAnnotation, clearSelection,
  createAnnotation, deleteAnnotation, createRelationship, updateRelationshipLabel, deleteRelationship,
  impliedRelationship,
} from "./model.js";
import { commit, undo, redo } from "./persistence.js";
import { render } from "./app.js";
import { screenToWorld, zoomAt, renderWeb } from "./render-web.js";
import { closeFullProfile } from "./inspector.js";

function nodeCenter(ch) { return { x: ch.x + NODE_SIZE / 2, y: ch.y + NODE_SIZE / 2 }; }

// ---------- Link mode: pick source, then target ----------
export function setPendingLink(id) {
  S.pendingLink = id;
  const hint = document.getElementById("linkHint");
  if (id) {
    hint.style.display = "";
    hint.textContent = "linking from “" + (S.map.characters[id] ? S.map.characters[id].name : "?") + "” — click another character · Esc cancels";
  } else {
    hint.style.display = "none";
  }
  render();
}

// ---------- Pointer interactions (Web view canvas) ----------
viewport.addEventListener("mousedown", e => {
  if (e.button === 1) {
    S.drag = { type:"pan", x0:e.clientX, y0:e.clientY, px:S.panX, py:S.panY, moved:false };
    viewport.classList.add("panning"); e.preventDefault(); return;
  }
  if (e.button !== 0) return;

  const relHit = e.target.closest(".rel-hit");
  if (relHit) { openEdgePickerForExisting(relHit.dataset.rel, e.clientX, e.clientY); e.stopPropagation(); e.preventDefault(); return; }

  const impliedHit = e.target.closest(".rel-hit-implicit");
  if (impliedHit) { openEdgePickerForNew(impliedHit.dataset.from, impliedHit.dataset.to, e.clientX, e.clientY); e.stopPropagation(); e.preventDefault(); return; }

  const handle = e.target.closest(".ann-resize");
  if (handle) {
    const ann = S.map.annotations.find(a => a.id === handle.dataset.aid);
    if (ann) { selectAnnotation(ann.id); render(); S.dragAnn = { type:"resize", id:ann.id, x0:e.clientX, y0:e.clientY, rx0:ann.rx, ry0:ann.ry }; }
    e.preventDefault(); return;
  }
  const annHit = e.target.closest(".ann-label") || e.target.closest("ellipse[data-aid]");
  if (annHit) {
    const ann = S.map.annotations.find(a => a.id === annHit.dataset.aid);
    if (ann) { selectAnnotation(ann.id); render(); S.dragAnn = { type:"move", id:ann.id, x0:e.clientX, y0:e.clientY, cx0:ann.cx, cy0:ann.cy }; }
    e.preventDefault(); return;
  }

  const nodeEl = e.target.closest(".node");
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (S.linkMode) {
      if (!S.pendingLink) { selectCharacter(id); setPendingLink(id); }
      else if (S.pendingLink !== id) { openEdgePickerForNew(S.pendingLink, id, e.clientX, e.clientY); }
      else { setPendingLink(null); }
      e.stopPropagation(); e.preventDefault(); return;
    }
    selectCharacter(id); render();
    const ch = S.map.characters[id];
    S.drag = { type:"node-move", id, x0:e.clientX, y0:e.clientY, sx:ch.x, sy:ch.y, moved:false };
    e.preventDefault(); return;
  }

  if (S.circleMode) {
    const w = screenToWorld(e.clientX, e.clientY);
    S.drag = { type:"circle-draw", x0:e.clientX, y0:e.clientY };
    S.circleDraft = { x0:w.x, y0:w.y, x1:w.x, y1:w.y };
    renderWeb();
    e.preventDefault(); return;
  }

  S.drag = { type:"pan", x0:e.clientX, y0:e.clientY, px:S.panX, py:S.panY, moved:false };
  viewport.classList.add("panning");
});

window.addEventListener("mousemove", e => {
  if (S.dragAnn) {
    const drag = S.dragAnn;
    const ann = S.map.annotations.find(a => a.id === drag.id);
    if (!ann) { S.dragAnn = null; return; }
    const dx = (e.clientX - drag.x0) / S.scale, dy = (e.clientY - drag.y0) / S.scale;
    if (drag.type === "move") { ann.cx = drag.cx0 + dx; ann.cy = drag.cy0 + dy; }
    else { ann.rx = Math.max(30, drag.rx0 + dx); ann.ry = Math.max(30, drag.ry0 + dy); }
    renderWeb();
    return;
  }
  if (!S.drag) return;
  const drag = S.drag;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (drag.type === "pan") {
    if (Math.abs(dx) > CLICK_THRESH || Math.abs(dy) > CLICK_THRESH) drag.moved = true;
    S.panX = drag.px + dx; S.panY = drag.py + dy;
    world.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.scale})`;
  } else if (drag.type === "node-move") {
    if (Math.abs(dx) > CLICK_THRESH || Math.abs(dy) > CLICK_THRESH) drag.moved = true;
    const ch = S.map.characters[drag.id];
    if (ch) { ch.x = drag.sx + dx / S.scale; ch.y = drag.sy + dy / S.scale; renderWeb(); }
  } else if (drag.type === "circle-draw") {
    const w = screenToWorld(e.clientX, e.clientY);
    S.circleDraft.x1 = w.x; S.circleDraft.y1 = w.y;
    renderWeb();
  }
});

window.addEventListener("mouseup", e => {
  if (S.dragAnn) { S.dragAnn = null; commit(); render(); return; }
  if (!S.drag) return;
  const d = S.drag; S.drag = null; viewport.classList.remove("panning");
  if (d.type === "pan") {
    if (!d.moved) {
      if (S.linkMode) { if (S.pendingLink) setPendingLink(null); return; }
      if (S.selectedId || S.selectedAnnotationId) { clearSelection(); render(); }
    }
    return;
  }
  if (d.type === "node-move") {
    if (d.moved) commit(); else render();
    return;
  }
  if (d.type === "circle-draw") {
    const draft = S.circleDraft; S.circleDraft = null;
    if (draft && (Math.abs(draft.x1 - draft.x0) > 20 || Math.abs(draft.y1 - draft.y0) > 20)) {
      const ann = createAnnotation(draft.x0, draft.y0, draft.x1, draft.y1, "New Group", "Teal");
      selectAnnotation(ann.id);
      commit(); render();
    } else render();
    return;
  }
});

// double-click empty space (Web view) to create a character
viewport.addEventListener("dblclick", e => {
  if (S.view !== "web" || S.linkMode || S.circleMode) return;
  if (e.target.closest(".node") || e.target.closest(".ann-label") || e.target.closest(".ann-resize")) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const ch = createCharacter(w.x - NODE_SIZE / 2, w.y - NODE_SIZE / 2, "New Character");
  selectCharacter(ch.id); closeFullProfile(); commit(); render();
});

viewport.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1/1.12);
}, { passive: false });

// ---------- Edge label popover (create / edit / delete a relationship) ----------
function positionPicker(el, sx, sy) {
  el.style.display = "block";
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = clamp(sx, 0, window.innerWidth - w - 8) + "px";
  el.style.top = clamp(sy, 0, window.innerHeight - h - 8) + "px";
}
function openEdgePickerForNew(fromId, toId, sx, sy) {
  const a = S.map.characters[fromId], b = S.map.characters[toId];
  S.edgePicker = { edgeId:null, fromId, toId };
  // pre-fill with the implicit coterie-bond label, if these two already have one —
  // saving as-is just formalizes it; typing something else overrides it
  const implied = impliedRelationship(fromId, toId);
  edgePicker.innerHTML = `
    <div class="hdr">Relationship: <b>${escapeHtml(a.name)}</b> ↔ <b>${escapeHtml(b.name)}</b></div>
    <input type="text" id="ep_label" value="${escapeHtml(implied ? implied.label : "")}" placeholder="e.g. sire, rival, ally…" style="width:100%;margin-bottom:8px;">
    <div style="display:flex;gap:6px;">
      <button class="primary" id="ep_save" style="flex:1;">Save</button>
      <button id="ep_cancel">Cancel</button>
    </div>`;
  positionPicker(edgePicker, sx, sy);
  document.getElementById("ep_label").focus();
  document.getElementById("ep_save").onclick = () => {
    createRelationship(fromId, toId, document.getElementById("ep_label").value.trim());
    closeEdgePicker(); setPendingLink(null); commit(); render();
  };
  document.getElementById("ep_cancel").onclick = () => { closeEdgePicker(); setPendingLink(null); render(); };
}
function openEdgePickerForExisting(relId, sx, sy) {
  const rel = S.map.relationships.find(r => r.id === relId);
  if (!rel) return;
  const a = S.map.characters[rel.fromId], b = S.map.characters[rel.toId];
  if (!a || !b) return;
  S.edgePicker = { edgeId: relId, fromId: rel.fromId, toId: rel.toId };
  edgePicker.innerHTML = `
    <div class="hdr">Relationship: <b>${escapeHtml(a.name)}</b> ↔ <b>${escapeHtml(b.name)}</b></div>
    <input type="text" id="ep_label" value="${escapeHtml(rel.label)}" style="width:100%;margin-bottom:8px;">
    <div style="display:flex;gap:6px;">
      <button class="primary" id="ep_save" style="flex:1;">Save</button>
      <button class="danger" id="ep_del">Delete</button>
    </div>`;
  positionPicker(edgePicker, sx, sy);
  document.getElementById("ep_label").focus();
  document.getElementById("ep_save").onclick = () => {
    updateRelationshipLabel(relId, document.getElementById("ep_label").value.trim());
    closeEdgePicker(); commit(); render();
  };
  document.getElementById("ep_del").onclick = () => {
    deleteRelationship(relId); closeEdgePicker(); commit(); render();
  };
}
function closeEdgePicker() { edgePicker.style.display = "none"; S.edgePicker = null; }
document.addEventListener("mousedown", e => {
  if (edgePicker.style.display === "block" && !edgePicker.contains(e.target)) closeEdgePicker();
});

// ---------- Keyboard ----------
window.addEventListener("keydown", e => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  if (e.key === "Escape") {
    if (S.pendingLink) setPendingLink(null);
    closeEdgePicker();
    clearSelection(); render(); return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (S.selectedAnnotationId) {
      const ann = S.map.annotations.find(a => a.id === S.selectedAnnotationId);
      if (ann && confirm(`Delete the "${ann.name}" group circle?`)) { deleteAnnotation(ann.id); commit(); render(); }
      e.preventDefault(); return;
    }
    if (S.selectedId) {
      const ch = S.map.characters[S.selectedId];
      if (ch && confirm(`Delete "${ch.name}"?`)) { deleteCharacter(S.selectedId); commit(); render(); }
      e.preventDefault(); return;
    }
  }
});
