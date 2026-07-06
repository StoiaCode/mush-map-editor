import { CELL, GRID_N, KEYCARVE } from "./constants.js";
import { S, viewport, world, svg, dirpicker, dirGrid } from "./state.js";
import { clamp, escapeHtml, uid } from "./utils.js";
import {
  roomAtCell, createRoom, areaAtCell, mergeAreas, selectSingle, toggleSel,
  clearSelection, deleteRoom, carve, addExit, deleteArea
} from "./model.js";
import { commit, undo, redo } from "./persistence.js";
import { render } from "./app.js";
import { screenToWorld, roomWorldCenter, zoomAt, applyTransform, renderFlat } from "./render-flat.js";
import { gotoRoom } from "./inspector.js";
import { clearPath, setPathHint, computePath } from "./search-path.js";

// ---------- Pointer interactions ----------
const CLICK_THRESH = 4;
export function setPending(id) {
  S.pendingLink = id;
  const hint = document.getElementById("linkHint");
  if (id) {
    hint.style.display = "";
    hint.textContent = "linking from “" + (S.map.rooms[id] ? S.map.rooms[id].name : "?") + "” — change layers if needed, click the target · Esc cancels";
  } else {
    hint.style.display = "none";
  }
  render();
}
viewport.addEventListener("mousedown", e => {
  // Middle-mouse drag pans in any mode (incl. area / link / path).
  if (e.button === 1) {
    S.drag = { type:"pan", x0:e.clientX, y0:e.clientY, px:S.panX, py:S.panY, moved:false };
    viewport.classList.add("panning"); e.preventDefault(); return;
  }
  if (e.button !== 0) return;
  // Area mode: draw / move / resize zone rectangles (rooms are click-through here)
  if (S.areaMode) {
    const handle = e.target.closest(".area-resize");
    const w = screenToWorld(e.clientX, e.clientY);
    const cx = Math.floor(w.x / CELL), cy = Math.floor(w.y / CELL);
    const hit = areaAtCell(cx, cy);
    if (S.areaMergeSource) {
      // merge pick: click a different area to absorb it; empty/self cancels
      if (hit && hit.id !== S.areaMergeSource) { mergeAreas(S.areaMergeSource, hit.id); S.areaMergeSource = null; commit(); render(); }
      else { S.areaMergeSource = null; render(); }
      e.preventDefault(); return;
    }
    if (handle) {
      const ar = S.map.areas.find(a => a.id === handle.dataset.aid);
      S.selectedAreaId = ar.id; render();
      S.drag = { type:"area-resize", aid: ar.id, x0:e.clientX, y0:e.clientY, sw: ar.rects[0].w, sh: ar.rects[0].h };
    } else if (hit) {
      S.selectedAreaId = hit.id; clearSelection(); render();
      S.drag = { type:"area-move", aid: hit.id, x0:e.clientX, y0:e.clientY, rects0: hit.rects.map(rc => ({ ...rc })) };
    } else {
      S.drag = { type:"area-draw", x0:e.clientX, y0:e.clientY };
      const m = document.getElementById("marquee");
      m.classList.add("areadraw"); m.classList.remove("all");
      m.style.display = "block"; m.style.left = e.clientX + "px"; m.style.top = e.clientY + "px";
      m.style.width = "0px"; m.style.height = "0px";
    }
    e.preventDefault(); return;
  }
  const roomEl = e.target.closest(".room:not(.ghost)");
  const badge = e.target.closest(".vbadge");
  if (badge && roomEl) return; // handled on click
  if (roomEl) {
    const id = roomEl.dataset.id;
    // Shift-drag = quick same-layer link (drag a line to a target)
    if (e.shiftKey) {
      selectSingle(id); render();
      S.drag = { type:"link", fromId:id, ghost: makeGhostLine(), x0:e.clientX, y0:e.clientY };
      e.preventDefault(); return;
    }
    // Ctrl/Cmd-click = toggle this room in the multi-selection (no drag)
    if (e.ctrlKey || e.metaKey) {
      toggleSel(id); render();
      e.preventDefault(); return;
    }
    // Link mode = click source, (switch layers), click target — works across layers/gaps
    if (S.linkMode) {
      if (!S.pendingLink) { selectSingle(id); setPending(id); }
      else if (S.pendingLink !== id) { openDirPicker(S.pendingLink, id, e.clientX, e.clientY); }
      else { setPending(null); }   // clicked the source again → cancel
      // stop this click bubbling to the document "click-outside-to-close" guard,
      // which would otherwise immediately close the picker we just opened.
      e.stopPropagation(); e.preventDefault(); return;
    }
    // Path mode = click start, then destination → shortest route
    if (S.pathMode) {
      if (!S.pathStart) { selectSingle(id); S.pathStart = id; S.pathRooms = new Set(); setPathHint(); render(); }
      else if (S.pathStart !== id) { computePath(S.pathStart, id); S.pathStart = null; }
      else { S.pathStart = null; setPathHint(); render(); }
      e.preventDefault(); return;
    }
    // Plain click: if part of a multi-selection, drag the whole group; else single-select.
    if (!S.selection.has(id)) selectSingle(id);
    render();
    const ids = (S.selection.size > 1 && S.selection.has(id)) ? [...S.selection] : [id];
    const starts = {};
    for (const i of ids) starts[i] = { x: S.map.rooms[i].x, y: S.map.rooms[i].y };
    S.drag = { type:"move", ids, clickId:id, starts, moved:false, x0:e.clientX, y0:e.clientY };
    e.preventDefault(); return;
  }
  // Shift-drag on empty space = marquee box-select; otherwise pan.
  if (e.shiftKey) {
    S.drag = { type:"marquee", x0:e.clientX, y0:e.clientY };
    const m = document.getElementById("marquee");
    m.style.display = "block"; m.style.left = e.clientX + "px"; m.style.top = e.clientY + "px";
    m.style.width = "0px"; m.style.height = "0px";
    e.preventDefault(); return;
  }
  S.drag = { type:"pan", x0:e.clientX, y0:e.clientY, px:S.panX, py:S.panY, moved:false };
  viewport.classList.add("panning");
});
window.addEventListener("mousemove", e => {
  if (!S.drag) return;
  const drag = S.drag;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (drag.type === "pan") {
    if (Math.abs(dx) > CLICK_THRESH || Math.abs(dy) > CLICK_THRESH) drag.moved = true;
    S.panX = drag.px + dx; S.panY = drag.py + dy; applyTransform();
  } else if (drag.type === "move") {
    if (Math.abs(dx) > CLICK_THRESH || Math.abs(dy) > CLICK_THRESH) drag.moved = true;
    const wdx = dx / S.scale, wdy = dy / S.scale;
    for (const id of drag.ids) {
      const el = world.querySelector(`.room[data-id="${id}"]`);
      if (!el) continue;
      const s = drag.starts[id];
      el.style.left = (s.x * CELL + CELL/2 + wdx) + "px";
      el.style.top = (s.y * CELL + CELL/2 + wdy) + "px";
    }
  } else if (drag.type === "marquee") {
    const x = Math.min(e.clientX, drag.x0), y = Math.min(e.clientY, drag.y0);
    const m = document.getElementById("marquee");
    m.style.left = x + "px"; m.style.top = y + "px";
    m.style.width = Math.abs(e.clientX - drag.x0) + "px";
    m.style.height = Math.abs(e.clientY - drag.y0) + "px";
    m.classList.toggle("all", e.altKey);   // Alt = select across all layers
  } else if (drag.type === "area-draw") {
    const x = Math.min(e.clientX, drag.x0), y = Math.min(e.clientY, drag.y0);
    const m = document.getElementById("marquee");
    m.style.left = x + "px"; m.style.top = y + "px";
    m.style.width = Math.abs(e.clientX - drag.x0) + "px";
    m.style.height = Math.abs(e.clientY - drag.y0) + "px";
  } else if (drag.type === "area-move") {
    // translate the SVG group + label/handle live (avoids re-rendering the whole map per move)
    const wdx = dx / S.scale, wdy = dy / S.scale;
    const g = svg.querySelector(`.area-g[data-aid="${drag.aid}"]`);
    if (g) g.setAttribute("transform", `translate(${wdx},${wdy})`);
    world.querySelectorAll(`.area-label[data-aid="${drag.aid}"], .area-resize[data-aid="${drag.aid}"]`)
      .forEach(el => el.style.transform = `translate(${wdx}px, ${wdy}px)`);
  } else if (drag.type === "area-resize") {
    const ar = S.map.areas.find(a => a.id === drag.aid);
    if (ar && ar.rects.length === 1) {
      const ddx = Math.round(dx/S.scale/CELL), ddy = Math.round(dy/S.scale/CELL);
      ar.rects[0].w = clamp(drag.sw + ddx, 1, GRID_N - ar.rects[0].x);
      ar.rects[0].h = clamp(drag.sh + ddy, 1, GRID_N - ar.rects[0].y);
      renderFlat();   // reshape preview (single rect; cheap enough)
    }
  } else if (drag.type === "link") {
    const a = roomWorldCenter(S.map.rooms[drag.fromId]);
    const w1 = screenToWorld(e.clientX, e.clientY);
    updateGhostLine(drag.ghost, a.x, a.y, w1.x, w1.y);
    const overEl = document.elementFromPoint(e.clientX, e.clientY);
    const overRoom = overEl && overEl.closest(".room:not(.ghost)");
    world.querySelectorAll(".room.linktarget").forEach(x=>x.classList.remove("linktarget"));
    if (overRoom && overRoom.dataset.id !== drag.fromId) overRoom.classList.add("linktarget");
  }
});
window.addEventListener("mouseup", e => {
  if (!S.drag) return;
  const d = S.drag; S.drag = null; viewport.classList.remove("panning");
  if (d.type === "pan") {
    if (!d.moved) {
      if (S.linkMode) { if (S.pendingLink) setPending(null); return; } // empty click cancels pending link
      if (S.pathMode) { if (S.pathStart) { S.pathStart = null; setPathHint(); render(); } return; }
      // plain click on empty space just clears the selection (double-click to create a room)
      if (S.selection.size || S.selectedId || S.selectedAreaId) { clearSelection(); S.selectedAreaId = null; render(); }
    }
    return;
  }
  if (d.type === "marquee") {
    document.getElementById("marquee").style.display = "none";
    const a = screenToWorld(Math.min(e.clientX, d.x0), Math.min(e.clientY, d.y0));
    const b = screenToWorld(Math.max(e.clientX, d.x0), Math.max(e.clientY, d.y0));
    const allLayers = e.altKey;
    const pool = allLayers ? Object.values(S.map.rooms) : Object.values(S.map.rooms).filter(r => r.z === S.map.currentLayer);
    const hits = pool.filter(r => {
      const c = roomWorldCenter(r);
      return c.x >= a.x && c.x <= b.x && c.y >= a.y && c.y <= b.y;
    });
    S.selection = new Set(hits.map(r => r.id));
    S.selectedId = hits.length ? hits[hits.length - 1].id : null;
    // when grabbing across layers, hop to the primary's layer so the selection is visible
    if (allLayers && S.selectedId) S.map.currentLayer = S.map.rooms[S.selectedId].z;
    render(); return;
  }
  if (d.type === "area-draw") {
    const m = document.getElementById("marquee"); m.style.display = "none"; m.classList.remove("areadraw");
    const a = screenToWorld(Math.min(e.clientX, d.x0), Math.min(e.clientY, d.y0));
    const b = screenToWorld(Math.max(e.clientX, d.x0), Math.max(e.clientY, d.y0));
    const x0 = clamp(Math.floor(a.x / CELL), 0, GRID_N-1), y0 = clamp(Math.floor(a.y / CELL), 0, GRID_N-1);
    const x1 = clamp(Math.floor(b.x / CELL), 0, GRID_N-1), y1 = clamp(Math.floor(b.y / CELL), 0, GRID_N-1);
    const ar = { id: uid(), name: "Area", color: "Teal",
                 rects: [{ x: Math.min(x0,x1), y: Math.min(y0,y1), w: Math.abs(x1-x0)+1, h: Math.abs(y1-y0)+1 }] };
    S.map.areas.push(ar); S.selectedAreaId = ar.id; clearSelection();
    commit(); render();
    return;
  }
  if (d.type === "area-move") {
    const ar = S.map.areas.find(a => a.id === d.aid);
    if (ar) {
      let ddx = Math.round((e.clientX - d.x0)/S.scale/CELL), ddy = Math.round((e.clientY - d.y0)/S.scale/CELL);
      const minX = Math.min(...d.rects0.map(r => r.x)), minY = Math.min(...d.rects0.map(r => r.y));
      const maxX = Math.max(...d.rects0.map(r => r.x + r.w)), maxY = Math.max(...d.rects0.map(r => r.y + r.h));
      ddx = clamp(ddx, -minX, GRID_N - maxX); ddy = clamp(ddy, -minY, GRID_N - maxY);  // keep whole shape in grid
      ar.rects = d.rects0.map(rc => ({ x: rc.x + ddx, y: rc.y + ddy, w: rc.w, h: rc.h }));
      if (ddx || ddy) commit();
    }
    render(); return;
  }
  if (d.type === "area-resize") {
    // rects[0] already updated live during mousemove; just commit if it changed
    const ar = S.map.areas.find(a => a.id === d.aid);
    if (ar && ar.rects.length === 1 && (ar.rects[0].w !== d.sw || ar.rects[0].h !== d.sh)) commit();
    render(); return;
  }
  if (d.type === "move") {
    if (!d.moved) {
      // plain click without dragging: collapse a multi-selection to just the clicked room
      if (S.selection.size > 1) { selectSingle(d.clickId); render(); }
      else render();
      return;
    }
    const ddx = Math.round((e.clientX - d.x0) / S.scale / CELL);
    const ddy = Math.round((e.clientY - d.y0) / S.scale / CELL);
    const selSet = new Set(d.ids);
    let ok = (ddx !== 0 || ddy !== 0);
    for (const id of d.ids) {
      const nx = d.starts[id].x + ddx, ny = d.starts[id].y + ddy;
      if (nx < 0 || ny < 0 || nx >= GRID_N || ny >= GRID_N) { ok = false; break; }
      const occ = roomAtCell(S.map.rooms[id].z, nx, ny);
      if (occ && !selSet.has(occ.id)) { ok = false; break; }
    }
    if (ok) {
      for (const id of d.ids) { S.map.rooms[id].x = d.starts[id].x + ddx; S.map.rooms[id].y = d.starts[id].y + ddy; }
      commit();
    }
    render(); return;   // if not ok, render() snaps everything back to stored positions
  }
  if (d.type === "link") {
    if (d.ghost) d.ghost.remove();
    world.querySelectorAll(".room.linktarget").forEach(x=>x.classList.remove("linktarget"));
    const overEl = document.elementFromPoint(e.clientX, e.clientY);
    const overRoom = overEl && overEl.closest(".room:not(.ghost)");
    if (overRoom && overRoom.dataset.id !== d.fromId) openDirPicker(d.fromId, overRoom.dataset.id, e.clientX, e.clientY);
    return;
  }
});
viewport.addEventListener("click", e => {
  const badge = e.target.closest(".vbadge");
  if (badge) {
    const r = S.map.rooms[badge.closest(".room").dataset.id];
    const dir = badge.dataset.vbadge === "up" ? "UP" : "DOWN";
    if (r.exits[dir]) gotoRoom(r.exits[dir]);
    e.stopPropagation();
  }
});
// double-click an empty cell to create a room (single click no longer creates)
viewport.addEventListener("dblclick", e => {
  if (S.view !== "flat" || S.linkMode || S.pathMode || S.areaMode) return;
  if (e.target.closest(".room:not(.ghost)")) return;
  const w = screenToWorld(e.clientX, e.clientY);
  const cx = Math.floor(w.x / CELL), cy = Math.floor(w.y / CELL);
  if (cx >= 0 && cy >= 0 && cx < GRID_N && cy < GRID_N && !roomAtCell(S.map.currentLayer, cx, cy)) {
    const r = createRoom(S.map.currentLayer, cx, cy, "New Room");
    selectSingle(r.id); commit(); render();
  }
});

function makeGhostLine() {
  const ns = "http://www.w3.org/2000/svg";
  const l = document.createElementNS(ns, "line");
  l.setAttribute("stroke", "#46c46e"); l.setAttribute("stroke-width", "3");
  l.setAttribute("stroke-dasharray", "6,4"); svg.appendChild(l); return l;
}
function updateGhostLine(l, x1, y1, x2, y2) {
  l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
}

// ---------- Direction picker ----------
function buildDirGrid() {
  dirGrid.innerHTML = "";
  ["NW","N","NE","W",null,"E","SW","S","SE"].forEach(d => {
    const b = document.createElement("button");
    if (d === null) { b.disabled = true; b.textContent="·"; }
    else { b.textContent = d; b.dataset.dir = d; }
    dirGrid.appendChild(b);
  });
  const ud = document.createElement("div");
  ud.style.gridColumn = "1 / -1"; ud.style.display = "flex"; ud.style.gap = "5px"; ud.style.marginTop="5px";
  ["UP","DOWN"].forEach(d => {
    const b = document.createElement("button");
    b.textContent = d; b.dataset.dir = d; b.style.flex = "1"; ud.appendChild(b);
  });
  dirGrid.appendChild(ud);
}
function openDirPicker(fromId, toId, sx, sy) {
  S.pickerCtx = { fromId, toId }; buildDirGrid();
  const from = S.map.rooms[fromId], to = S.map.rooms[toId];
  document.getElementById("dirHdr").innerHTML =
    `Which way does<br><b>${escapeHtml(from.name)}</b> exit to <b>${escapeHtml(to.name)}</b>?`;
  dirpicker.style.display = "block";
  const w = dirpicker.offsetWidth, h = dirpicker.offsetHeight;
  dirpicker.style.left = clamp(sx, 0, window.innerWidth - w - 8) + "px";
  dirpicker.style.top = clamp(sy, 0, window.innerHeight - h - 8) + "px";
}
function closeDirPicker() { dirpicker.style.display = "none"; S.pickerCtx = null; }
dirGrid.addEventListener("click", e => {
  const b = e.target.closest("button[data-dir]");
  if (!b || !S.pickerCtx) return;
  const res = addExit(S.pickerCtx.fromId, b.dataset.dir, S.pickerCtx.toId);
  if (!res.ok) { alert(res.msg); return; }
  closeDirPicker();
  if (S.pendingLink) setPending(null);
  commit(); render();
});
document.addEventListener("mousedown", e => {
  if (dirpicker.style.display === "block" && !dirpicker.contains(e.target)) closeDirPicker();
});

// ---------- Wheel zoom ----------
viewport.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1/1.12);
}, { passive: false });

// ---------- Keyboard ----------
window.addEventListener("keydown", e => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  // Undo / redo (global, works with or without a selection)
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  if (e.key === "Escape") {
    if (S.pendingLink) setPending(null);
    if (S.pathMode) clearPath();
    if (S.areaMergeSource) { S.areaMergeSource = null; render(); return; }   // cancel a merge pick first
    S.selectedAreaId = null;
    clearSelection(); closeDirPicker(); render(); return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (S.selectedAreaId) {
      const a = S.map.areas.find(x => x.id === S.selectedAreaId);
      if (a && confirm(`Delete area "${a.name}"?`)) { deleteArea(S.selectedAreaId); commit(); render(); }
      e.preventDefault(); return;
    }
    if (S.selection.size > 1) {
      if (confirm(`Delete ${S.selection.size} selected rooms?`)) {
        for (const id of [...S.selection]) deleteRoom(id);
        clearSelection(); commit(); render();
      }
      e.preventDefault(); return;
    }
    if (S.selectedId) {
      const r = S.map.rooms[S.selectedId];
      if (r && confirm(`Delete "${r.name}"?`)) { deleteRoom(S.selectedId); commit(); render(); }
      e.preventDefault(); return;
    }
    return;
  }
  if (!S.selectedId) return;
  const k = e.key.toLowerCase();
  if (S.view === "flat") {
    // centre of the rose = vertical axis: S = up, Shift+S = down
    if (k === "s") { carve(S.selectedId, e.shiftKey ? "DOWN" : "UP"); e.preventDefault(); return; }
    if (KEYCARVE[k]) { carve(S.selectedId, KEYCARVE[k]); e.preventDefault(); }
  }
});
