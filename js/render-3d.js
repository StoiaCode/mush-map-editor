import { CELL, LAYER_GAP } from "./constants.js";
import { S, view3dEl, ctx3d } from "./state.js";
import { clamp, colorOf, areaHex, hexA } from "./utils.js";
import { layersPresent, areaCells, selectSingle, clearSelection } from "./model.js";
import { render } from "./app.js";

// ---------- 3D view (hand-rolled canvas: rotate → project → painter-sort) ----------
export function resize3d() {
  const rect = view3dEl.getBoundingClientRect();
  if (rect.width && rect.height && (view3dEl.width !== rect.width || view3dEl.height !== rect.height)) {
    view3dEl.width = rect.width; view3dEl.height = rect.height;
  }
}
// world coords for a room: x→east, -layer→up, -gridY→depth.
// Use the cell CENTRE (+CELL/2) to match the flat view and sit symmetrically inside
// area slabs (which span cell edges). grid-Y is negated so the ground plane isn't
// mirrored vs. the flat top-down map (canvas screen-Y points downward).
export function room3dWorld(r) { return { x: r.x * CELL + CELL/2, y: -r.z * LAYER_GAP, z: -(r.y * CELL + CELL/2) }; }
export function scene3dCentroid() {
  const rooms = Object.values(S.map.rooms);
  if (!rooms.length) return { x: 0, y: 0, z: 0, radius: 1 };
  let sx = 0, sy = 0, sz = 0;
  for (const r of rooms) { const w = room3dWorld(r); sx += w.x; sy += w.y; sz += w.z; }
  const c = { x: sx / rooms.length, y: sy / rooms.length, z: sz / rooms.length };
  let rad = 1;
  for (const r of rooms) { const w = room3dWorld(r); rad = Math.max(rad, Math.hypot(w.x - c.x, w.y - c.y, w.z - c.z)); }
  c.radius = rad;
  return c;
}
export function fit3d() {
  const c = scene3dCentroid();
  S.cam3d.cx = c.x; S.cam3d.cy = c.y; S.cam3d.cz = c.z;
  S.cam3d.dist = Math.max(700, c.radius * 2.4 + 600);
  S.cam3d.fitted = true;
}
// project a world point to screen; returns {sx, sy, depth, scale} or null if behind camera
export function project3d(p) {
  const cam3d = S.cam3d;
  const dx = p.x - cam3d.cx, dy = p.y - cam3d.cy, dz = p.z - cam3d.cz;
  const cy = Math.cos(cam3d.yaw), sy = Math.sin(cam3d.yaw);
  // yaw about vertical (y) axis
  let rx = dx * cy - dz * sy;
  let rz = dx * sy + dz * cy;
  let ry = dy;
  // pitch about horizontal (x) axis
  const cp = Math.cos(cam3d.pitch), sp = Math.sin(cam3d.pitch);
  const ry2 = ry * cp - rz * sp;
  const rz2 = ry * sp + rz * cp;
  const depth = rz2 + cam3d.dist;          // distance from camera plane (dist = camera distance)
  if (depth <= 1) return null;
  const F = 900;                            // fixed focal length (decoupled from camera distance)
  const k = F / depth;
  return {
    sx: view3dEl.width / 2 + rx * k,
    sy: view3dEl.height / 2 + ry2 * k,
    depth, scale: k
  };
}
export function render3d() {
  if (!S.cam3d.fitted) fit3d();
  const W = view3dEl.width, H = view3dEl.height;
  ctx3d.clearRect(0, 0, W, H);
  const rooms = Object.values(S.map.rooms);
  if (!rooms.length) {
    ctx3d.fillStyle = "#8a93a3"; ctx3d.font = "14px Segoe UI, sans-serif";
    ctx3d.textAlign = "center";
    ctx3d.fillText("No rooms yet — build a map in the Flat view, then come back to orbit it in 3D.", W/2, H/2);
    S.proj3dCache = []; return;
  }
  // area slabs first (behind everything): translucent volumes spanning all layers
  if (S.map.areas.length) {
    const ls = layersPresent();
    const yTop = -(Math.max(...ls) + 0.6) * LAYER_GAP;
    const yBot = -(Math.min(...ls) - 0.6) * LAYER_GAP;
    for (const ar of S.map.areas) drawAreaSlab3d(ar, yTop, yBot);
  }

  // project every room once
  const pr = {};
  for (const r of rooms) { const p = project3d(room3dWorld(r)); if (p) pr[r.id] = p; }

  // exit lines (deduped undirected pairs), drawn first so blocks occlude them
  const pairs = new Map();
  for (const r of rooms) {
    for (const dir of ["N","NE","E","SE","S","SW","W","NW","UP","DOWN"]) {
      const t = S.map.rooms[r.exits[dir]];
      if (!t) continue;
      const key = [r.id, t.id].sort().join("|");
      const fly = !!(r.exitFly && r.exitFly[dir]);
      if (!pairs.has(key)) pairs.set(key, { a: r, b: t, vertical: (dir === "UP" || dir === "DOWN"), fly });
      else { const p = pairs.get(key); if (dir === "UP" || dir === "DOWN") p.vertical = true; if (fly) p.fly = true; }
    }
  }
  for (const { a, b, vertical, fly } of pairs.values()) {
    const pa = pr[a.id], pb = pr[b.id];
    if (!pa || !pb) continue;
    ctx3d.strokeStyle = fly ? "rgba(60,196,184,0.9)" : (vertical ? "rgba(91,157,255,0.85)" : "rgba(140,150,165,0.55)");
    ctx3d.lineWidth = (vertical || fly) ? 2.5 : 1.5;
    ctx3d.setLineDash(fly ? [6, 5] : []);
    ctx3d.beginPath(); ctx3d.moveTo(pa.sx, pa.sy); ctx3d.lineTo(pb.sx, pb.sy); ctx3d.stroke();
  }
  ctx3d.setLineDash([]);

  // transit lines: dashed connector between consecutive stations, regardless of layer
  // (cross-layer exits already do this; stations reuse the same "just draw it" approach)
  for (const line of S.map.transitLines) {
    const color = areaHex(line);
    ctx3d.strokeStyle = color; ctx3d.lineWidth = 2; ctx3d.setLineDash([7, 5]);
    for (let i = 0; i < line.stations.length - 1; i++) {
      const pa = pr[line.stations[i]], pb = pr[line.stations[i + 1]];
      if (!pa || !pb) continue;
      ctx3d.beginPath(); ctx3d.moveTo(pa.sx, pa.sy); ctx3d.lineTo(pb.sx, pb.sy); ctx3d.stroke();
    }
  }
  ctx3d.setLineDash([]);

  // rooms, sorted far → near
  const order = rooms.filter(r => pr[r.id]).sort((r1, r2) => pr[r2.id].depth - pr[r1.id].depth);
  S.proj3dCache = [];
  for (const r of order) {
    const p = pr[r.id];
    const sz = clamp(46 * p.scale, 8, 120);
    const half = sz / 2;
    const isSel = r.id === S.selectedId || S.selection.has(r.id);
    // block
    ctx3d.fillStyle = colorOf(r);
    ctx3d.strokeStyle = isSel ? "#ffffff" : "rgba(0,0,0,0.45)";
    ctx3d.lineWidth = isSel ? 3 : 1;
    roundRect3d(p.sx - half, p.sy - half, sz, sz, Math.min(8, half * 0.4));
    ctx3d.fill(); ctx3d.stroke();
    if (isSel) {
      ctx3d.strokeStyle = "#5b9dff"; ctx3d.lineWidth = 2;
      roundRect3d(p.sx - half - 4, p.sy - half - 4, sz + 8, sz + 8, Math.min(10, half * 0.4 + 4));
      ctx3d.stroke();
    }
    // label inside the block (like the flat view), wrapping to 2 lines; hidden when too small
    if (sz >= 20) {
      const fs = clamp(sz * 0.24, 7, 13);
      ctx3d.font = fs + "px Segoe UI, sans-serif";
      ctx3d.textAlign = "center"; ctx3d.textBaseline = "middle";
      ctx3d.fillStyle = "#11141a";
      const lines = wrapLabel3d(r.name, sz - 8, 2);
      const lh = fs * 1.12;
      const y0 = p.sy - (lines.length - 1) * lh / 2;
      lines.forEach((ln, i) => ctx3d.fillText(ln, p.sx, y0 + i * lh));
    }
    S.proj3dCache.push({ id: r.id, sx: p.sx, sy: p.sy, r: half + 4 });
  }
}
// truncate text with an ellipsis to fit maxW (font must already be set on ctx3d)
function fitLabel3d(text, maxW) {
  if (ctx3d.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx3d.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
// wrap text to at most maxLines lines fitting maxW; ellipsize the last line if needed
function wrapLabel3d(text, maxW, maxLines) {
  if (ctx3d.measureText(text).width <= maxW) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + " " + words[i] : words[i];
    if (!cur || ctx3d.measureText(test).width <= maxW) {
      cur = test;
    } else {
      lines.push(cur);
      if (lines.length === maxLines - 1) { cur = words.slice(i).join(" "); break; } // rest onto final line
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines.slice(0, maxLines).map(l => fitLabel3d(l, maxW));
}
// translucent extruded box for an area, spanning yBot..yTop (all layers)
function drawAreaSlab3d(ar, yTop, yBot) {
  const c = areaHex(ar);
  ctx3d.fillStyle = hexA(c, 0.10); ctx3d.strokeStyle = hexA(c, 0.55); ctx3d.lineWidth = 1.5;
  const quad = (a, b, cc, d) => {                 // fill+stroke a projected quad, skip if any point is behind
    const p = [a, b, cc, d].map(q => project3d(q));
    if (p.some(x => !x)) return;
    ctx3d.beginPath(); ctx3d.moveTo(p[0].sx, p[0].sy);
    for (let i = 1; i < 4; i++) ctx3d.lineTo(p[i].sx, p[i].sy);
    ctx3d.closePath(); ctx3d.fill(); ctx3d.stroke();
  };
  // top & bottom caps: one horizontal quad per rect (coplanar, so no seam)
  let cxSum = 0, czSum = 0, n = 0;
  for (const rc of ar.rects) {
    const x0 = rc.x * CELL, x1 = (rc.x + rc.w) * CELL;
    const z0 = -rc.y * CELL, z1 = -(rc.y + rc.h) * CELL;   // grid-Y negated to match room3dWorld
    cxSum += (x0 + x1) / 2; czSum += (z0 + z1) / 2; n++;
    quad({x:x0,y:yBot,z:z0},{x:x1,y:yBot,z:z0},{x:x1,y:yBot,z:z1},{x:x0,y:yBot,z:z1});
    quad({x:x0,y:yTop,z:z0},{x:x1,y:yTop,z:z0},{x:x1,y:yTop,z:z1},{x:x0,y:yTop,z:z1});
  }
  // side walls only along the union's boundary edges (internal shared edges get no wall).
  // Consecutive boundary cells along the same straight edge are merged into one run so a
  // long wall is a single quad, not one per cell (avoids a stripe at every cell seam).
  const cells = areaCells(ar);
  function mergeRuns(nums) {
    const sorted = [...nums].sort((a, b) => a - b);
    const runs = []; let start = sorted[0], prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
      runs.push([start, prev]); start = sorted[i]; prev = sorted[i];
    }
    if (sorted.length) runs.push([start, prev]);
    return runs;
  }
  const northByRow = new Map(), southByRow = new Map(), westByCol = new Map(), eastByCol = new Map();
  for (const k of cells) {
    const [cx, cy] = k.split(":").map(Number);
    if (!cells.has(cx + ":" + (cy-1))) (northByRow.get(cy) || northByRow.set(cy, []).get(cy)).push(cx);
    if (!cells.has(cx + ":" + (cy+1))) (southByRow.get(cy) || southByRow.set(cy, []).get(cy)).push(cx);
    if (!cells.has((cx-1) + ":" + cy)) (westByCol.get(cx) || westByCol.set(cx, []).get(cx)).push(cy);
    if (!cells.has((cx+1) + ":" + cy)) (eastByCol.get(cx) || eastByCol.set(cx, []).get(cx)).push(cy);
  }
  for (const [cy, xs] of northByRow) for (const [a, b] of mergeRuns(xs)) {
    const X = a*CELL, X1 = (b+1)*CELL, Z = -cy*CELL;
    quad({x:X,y:yBot,z:Z},{x:X1,y:yBot,z:Z},{x:X1,y:yTop,z:Z},{x:X,y:yTop,z:Z});
  }
  for (const [cy, xs] of southByRow) for (const [a, b] of mergeRuns(xs)) {
    const X = a*CELL, X1 = (b+1)*CELL, Z1 = -(cy+1)*CELL;
    quad({x:X,y:yBot,z:Z1},{x:X1,y:yBot,z:Z1},{x:X1,y:yTop,z:Z1},{x:X,y:yTop,z:Z1});
  }
  for (const [cx, ys] of westByCol) for (const [a, b] of mergeRuns(ys)) {
    const X = cx*CELL, Z = -a*CELL, Z1 = -(b+1)*CELL;
    quad({x:X,y:yBot,z:Z},{x:X,y:yBot,z:Z1},{x:X,y:yTop,z:Z1},{x:X,y:yTop,z:Z});
  }
  for (const [cx, ys] of eastByCol) for (const [a, b] of mergeRuns(ys)) {
    const X1 = (cx+1)*CELL, Z = -a*CELL, Z1 = -(b+1)*CELL;
    quad({x:X1,y:yBot,z:Z},{x:X1,y:yBot,z:Z1},{x:X1,y:yTop,z:Z1},{x:X1,y:yTop,z:Z});
  }
  const tc = n && project3d({ x: cxSum / n, y: yTop, z: czSum / n });   // one label at the union centre
  if (tc) {
    ctx3d.fillStyle = hexA(c, 0.95); ctx3d.font = "bold 12px Segoe UI, sans-serif";
    ctx3d.textAlign = "center"; ctx3d.textBaseline = "bottom";
    ctx3d.lineWidth = 3; ctx3d.strokeStyle = "rgba(15,17,21,0.85)";
    ctx3d.strokeText(ar.name, tc.sx, tc.sy - 4);
    ctx3d.fillText(ar.name, tc.sx, tc.sy - 4);
  }
}
function roundRect3d(x, y, w, h, r) {
  ctx3d.beginPath();
  ctx3d.moveTo(x + r, y);
  ctx3d.arcTo(x + w, y, x + w, y + h, r);
  ctx3d.arcTo(x + w, y + h, x, y + h, r);
  ctx3d.arcTo(x, y + h, x, y, r);
  ctx3d.arcTo(x, y, x + w, y, r);
  ctx3d.closePath();
}
function pick3d(mx, my) {
  // nearest projected room within its radius (cache is far→near, so last match = frontmost)
  let hit = null;
  for (const c of S.proj3dCache) {
    if (Math.hypot(mx - c.sx, my - c.sy) <= c.r) hit = c.id;
  }
  return hit;
}

// ---------- 3D view interaction (orbit / zoom / click-select) ----------
view3dEl.addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  S.drag3d = { x0: e.clientX, y0: e.clientY, yaw: S.cam3d.yaw, pitch: S.cam3d.pitch, moved: false };
  view3dEl.classList.add("dragging");
  e.preventDefault();
});
window.addEventListener("mousemove", e => {
  if (!S.drag3d) return;
  const dx = e.clientX - S.drag3d.x0, dy = e.clientY - S.drag3d.y0;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) S.drag3d.moved = true;
  S.cam3d.yaw = S.drag3d.yaw + dx * 0.01;
  S.cam3d.pitch = clamp(S.drag3d.pitch + dy * 0.01, -1.4, 1.4);
  render3d();
});
window.addEventListener("mouseup", e => {
  if (!S.drag3d) return;
  const d = S.drag3d; S.drag3d = null;
  view3dEl.classList.remove("dragging");
  if (!d.moved) {
    const rect = view3dEl.getBoundingClientRect();
    const id = pick3d(e.clientX - rect.left, e.clientY - rect.top);
    if (id) { selectSingle(id); render(); }
    else { clearSelection(); render(); }
  }
});
view3dEl.addEventListener("wheel", e => {
  e.preventDefault();
  S.cam3d.dist = clamp(S.cam3d.dist * (e.deltaY < 0 ? 1/1.12 : 1.12), 200, 12000);
  render3d();
}, { passive: false });
