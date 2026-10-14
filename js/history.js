import { CELL, WORLD } from "./constants.js";
import { S, world, viewport } from "./state.js";
import { escapeHtml, escapeAttr } from "./utils.js";
import { curSpace } from "./model.js";
import { render } from "./app.js";
import { setSpace, toast } from "./spaces.js";
import { centerOnRoom, setFlatOverlay } from "./render-flat.js";
import { project3d, room3dWorld, render3d, setOverlay3d } from "./render-3d.js";

// ---------- History: where your characters went, replayed (live.js) ----------
// Every position change the live link sees is recorded as { t: ms, c: character, r: room }, per
// browser in IndexedDB (separate from the map: not in sync or map exports; has its own
// export/import). Rooms are kept in a table with a snapshot of where they were, so a room you
// later move is drawn where it is now, and a deleted one where it last was.
// Playback runs on "virtual time": gaps longer than GAP_MS (you weren't playing) shrink to
// GAP_V, so a replay isn't mostly empty. Only for bridge users: nothing records without it.

const DB_NAME = "mushMapEditor.history", DB_VER = 1;
const GAP_MS = 10 * 60e3, GAP_V = 30e3;
const COLORS = ["#3ddc84", "#5b9dff", "#e8943a", "#e87cc4", "#e8c93a", "#a87ce8", "#3cc4b8", "#e25555"];
const SPEEDS = [["1 min/s", 60e3], ["10 min/s", 600e3], ["1 h/s", 3600e3], ["6 h/s", 21600e3]];
const TRAILS = [["10 min", 600e3], ["1 hour", 3600e3], ["6 hours", 21600e3], ["1 day", 864e5], ["All", Infinity]];
const FRAME_MS = 60;

const H = {
  db: null, ready: false, failed: false,
  chars: [],             // [{ i, name, color, hidden }]
  rooms: [],             // [{ i, id, name, space, z, x, y }] snapshot as last recorded
  roomIdx: new Map(),    // room id -> i
  events: [],            // [{ t, c, r }] in time order
  last: {},              // char i -> last room id, so standing still isn't recorded
  char: null,            // character the bridge says is playing
};

// ---------- IndexedDB ----------
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("events", { autoIncrement: true });
      db.createObjectStore("rooms", { keyPath: "i" });
      db.createObjectStore("chars", { keyPath: "i" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (name, mode = "readonly") => H.db.transaction(name, mode).objectStore(name);
function put(name, value) { try { store(name, "readwrite").put(value); } catch (e) { /* quota etc.: keep going in memory */ } }

async function init() {
  try {
    H.db = await openDb();
    const [chars, rooms, events] = await Promise.all(
      ["chars", "rooms", "events"].map(n => req(store(n).getAll())));
    H.chars = chars.sort((a, b) => a.i - b.i);
    H.rooms = rooms.sort((a, b) => a.i - b.i);
    for (const rm of H.rooms) H.roomIdx.set(rm.id, rm.i);
    H.events = events.sort((a, b) => a.t - b.t);
    for (const e of H.events) H.last[e.c] = H.rooms[e.r] && H.rooms[e.r].id;
    H.ready = true;
  } catch (e) {
    H.failed = true;   // private window or blocked storage: history just stays off
  }
  onChange();
}
init();

let onChange = () => {};
export function onHistoryChange(fn) { onChange = fn; }

// ---------- Recording ----------
export function setCharacter(name) {
  name = (name || "").trim();
  if (!name || name === H.char) return;
  H.char = name;
  onChange();
}
export function currentCharacter() { return H.char; }

function charIdx(name, color) {
  let c = H.chars.find(ch => ch.name === name);
  if (!c) {
    c = { i: H.chars.length, name, color: color || COLORS[H.chars.length % COLORS.length], hidden: false };
    H.chars.push(c);
    put("chars", c);
  }
  return c.i;
}
function snap(room) {
  return { id: room.id, name: room.name, space: room.space || null, z: room.z, x: room.x, y: room.y };
}
function roomIdx(room) {
  const s = snap(room);
  let i = H.roomIdx.get(room.id);
  if (i === undefined) {
    i = H.rooms.length;
    H.rooms.push({ i, ...s });
    H.roomIdx.set(room.id, i);
    put("rooms", H.rooms[i]);
  } else {
    const old = H.rooms[i];
    if (old.name !== s.name || old.space !== s.space || old.z !== s.z || old.x !== s.x || old.y !== s.y) {
      Object.assign(old, s);
      put("rooms", old);
    }
  }
  return i;
}
// Called by live.js whenever the position changes.
export function recordMove(roomId) {
  if (!H.ready || !H.char) return;
  const room = S.map.rooms[roomId];
  if (!room) return;
  const c = charIdx(H.char);
  if (H.last[c] === roomId) return;
  H.last[c] = roomId;
  const ev = { t: Date.now(), c, r: roomIdx(room) };
  H.events.push(ev);
  try { store("events", "readwrite").add(ev); } catch (e) { /* ignore */ }
  T = null;
  if (P.open) { buildBar(); }
  onChange();
}

// ---------- Export / import ----------
function exportHistory() {
  const data = {
    format: "mush-mapper-history", version: 1, exported: new Date().toISOString(),
    chars: H.chars.map(c => ({ name: c.name, color: c.color })),
    rooms: H.rooms.map(({ id, name, space, z, x, y }) => ({ id, name, space, z, x, y })),
    events: H.events.map(e => [e.t, e.c, e.r]),
  };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mush-mapper-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Merges into what's here: characters by name, rooms by id, steps already present skipped.
async function importHistory(obj) {
  if (!obj || obj.format !== "mush-mapper-history" || !Array.isArray(obj.events) ||
      !Array.isArray(obj.chars) || !Array.isArray(obj.rooms)) throw new Error("not a MUSH Mapper history file");
  const charMap = obj.chars.map(ch => charIdx(String(ch.name), ch.color));
  const roomMap = obj.rooms.map(rm => {
    let i = H.roomIdx.get(rm.id);
    if (i === undefined) {
      i = H.rooms.length;
      H.rooms.push({ i, id: rm.id, name: rm.name, space: rm.space || null, z: rm.z, x: rm.x, y: rm.y });
      H.roomIdx.set(rm.id, i);
      put("rooms", H.rooms[i]);
    }
    return i;
  });
  const seen = new Set(H.events.map(e => e.t + "|" + e.c));
  const add = [];
  for (const row of obj.events) {
    if (!Array.isArray(row)) continue;
    const ev = { t: +row[0], c: charMap[row[1]], r: roomMap[row[2]] };
    if (!Number.isFinite(ev.t) || ev.c === undefined || ev.r === undefined) continue;
    const k = ev.t + "|" + ev.c;
    if (seen.has(k)) continue;
    seen.add(k); add.push(ev);
  }
  if (add.length) {
    const st = store("events", "readwrite");
    for (const ev of add) st.add(ev);
    H.events.push(...add);
    H.events.sort((a, b) => a.t - b.t);
    H.last = {};
    for (const e of H.events) H.last[e.c] = H.rooms[e.r].id;
  }
  T = null;
  return add.length;
}

// ---------- Timeline ----------
let T = null;   // { evs, vs, end }: visible characters' steps and their virtual times
function timeline() {
  if (T) return T;
  const vis = new Set(H.chars.filter(c => !c.hidden).map(c => c.i));
  const evs = H.events.filter(e => vis.has(e.c));
  const vs = new Float64Array(evs.length);
  let v = 0;
  for (let i = 1; i < evs.length; i++) {
    const gap = evs[i].t - evs[i - 1].t;
    v += gap > GAP_MS ? GAP_V : gap;
    vs[i] = v;
  }
  T = { evs, vs, end: v };
  return T;
}
// last index with vs[i] <= V (-1 if none)
function idxAt(V) {
  const { vs } = timeline();
  let lo = 0, hi = vs.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (vs[mid] <= V) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// Where a recorded room is: where the map has it now, or where it last was if it's gone.
function posOf(r) {
  const s = H.rooms[r];
  if (!s) return null;
  const live = S.map.rooms[s.id];
  return live ? { x: live.x, y: live.y, z: live.z, space: live.space || null, name: live.name } : s;
}
// Everything to draw at virtual time V: per character its trail and where it is.
function frame(V) {
  const t = timeline();
  const end = idxAt(V);
  const span = TRAILS[P.trail][1];
  const trails = new Map(), cur = new Map();
  if (end < 0) return { trails, cur, end };
  let i0 = 0;
  if (span !== Infinity) { i0 = idxAt(V - span) + 1; }
  for (let i = i0; i <= end; i++) {
    const e = t.evs[i];
    if (!trails.has(e.c)) trails.set(e.c, []);
    trails.get(e.c).push({ r: e.r, v: t.vs[i] });
    cur.set(e.c, e.r);
  }
  // characters whose last step was before the trail window still stand somewhere
  const want = H.chars.filter(c => !c.hidden && !cur.has(c.i)).length;
  for (let i = i0 - 1, found = 0; i >= 0 && found < want; i--) {
    const e = t.evs[i];
    if (!cur.has(e.c)) { cur.set(e.c, e.r); found++; }
  }
  return { trails, cur, end };
}

// ---------- Playback state & bar ----------
const P = { open: false, playing: false, V: 0, speed: 1, trail: 1, heat: false, follow: null, raf: 0, lastTs: 0, lastDraw: 0 };

export function historyOpen() { return P.open; }
let hooked = false;
export function openHistory() {
  if (!H.ready || !H.events.length) { toast("No history recorded yet."); return; }
  // hook into the renderers on first use, not at import: the modules import each other in a loop
  if (!hooked) { setFlatOverlay(drawFlat); setOverlay3d(draw3d); hooked = true; }
  P.open = true;
  T = null;
  P.V = timeline().end;   // start at "now"; play restarts from the beginning
  document.getElementById("app").classList.add("history-open");
  buildBar();
  redraw();
}
export function closeHistory() {
  P.open = false; P.playing = false;
  cancelAnimationFrame(P.raf);
  document.getElementById("app").classList.remove("history-open");
  document.getElementById("historyBar").style.display = "none";
  if (svgEl) { svgEl.innerHTML = ""; heatEl.innerHTML = ""; }
  if (S.view === "3d") render3d();
}

const fmtTime = t => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
function buildBar() {
  const bar = document.getElementById("historyBar");
  const t = timeline();
  bar.style.display = "";
  bar.innerHTML = `
    <div class="hb-row">
      <button class="iconbtn" id="hbStart" title="Back to the beginning">⏮</button>
      <button class="iconbtn" id="hbPlay" title="Play / pause">${P.playing ? "⏸" : "▶"}</button>
      <input type="range" id="hbScrub" min="0" max="${Math.max(1, t.end)}" step="1" value="${Math.min(P.V, t.end)}">
      <span class="hb-time" id="hbTime"></span>
      <select id="hbSpeed" title="Playback speed">${SPEEDS.map((s, i) => `<option value="${i}"${i === P.speed ? " selected" : ""}>${s[0]}</option>`).join("")}</select>
      <select id="hbTrail" title="Trail length">${TRAILS.map((s, i) => `<option value="${i}"${i === P.trail ? " selected" : ""}>trail ${s[0]}</option>`).join("")}</select>
      <button id="hbHeat" class="${P.heat ? "active" : ""}" title="Heatmap: tint rooms by how often they were visited, up to this moment">🔥</button>
      <button class="iconbtn" id="hbClose" title="Close history">✕</button>
    </div>
    <div class="hb-chars">${H.chars.map(c => `
      <span class="hb-char${c.hidden ? " off" : ""}" data-c="${c.i}">
        <input type="color" value="${escapeAttr(c.color)}" title="Colour">
        <span class="hb-name">${escapeHtml(c.name)}</span>
        <button data-act="eye" title="${c.hidden ? "Show" : "Hide"}">${c.hidden ? "◌" : "●"}</button>
        <button data-act="follow" class="${P.follow === c.i ? "active" : ""}" title="Follow on the map">⌖</button>
      </span>`).join("")}
      <span class="hb-count">${t.evs.length.toLocaleString()} steps</span>
    </div>`;
  const $ = id => document.getElementById(id);
  $("hbPlay").onclick = () => togglePlay();
  $("hbStart").onclick = () => { P.V = 0; redraw(); };
  $("hbScrub").oninput = e => { P.V = +e.target.value; redraw(); };
  $("hbSpeed").onchange = e => { P.speed = +e.target.value; };
  $("hbTrail").onchange = e => { P.trail = +e.target.value; redraw(); };
  $("hbHeat").onclick = () => { P.heat = !P.heat; buildBar(); redraw(); };
  $("hbClose").onclick = closeHistory;
  bar.querySelectorAll(".hb-char").forEach(el => {
    const c = H.chars[+el.dataset.c];
    el.querySelector('input[type="color"]').oninput = e => { c.color = e.target.value; put("chars", c); redraw(); };
    el.querySelector('[data-act="eye"]').onclick = () => {
      c.hidden = !c.hidden; put("chars", c);
      if (c.hidden && P.follow === c.i) P.follow = null;
      T = null; P.V = Math.min(P.V, timeline().end);
      buildBar(); redraw();
    };
    el.querySelector('[data-act="follow"]').onclick = () => { P.follow = P.follow === c.i ? null : c.i; buildBar(); redraw(); };
  });
  bar.onmousedown = e => e.stopPropagation();
  updateTime();
}
function updateTime() {
  const t = timeline(), i = idxAt(P.V);
  const el = document.getElementById("hbTime");
  if (el) el.textContent = t.evs.length ? fmtTime(t.evs[Math.max(0, i)].t) : "";
  const sc = document.getElementById("hbScrub");
  if (sc && +sc.value !== Math.round(P.V)) sc.value = P.V;
}
function togglePlay() {
  const end = timeline().end;
  if (!P.playing && P.V >= end) P.V = 0;   // at the end: play from the start
  P.playing = !P.playing;
  P.lastTs = 0;
  document.getElementById("hbPlay").textContent = P.playing ? "⏸" : "▶";
  if (P.playing) P.raf = requestAnimationFrame(tick);
}
function tick(ts) {
  if (!P.playing || !P.open) return;
  const dt = P.lastTs ? ts - P.lastTs : 0;
  P.lastTs = ts;
  const end = timeline().end;
  P.V = Math.min(end, P.V + dt / 1000 * SPEEDS[P.speed][1]);
  if (P.V >= end) {
    P.playing = false;
    document.getElementById("hbPlay").textContent = "▶";
  }
  if (ts - P.lastDraw > FRAME_MS || !P.playing) { P.lastDraw = ts; redraw(); }
  if (P.playing) P.raf = requestAnimationFrame(tick);
}
function redraw() {
  if (!P.open) return;
  updateTime();
  follow();
  if (S.view === "flat") drawFlat(); else render3d();
}
// keep the followed character in view: switch space/layer, re-centre near the edge
function follow() {
  if (P.follow === null) return;
  const f = frame(P.V);
  const r = f.cur.get(P.follow);
  const pos = r !== undefined && posOf(r);
  if (!pos || S.view !== "flat" || S.capture) return;
  if ((pos.space || null) !== curSpace() || pos.z !== S.map.currentLayer) {
    if (setSpace(pos.space, pos.z)) { render(); centerOnRoom(pos); }
    return;
  }
  const rect = viewport.getBoundingClientRect();
  const sx = (pos.x * CELL + CELL / 2) * S.scale + S.panX, sy = (pos.y * CELL + CELL / 2) * S.scale + S.panY;
  if (sx < rect.width * 0.2 || sx > rect.width * 0.8 || sy < rect.height * 0.2 || sy > rect.height * 0.8) centerOnRoom(pos);
}

// ---------- Drawing: 2D ----------
// Two layers: the heatmap glows under the room tiles, trails and dots sit on top of them.
let svgEl = null, heatEl = null;
const NS = "http://www.w3.org/2000/svg";
function layer(id) {
  const el = document.createElementNS(NS, "svg");
  el.id = id; el.classList.add("histsvg");
  el.setAttribute("width", WORLD); el.setAttribute("height", WORLD);
  return el;
}
function drawFlat() {
  if (!P.open || S.view !== "flat") { if (svgEl) { svgEl.innerHTML = ""; heatEl.innerHTML = ""; } return; }
  if (!svgEl) { svgEl = layer("histlayer"); heatEl = layer("histheat"); }
  world.appendChild(svgEl);   // above the room tiles
  const firstRoom = world.querySelector(".room");
  world.insertBefore(heatEl, firstRoom);   // below them
  const z = S.map.currentLayer, sp = curSpace();
  const here = pos => pos && pos.z === z && (pos.space || null) === sp;
  const cx = pos => pos.x * CELL + CELL / 2, cy = pos => pos.y * CELL + CELL / 2;
  const f = frame(P.V);
  const span = TRAILS[P.trail][1];
  let h = "", heat = "";
  if (P.heat && f.end >= 0) {
    const counts = new Map(), evs = timeline().evs;
    for (let i = 0; i <= f.end; i++) counts.set(evs[i].r, (counts.get(evs[i].r) || 0) + 1);
    const max = Math.max(...counts.values());
    for (const [r, n] of counts) {
      const pos = posOf(r);
      if (!here(pos)) continue;
      const k = Math.log(1 + n) / Math.log(1 + max);
      heat += `<circle cx="${cx(pos)}" cy="${cy(pos)}" r="${34 + 14 * k}" fill="#e8943a" opacity="${(0.15 + 0.6 * k).toFixed(2)}"/>`;
    }
  }
  for (const [c, list] of f.trails) {
    const ch = H.chars[c];
    for (let i = 1; i < list.length; i++) {
      const a = posOf(list[i - 1].r), b = posOf(list[i].r);
      if (!here(a) || !here(b)) continue;
      const age = span === Infinity ? 0.4 : (P.V - list[i].v) / span;
      h += `<line x1="${cx(a)}" y1="${cy(a)}" x2="${cx(b)}" y2="${cy(b)}" stroke="${ch.color}" stroke-width="5" stroke-linecap="round" opacity="${Math.max(0.12, 1 - age).toFixed(2)}"/>`;
    }
  }
  for (const [c, r] of f.cur) {
    const ch = H.chars[c], pos = posOf(r);
    if (!here(pos)) continue;
    h += `<circle cx="${cx(pos)}" cy="${cy(pos)}" r="13" fill="${ch.color}" stroke="#fff" stroke-width="3"/>` +
      `<text x="${cx(pos)}" y="${cy(pos) - 22}" class="histname" fill="${ch.color}">${escapeHtml(ch.name)}</text>`;
  }
  svgEl.innerHTML = h;
  heatEl.innerHTML = heat;
}

// ---------- Drawing: 3D ----------
function draw3d(ctx) {
  if (!P.open) return;
  const sp = curSpace();
  const f = frame(P.V);
  const span = TRAILS[P.trail][1];
  const proj = pos => pos && (pos.space || null) === sp ? project3d(room3dWorld(pos)) : null;
  ctx.lineCap = "round";
  for (const [c, list] of f.trails) {
    const ch = H.chars[c];
    for (let i = 1; i < list.length; i++) {
      const a = proj(posOf(list[i - 1].r)), b = proj(posOf(list[i].r));
      if (!a || !b) continue;
      const age = span === Infinity ? 0.4 : (P.V - list[i].v) / span;
      ctx.globalAlpha = Math.max(0.12, 1 - age);
      ctx.strokeStyle = ch.color; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  for (const [c, r] of f.cur) {
    const ch = H.chars[c], p = proj(posOf(r));
    if (!p) continue;
    ctx.fillStyle = ch.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = "bold 12px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.fillStyle = ch.color;
    ctx.fillText(ch.name, p.sx, p.sy - 15);
  }
}

// ---------- Live panel section (live.js) ----------
export function historyHtml(bridgeV) {
  if (H.failed) return `<div class="livelabel livesettings">History</div><div class="livesub">This browser doesn't allow the storage History needs.</div>`;
  const n = H.events.length, nc = H.chars.length;
  return `<div class="livelabel livesettings">History</div>
    <div class="livesetting"><div><div>${n.toLocaleString()} step${n !== 1 ? "s" : ""} · ${nc} character${nc !== 1 ? "s" : ""}</div>
      <div class="livesub">${H.char ? `Recording ${escapeHtml(H.char)}` : "Update the bridge to start recording"}</div></div>
      <button class="livebtn primary" id="histOpen"${n ? "" : " disabled"}>Replay</button></div>
    <div class="histbtns"><button class="livebtn" id="histExport"${n ? "" : " disabled"}>Export</button>
      <button class="livebtn" id="histImport">Import…</button></div>`;
}
export function wireHistory() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("histOpen", () => { document.getElementById("livePanel").style.display = "none"; openHistory(); });
  on("histExport", exportHistory);
  on("histImport", () => document.getElementById("historyImportFile").click());
}
document.getElementById("historyImportFile").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !H.ready) return;
  try {
    const added = await importHistory(JSON.parse(await file.text()));
    toast(`📜 Imported ${added.toLocaleString()} new step${added !== 1 ? "s" : ""}.`);
    onChange();
    if (P.open) { buildBar(); redraw(); }
  } catch (err) {
    toast("Couldn't import that file: " + escapeHtml(err.message || String(err)));
  }
};
