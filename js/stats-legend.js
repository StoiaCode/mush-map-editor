import { PALETTE, DIRS } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml, areaHex } from "./utils.js";
import { roomsInArea, layersPresent, roomsOnLayer } from "./model.js";
import { save, commit } from "./persistence.js";
import { render } from "./app.js";

// ---------- Stats helpers ----------
export function colorCounts() {
  const c = {}; for (const p of PALETTE) c[p.name] = 0;
  for (const r of Object.values(S.map.rooms)) c[r.color] = (c[r.color] || 0) + 1;
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
  const layers = layersPresent();
  const cc = colorCounts();
  const plur = (n, w) => `<b>${n}</b> ${w}${n === 1 ? "" : "s"}`;
  let h = `<div class="statline">${plur(rooms.length,"room")} · ${plur(S.map.areas.length,"area")} · ${plur(layers.length,"layer")} · ${plur(connectionCount(),"connection")}</div>`;
  h += `<div class="stathdr">Rooms per layer</div>`;
  for (const z of layers) h += `<div class="statrow"><span>Layer ${z}</span><span class="val">${roomsOnLayer(z).length}</span></div>`;
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
  if (S.map.transitLines.length) {
    const totalStops = S.map.transitLines.reduce((n, l) => n + l.stations.length, 0);
    h += `<div class="stathdr">Transit</div>`;
    h += `<div class="statline">${plur(S.map.transitLines.length, "line")} · ${plur(totalStops, "stop")}</div>`;
    for (const l of S.map.transitLines) h += `<div class="statrow"><span><span class="dot" style="background:${areaHex(l)}"></span>${escapeHtml(l.name)}</span><span class="val">${l.stations.length}</span></div>`;
  }
  el.innerHTML = h;
}
