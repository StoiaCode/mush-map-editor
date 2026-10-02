import { PALETTE, DIRS } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml, areaHex } from "./utils.js";
import { roomsInArea, layersPresent, roomsOnLayer, spaceOf } from "./model.js";
import { spaceName, layerName } from "./spaces.js";
import { save, commit } from "./persistence.js";
import { render } from "./app.js";

// ---------- Stats helpers ----------
export function colorCounts() {
  const c = {}; for (const p of PALETTE) c[p.name] = 0;
  for (const r of Object.values(S.map.rooms)) c[r.color] = (c[r.color] || 0) + 1;
  return c;
}
export function traitCounts() {
  const c = {};
  for (const r of Object.values(S.map.rooms)) for (const tid of r.traits) c[tid] = (c[tid] || 0) + 1;
  return c;
}
export function connectionCount() {
  const seen = new Set();
  for (const r of Object.values(S.map.rooms))
    for (const d of DIRS) { const t = r.exits[d]; if (t && S.map.rooms[t]) seen.add([r.id, t].sort().join("|")); }
  return seen.size;
}

export function buildLegend() {
  const rows = document.getElementById("legendRows");
  const cc = colorCounts();
  rows.innerHTML = "";
  for (const p of PALETTE) {
    const row = document.createElement("div");
    row.className = "legendrow";
    const sw = document.createElement("div");
    sw.className = "sw"; sw.style.background = p.c;
    const inp = document.createElement("input");
    inp.type = "text"; inp.placeholder = p.name; inp.value = S.map.tagLabels[p.name] || "";
    inp.addEventListener("input", () => { S.map.tagLabels[p.name] = inp.value; save(); });
    inp.addEventListener("change", () => { commit(); render(); });
    const cnt = document.createElement("span");
    cnt.className = "cnt"; cnt.textContent = cc[p.name]; cnt.title = cc[p.name] + " room(s) with this tag";
    row.appendChild(sw); row.appendChild(inp); row.appendChild(cnt); rows.appendChild(row);
  }
}
export function buildStats() {
  const el = document.getElementById("statsBody");
  const rooms = Object.values(S.map.rooms);
  const cc = colorCounts();
  const plur = (n, w) => `<b>${n}</b> ${w}${n === 1 ? "" : "s"}`;
  const nSpaces = S.map.spaces.length;
  let h = `<div class="statline">${plur(rooms.length,"room")} · ${plur(S.map.areas.length,"area")}` +
    (nSpaces ? ` · ${plur(nSpaces,"space")}` : ` · ${plur(layersPresent(null).length,"layer")}`) +
    ` · ${plur(connectionCount(),"connection")}</div>`;
  // per-layer counts, one block per space (main map first) so nothing is hidden by the current view
  for (const sp of [null, ...S.map.spaces.map(x => x.id)]) {
    const n = rooms.filter(r => spaceOf(r) === sp).length;
    if (sp && !n) { h += `<div class="stathdr">${escapeHtml(spaceName(sp))}</div><div class="statrow"><span>(empty)</span><span class="val">0</span></div>`; continue; }
    h += `<div class="stathdr">${nSpaces ? escapeHtml(spaceName(sp)) : "Rooms per layer"}</div>`;
    for (const z of layersPresent(sp)) h += `<div class="statrow"><span>${escapeHtml(layerName(z, sp))}</span><span class="val">${roomsOnLayer(z, sp).length}</span></div>`;
  }
  const tagged = PALETTE.filter(p => cc[p.name] > 0);
  if (tagged.length) {
    h += `<div class="stathdr">By colour tag</div>`;
    for (const p of tagged) {
      const lbl = S.map.tagLabels[p.name] || p.name;
      h += `<div class="statrow"><span><span class="dot" style="background:${p.c}"></span>${escapeHtml(lbl)}</span><span class="val">${cc[p.name]}</span></div>`;
    }
  }
  if (S.map.areas.length) {
    h += `<div class="stathdr">Rooms per area</div>`;
    for (const ar of S.map.areas) h += `<div class="statrow"><span><span class="dot" style="background:${areaHex(ar)}"></span>${escapeHtml(ar.name)}</span><span class="val">${roomsInArea(ar)}</span></div>`;
  }
  const tc = traitCounts();
  const usedTraits = S.map.traits.filter(t => tc[t.id] > 0);
  if (usedTraits.length) {
    h += `<div class="stathdr">By trait</div>`;
    for (const t of usedTraits) h += `<div class="statrow"><span>${t.emoji} ${escapeHtml(t.label)}</span><span class="val">${tc[t.id]}</span></div>`;
  }
  if (S.map.transitLines.length) {
    const totalStops = S.map.transitLines.reduce((n, l) => n + l.stations.length, 0);
    h += `<div class="stathdr">Transit</div>`;
    h += `<div class="statline">${plur(S.map.transitLines.length, "line")} · ${plur(totalStops, "stop")}</div>`;
    for (const l of S.map.transitLines) h += `<div class="statrow"><span><span class="dot" style="background:${areaHex(l)}"></span>${escapeHtml(l.name)}</span><span class="val">${l.stations.length}</span></div>`;
  }
  el.innerHTML = h;
}
