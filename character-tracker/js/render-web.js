import { NODE_SIZE, WORLD_SIZE } from "./constants.js";
import { S, viewport, world, svg, zoomLabel } from "./state.js";
import { colorOf, hexA, escapeHtml, clamp, initials } from "./utils.js";
import { relationshipsFor, primaryImage } from "./model.js";

// ---------- View transform (fluid — free (x,y), no grid cells) ----------
export function applyTransform() {
  world.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.scale})`;
  zoomLabel.textContent = Math.round(S.scale * 100) + "%";
}
export function screenToWorld(sx, sy) {
  const rect = viewport.getBoundingClientRect();
  return { x: (sx - rect.left - S.panX) / S.scale, y: (sy - rect.top - S.panY) / S.scale };
}
export function centerOnPoint(x, y) {
  const rect = viewport.getBoundingClientRect();
  S.panX = rect.width / 2 - x * S.scale;
  S.panY = rect.height / 2 - y * S.scale;
  applyTransform();
}
export function centerOnCharacter(ch) { centerOnPoint(ch.x, ch.y); }
export function zoomAt(sx, sy, factor) {
  const rect = viewport.getBoundingClientRect();
  const cx = sx - rect.left, cy = sy - rect.top;
  const wx = (cx - S.panX) / S.scale, wy = (cy - S.panY) / S.scale;
  S.scale = clamp(S.scale * factor, 0.15, 2.5);
  S.panX = cx - wx * S.scale;
  S.panY = cy - wy * S.scale;
  applyTransform();
}

// ---------- Render ----------
export function renderWeb() {
  world.querySelectorAll(".node, .ann-label, .ann-resize").forEach(e => e.remove());
  svg.setAttribute("width", WORLD_SIZE); svg.setAttribute("height", WORLD_SIZE);
  svg.innerHTML = "";

  for (const ann of S.map.annotations) drawAnnotation(ann);
  if (S.circleMode && S.circleDraft) drawDraftCircle(S.circleDraft);

  const drawn = new Set();
  for (const rel of S.map.relationships) {
    const a = S.map.characters[rel.fromId], b = S.map.characters[rel.toId];
    if (!a || !b) continue;
    drawRelationship(a, b, rel);
    drawn.add(rel.id);
  }
  if (S.linkMode && S.pendingLink) {
    const a = S.map.characters[S.pendingLink];
    if (a) drawPendingLink(a);
  }

  for (const ch of Object.values(S.map.characters)) world.appendChild(makeNodeEl(ch));
}

function makeNodeEl(ch) {
  const sel = ch.id === S.selectedId;
  const el = document.createElement("div");
  el.className = "node"
    + (sel ? " selected" : "")
    + (ch.id === S.pendingLink ? " linksource" : "")
    + (S.searchTerm && S.searchMatches.includes(ch.id) ? " searchhit" : "");
  el.dataset.id = ch.id;
  el.style.left = ch.x + "px"; el.style.top = ch.y + "px";
  el.style.width = NODE_SIZE + "px"; el.style.height = NODE_SIZE + "px";
  el.style.backgroundColor = colorOf(ch);
  const img = primaryImage(ch);
  if (img) {
    el.style.backgroundImage = `url("${img.replace(/"/g, '%22')}")`;
    el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center";
    el.classList.add("has-image");
  }
  el.title = ch.name;
  el.innerHTML = img
    ? `<span class="nname">${escapeHtml(ch.name)}</span>`
    : `<span class="ninit">${escapeHtml(initials(ch.name))}</span><span class="nname">${escapeHtml(ch.name)}</span>`;
  return el;
}

function charCenter(ch) { return { x: ch.x + NODE_SIZE / 2, y: ch.y + NODE_SIZE / 2 }; }

function drawRelationship(a, b, rel) {
  const ns = "http://www.w3.org/2000/svg";
  const ca = charCenter(a), cb = charCenter(b);
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", ca.x); line.setAttribute("y1", ca.y);
  line.setAttribute("x2", cb.x); line.setAttribute("y2", cb.y);
  line.setAttribute("stroke", "#5b9dff"); line.setAttribute("stroke-width", "2.5");
  line.setAttribute("class", "rel-line"); line.dataset.rel = rel.id;
  svg.appendChild(line);
  // wide, invisible hit-target so the thin line is easy to click
  const hit = document.createElementNS(ns, "line");
  hit.setAttribute("x1", ca.x); hit.setAttribute("y1", ca.y);
  hit.setAttribute("x2", cb.x); hit.setAttribute("y2", cb.y);
  hit.setAttribute("stroke", "transparent"); hit.setAttribute("stroke-width", "16");
  hit.setAttribute("class", "rel-hit"); hit.dataset.rel = rel.id;
  hit.style.pointerEvents = "stroke";
  svg.appendChild(hit);
  if (rel.label) {
    const mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
    const txt = document.createElementNS(ns, "text");
    txt.setAttribute("x", mx); txt.setAttribute("y", my - 6);
    txt.setAttribute("text-anchor", "middle"); txt.setAttribute("class", "rel-label");
    txt.textContent = rel.label;
    svg.appendChild(txt);
  }
}
function drawPendingLink(a) {
  // a faint marker on the pending source; the live line to the cursor is handled in interactions.js
}

// ---------- Freeform grouping circles ----------
export function drawAnnotation(ann) {
  const ns = "http://www.w3.org/2000/svg";
  const c = colorOf(ann);
  const sel = ann.id === S.selectedAnnotationId;
  const g = document.createElementNS(ns, "g");
  g.setAttribute("class", "ann-g"); g.dataset.aid = ann.id;
  const ell = document.createElementNS(ns, "ellipse");
  ell.setAttribute("cx", ann.cx); ell.setAttribute("cy", ann.cy);
  ell.setAttribute("rx", ann.rx); ell.setAttribute("ry", ann.ry);
  ell.setAttribute("fill", hexA(c, 0.10));
  ell.setAttribute("stroke", sel ? "#ffffff" : hexA(c, 0.75));
  ell.setAttribute("stroke-width", sel ? 3 : 2);
  ell.dataset.aid = ann.id;
  g.appendChild(ell);
  svg.appendChild(g);
  const lab = document.createElement("div");
  lab.className = "ann-label" + (sel ? " selected" : "");
  lab.dataset.aid = ann.id; lab.textContent = ann.name;
  lab.style.left = ann.cx + "px"; lab.style.top = (ann.cy - ann.ry) + "px";
  lab.style.background = hexA(c, 0.85);
  world.appendChild(lab);
  if (sel) {
    const rz = document.createElement("div");
    rz.className = "ann-resize"; rz.dataset.aid = ann.id;
    rz.style.left = (ann.cx + ann.rx) + "px"; rz.style.top = (ann.cy + ann.ry) + "px";
    world.appendChild(rz);
  }
}
function drawDraftCircle(d) {
  const ns = "http://www.w3.org/2000/svg";
  const cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;
  const rx = Math.abs(d.x1 - d.x0) / 2, ry = Math.abs(d.y1 - d.y0) / 2;
  const ell = document.createElementNS(ns, "ellipse");
  ell.setAttribute("cx", cx); ell.setAttribute("cy", cy);
  ell.setAttribute("rx", rx); ell.setAttribute("ry", ry);
  ell.setAttribute("fill", "rgba(91,157,255,.12)");
  ell.setAttribute("stroke", "#5b9dff"); ell.setAttribute("stroke-width", "2");
  ell.setAttribute("stroke-dasharray", "6,4");
  svg.appendChild(ell);
}
