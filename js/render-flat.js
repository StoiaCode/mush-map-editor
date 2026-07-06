import { CELL, GRID_N, WORLD, SIZE_PX, COMPASS, VEC, OPP } from "./constants.js";
import { S, viewport, world, svg, gridCanvas, ctx, layerLabel, zoomLabel } from "./state.js";
import { colorOf, areaHex, hexA, escapeHtml, clamp } from "./utils.js";
import { roomsOnLayer, layersPresent, areaCells, areaLabelAnchor, stationLinesFor } from "./model.js";
import { save } from "./persistence.js";
import { render } from "./app.js";

// ---------- Layer navigation ----------
export function setLayer(z) {
  S.map.currentLayer = z;
  save();
  render();
}
export function stepLayer(delta) {
  // step through layers that actually have rooms; if none above/below, allow a new empty one
  const ls = layersPresent();
  const cur = S.map.currentLayer;
  const candidates = ls.filter(z => delta > 0 ? z > cur : z < cur);
  if (candidates.length) {
    setLayer(delta > 0 ? Math.min(...candidates) : Math.max(...candidates));
  } else {
    setLayer(cur + delta); // venture onto an empty layer (e.g. to carve into it)
  }
}
export function updateLayerLabel() {
  const ls = layersPresent();
  const n = roomsOnLayer(S.map.currentLayer).length;
  layerLabel.textContent = "Layer " + S.map.currentLayer + (n ? `` : ` (empty)`);
  layerLabel.title = "Layers in use: " + ls.join(", ");
}

// ---------- View transform ----------
export function applyTransform() {
  world.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.scale})`;
  zoomLabel.textContent = Math.round(S.scale * 100) + "%";
  positionGrid();
}
export function screenToWorld(sx, sy) {
  const rect = viewport.getBoundingClientRect();
  return { x: (sx - rect.left - S.panX) / S.scale, y: (sy - rect.top - S.panY) / S.scale };
}
export function roomWorldCenter(r) { return { x: r.x * CELL + CELL/2, y: r.y * CELL + CELL/2 }; }
export function centerOnRoom(room) {
  const rect = viewport.getBoundingClientRect();
  const c = roomWorldCenter(room);
  S.panX = rect.width / 2 - c.x * S.scale;
  S.panY = rect.height / 2 - c.y * S.scale;
  applyTransform();
}
export function centerCellView(cx, cy) {
  const rect = viewport.getBoundingClientRect();
  S.panX = rect.width/2 - (cx*CELL+CELL/2)*S.scale;
  S.panY = rect.height/2 - (cy*CELL+CELL/2)*S.scale;
  applyTransform();
}
export function zoomAt(sx, sy, factor) {
  const rect = viewport.getBoundingClientRect();
  const cx = sx - rect.left, cy = sy - rect.top;
  const wx = (cx - S.panX) / S.scale, wy = (cy - S.panY) / S.scale;
  S.scale = clamp(S.scale * factor, 0.2, 2.5);
  S.panX = cx - wx * S.scale;
  S.panY = cy - wy * S.scale;
  applyTransform();
}

// ---------- Grid background ----------
export function resizeCanvas() {
  const rect = viewport.getBoundingClientRect();
  gridCanvas.width = rect.width; gridCanvas.height = rect.height;
  positionGrid();
}
export function positionGrid() {
  const w = gridCanvas.width, h = gridCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const step = CELL * S.scale;
  if (step < 6) return;
  const startX = S.panX % step, startY = S.panY % step;
  const firstCol = Math.floor((-S.panX) / step), firstRow = Math.floor((-S.panY) / step);
  ctx.lineWidth = 1;
  let col = firstCol;
  for (let x = startX; x < w; x += step, col++) {
    ctx.strokeStyle = (col % 5 === 0) ? "#2c3340" : "#212733";
    ctx.beginPath(); ctx.moveTo(Math.round(x)+0.5, 0); ctx.lineTo(Math.round(x)+0.5, h); ctx.stroke();
  }
  let row = firstRow;
  for (let y = startY; y < h; y += step, row++) {
    ctx.strokeStyle = (row % 5 === 0) ? "#2c3340" : "#212733";
    ctx.beginPath(); ctx.moveTo(0, Math.round(y)+0.5); ctx.lineTo(w, Math.round(y)+0.5); ctx.stroke();
  }
}

// ---------- Flat render ----------
export function renderFlat() {
  world.querySelectorAll(".room").forEach(e => e.remove());
  world.querySelectorAll(".area-label, .area-resize").forEach(e => e.remove());
  const z = S.map.currentLayer;

  // SVG connectors
  svg.setAttribute("width", WORLD); svg.setAttribute("height", WORLD);
  svg.innerHTML = `<defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#5b9dff"></path>
    </marker></defs>`;

  // areas: fill + outline on the SVG (behind connectors), shown on every layer; label + handle as DOM
  for (const ar of S.map.areas) drawAreaFlat(ar);

  // transit lines: dashed connector between consecutive stations, in the line's colour
  drawTransitLinesFlat(z);

  // --- onion-skin: neighbour layers ghosted behind everything, non-interactive ---
  if (S.onion.below) for (const r of roomsOnLayer(z - 1)) world.appendChild(makeRoomEl(r, "below"));
  if (S.onion.above) for (const r of roomsOnLayer(z + 1)) world.appendChild(makeRoomEl(r, "above"));

  // --- connectors for current layer compass exits ---
  // Group same-layer exits into undirected pairs so a reciprocal corridor is ONE
  // line, not two stacked ones. Off-layer exits stay as single directional stubs.
  const pairs = new Map(); // "idA|idB" (sorted) -> [{from,to,dir}, ...]
  for (const r of roomsOnLayer(z)) {
    for (const dir of COMPASS) {
      const t = S.map.rooms[r.exits[dir]];
      if (!t) continue;
      if (t.z === z) {
        const key = [r.id, t.id].sort().join("|");
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push({ from: r, to: t, dir });
      } else {
        const a = roomWorldCenter(r);
        const [dx, dy] = VEC[dir];
        drawStub(a.x, a.y, a.x + dx*CELL*0.7, a.y + dy*CELL*0.7, dir + "→L" + t.z);
      }
    }
  }
  for (const exits of pairs.values()) {
    const A = exits[0].from, B = exits[0].to;
    const ca = roomWorldCenter(A), cb = roomWorldCenter(B);
    const fly = exits.some(ex => ex.from.exitFly && ex.from.exitFly[ex.dir]);
    drawConnector(ca.x, ca.y, cb.x, cb.y, fly);
    const adjacent = Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y)) === 1;
    const cleanTwoWay = exits.length === 2 && exits[1].dir === OPP[exits[0].dir];
    // A normal two-way link between touching cells needs no label — direction is obvious.
    if (adjacent && cleanTwoWay) continue;
    // Otherwise label each direction. A reciprocal pair sits a third of the way
    // in from each end (so the two never meet); a lone/one-way label sits nearer
    // the middle where there's the most room.
    const frac = exits.length === 2 ? 0.33 : 0.45;
    for (const ex of exits) drawDirLabel(ex.from, ex.to, ex.dir, frac);
  }

  // --- current layer rooms (solid, on top) ---
  for (const r of roomsOnLayer(z)) world.appendChild(makeRoomEl(r, false));
}

export function drawAreaFlat(ar) {
  const ns = "http://www.w3.org/2000/svg";
  const c = areaHex(ar);
  const sel = ar.id === S.selectedAreaId;
  const g = document.createElementNS(ns, "g");
  g.setAttribute("class", "area-g"); g.dataset.aid = ar.id;
  // fill: one rectangle subpath per rect (nonzero union avoids double-alpha on overlaps)
  let fillD = "";
  for (const rc of ar.rects) fillD += `M${rc.x*CELL},${rc.y*CELL}h${rc.w*CELL}v${rc.h*CELL}h${-rc.w*CELL}z`;
  const fill = document.createElementNS(ns, "path");
  fill.setAttribute("d", fillD); fill.setAttribute("fill", hexA(c, 0.12)); fill.setAttribute("fill-rule", "nonzero");
  g.appendChild(fill);
  // outline: boundary edges only (cells whose neighbour is outside the area)
  const cells = areaCells(ar);
  let outD = "";
  for (const key of cells) {
    const [cx, cy] = key.split(":").map(Number);
    const x = cx*CELL, y = cy*CELL;
    if (!cells.has(cx + ":" + (cy-1))) outD += `M${x},${y}h${CELL}`;
    if (!cells.has(cx + ":" + (cy+1))) outD += `M${x},${y+CELL}h${CELL}`;
    if (!cells.has((cx-1) + ":" + cy)) outD += `M${x},${y}v${CELL}`;
    if (!cells.has((cx+1) + ":" + cy)) outD += `M${x+CELL},${y}v${CELL}`;
  }
  const out = document.createElementNS(ns, "path");
  out.setAttribute("d", outD); out.setAttribute("fill", "none");
  out.setAttribute("stroke", sel ? "#5b9dff" : hexA(c, 0.7));
  out.setAttribute("stroke-width", sel ? 3 : 2);
  g.appendChild(out);
  svg.appendChild(g);
  // label (DOM) at the top-left-most occupied cell
  const anchor = areaLabelAnchor(ar);
  const lab = document.createElement("div");
  lab.className = "area-label" + (sel ? " selected" : "");
  lab.dataset.aid = ar.id; lab.textContent = ar.name;
  lab.style.left = (anchor.x*CELL) + "px"; lab.style.top = (anchor.y*CELL) + "px";
  lab.style.background = hexA(c, 0.85);
  world.appendChild(lab);
  // resize handle (single-rect areas only), at that rect's bottom-right
  if (ar.rects.length === 1) {
    const rc = ar.rects[0];
    const rz = document.createElement("div");
    rz.className = "area-resize"; rz.dataset.aid = ar.id;
    rz.style.left = ((rc.x+rc.w)*CELL) + "px"; rz.style.top = ((rc.y+rc.h)*CELL) + "px";
    world.appendChild(rz);
  }
}
// Dashed connector between consecutive stations on each line, in the line's colour.
// Same-layer pairs get a direct line; a pair with one endpoint off-layer gets a stub
// (mirrors the off-layer exit stub) pointed toward the real direction of the other stop.
function drawTransitLinesFlat(z) {
  for (const line of S.map.transitLines) {
    const c = areaHex(line);
    for (let i = 0; i < line.stations.length - 1; i++) {
      const a = S.map.rooms[line.stations[i]], b = S.map.rooms[line.stations[i + 1]];
      if (!a || !b) continue;
      const onA = a.z === z, onB = b.z === z;
      if (onA && onB) {
        const ca = roomWorldCenter(a), cb = roomWorldCenter(b);
        drawTransitConnector(ca.x, ca.y, cb.x, cb.y, c);
      } else if (onA || onB) {
        const near = onA ? a : b, far = onA ? b : a;
        const cn = roomWorldCenter(near), cf = roomWorldCenter(far);
        const dx = cf.x - cn.x, dy = cf.y - cn.y;
        const len = Math.hypot(dx, dy) || 1, stubLen = CELL * 0.7;
        drawTransitStub(cn.x, cn.y, cn.x + dx/len*stubLen, cn.y + dy/len*stubLen, "🚆 " + line.name + " →L" + far.z, c);
      }
    }
  }
}
function drawTransitConnector(x1, y1, x2, y2, color) {
  const ns = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-dasharray", "8,5");
  svg.appendChild(line);
}
function drawTransitStub(x1, y1, x2, y2, label, color) {
  const ns = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-dasharray", "3,4");
  svg.appendChild(line);
  const txt = document.createElementNS(ns, "text");
  txt.setAttribute("x", x2); txt.setAttribute("y", y2 - 4);
  txt.setAttribute("text-anchor", "middle"); txt.setAttribute("class", "exitlabel");
  txt.textContent = label; svg.appendChild(txt);
}
// ghost: false (solid), or "below" / "above" for onion-skin neighbour layers.
export function makeRoomEl(r, ghost) {
  const sel = !ghost && (r.id === S.selectedId || S.selection.has(r.id));
  const el = document.createElement("div");
  el.className = "room" + (ghost ? " ghost" : "")
    + (ghost === "above" ? " above" : "")
    + (sel ? " selected" : "")
    + (!ghost && r.id === S.pendingLink ? " linksource" : "")
    + (!ghost && r.id === S.pathStart ? " linksource" : "")
    + (!ghost && S.pathRooms.has(r.id) ? " pathhit" : "")
    + (!ghost && S.searchTerm && S.searchMatches.includes(r.id) ? " searchhit" : "");
  el.dataset.id = r.id;
  const px = SIZE_PX[r.size] || SIZE_PX.medium;
  const c = roomWorldCenter(r);
  el.style.left = c.x + "px"; el.style.top = c.y + "px";
  el.style.width = px + "px"; el.style.height = px + "px";
  el.style.backgroundColor = colorOf(r);
  if (!ghost && r.imageUrl) {
    // image sits over the color fallback; if it 404s/is slow, the color still shows (no JS needed)
    el.style.backgroundImage = `url("${r.imageUrl.replace(/"/g, '%22')}")`;
    el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center";
    el.classList.add("has-image");
  }
  el.style.fontSize = (r.size === "small" ? 9 : r.size === "large" ? 12 : 10) + "px";
  if (ghost) el.style.opacity = S.onion.opacity;
  const tag = S.map.tagLabels && S.map.tagLabels[r.color];
  el.title = r.name + (tag ? "  ·  " + tag : "");
  el.innerHTML = `<span class="rname">${escapeHtml(r.name)}</span>`;
  if (!ghost) {
    if (r.exits.UP)   el.appendChild(vbadge("up", "↑", r.exitFly && r.exitFly.UP));
    if (r.exits.DOWN) el.appendChild(vbadge("down", "↓", r.exitFly && r.exitFly.DOWN));
    const lines = stationLinesFor(r.id);
    if (lines.length) el.appendChild(trainBadge(lines));
  }
  return el;
}
export function vbadge(kind, ch, fly) {
  const b = document.createElement("div");
  b.className = "vbadge " + kind + (fly ? " fly" : "");
  b.textContent = ch; b.dataset.vbadge = kind;
  if (fly) b.title = "flight-only";
  return b;
}
export function trainBadge(lines) {
  const b = document.createElement("div");
  b.className = "vbadge train";
  b.textContent = "🚆"; b.dataset.vbadge = "train";
  const c = areaHex(lines[0]);
  b.style.borderColor = c; b.style.color = c;
  b.title = lines.map(l => l.name).join(", ");
  return b;
}
export function drawConnector(x1, y1, x2, y2, fly) {
  const ns = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", fly ? "#3cc4b8" : "#4a5566");
  line.setAttribute("stroke-width", "2.5");
  if (fly) line.setAttribute("stroke-dasharray", "6,5");
  svg.appendChild(line);
}
// Label placed near the SOURCE room so a reciprocal pair's two labels sit at
// opposite ends of the line and never collide.
export function drawDirLabel(from, to, dir, frac) {
  const ns = "http://www.w3.org/2000/svg";
  const a = roomWorldCenter(from), b = roomWorldCenter(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = len * (frac || 0.35);
  const txt = document.createElementNS(ns, "text");
  txt.setAttribute("x", a.x + dx / len * off);
  txt.setAttribute("y", a.y + dy / len * off);
  txt.setAttribute("text-anchor", "middle");
  txt.setAttribute("dominant-baseline", "central");
  txt.setAttribute("class", "exitlabel");
  txt.textContent = dir;
  svg.appendChild(txt);
}
export function drawStub(x1, y1, x2, y2, label) {
  const ns = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  line.setAttribute("stroke", "#5b9dff"); line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-dasharray", "5,4"); line.setAttribute("marker-end", "url(#arrow)");
  svg.appendChild(line);
  const txt = document.createElementNS(ns, "text");
  txt.setAttribute("x", x2); txt.setAttribute("y", y2 - 4);
  txt.setAttribute("text-anchor", "middle"); txt.setAttribute("class", "exitlabel");
  txt.textContent = label; svg.appendChild(txt);
}
