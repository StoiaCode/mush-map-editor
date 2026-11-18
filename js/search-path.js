import { DIRS, DIRWORD } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml, escapeAttr } from "./utils.js";
import { resolveStop } from "./model.js";
import { gotoRoom } from "./inspector.js";
import { render } from "./app.js";
import { setMode } from "./toolbar.js";
import { spaceName, spaceColor } from "./spaces.js";
import { liveBridge, walking, startWalk, stopWalk } from "./live.js";

// ---------- Search ----------
export function runSearch(term) {
  S.searchTerm = term.trim().toLowerCase();
  S.searchIdx = -1;
  if (!S.searchTerm) {
    S.searchMatches = [];
  } else {
    S.searchMatches = Object.values(S.map.rooms).filter(r =>
      r.name.toLowerCase().includes(S.searchTerm) ||
      (r.description || "").toLowerCase().includes(S.searchTerm)
    ).map(r => r.id);
  }
  updateSearchInfo();
  render();
}
export function updateSearchInfo() {
  const el = document.getElementById("searchInfo");
  if (!S.searchTerm) { el.textContent = ""; return; }
  const n = S.searchMatches.length;
  // matches in other spaces aren't highlighted on screen, so say how many there are
  const here = S.map.currentSpace || null;
  const away = S.searchMatches.filter(id => (S.map.rooms[id].space || null) !== here).length;
  el.textContent = n ? `${n} match${n !== 1 ? "es" : ""}` + (away ? ` (${away} in other spaces)` : "") + " · ↵ to jump" : "no matches";
}
export function jumpNextMatch() {
  if (!S.searchMatches.length) return;
  S.searchIdx = (S.searchIdx + 1) % S.searchMatches.length;
  gotoRoom(S.searchMatches[S.searchIdx]);
}

// ---------- Pathfinder (BFS shortest path over the exit graph) ----------
export function roomName(id) { return S.map.rooms[id] ? S.map.rooms[id].name : "?"; }
// allowTrain: when true, BFS also treats "any two stations on the same transit line" as a
// single board-and-ride edge (see model.js lineConnects/stationLinesFor — lines are back-and-forth
// routes, so this models real all-pairs reachability, not an "adjacent stops only" shortcut).
// avoid: {lock, sewer}: never step INTO such a room on the way (the destination itself is fine).
export function findPath(startId, endId, allowFly, allowTrain, avoid = null) {
  const blocked = id => {
    if (!avoid || id === endId) return false;
    const r = S.map.rooms[id];
    return !!r && ((avoid.lock && (r.haven || r.lockable)) || (avoid.sewer && r.sewer));
  };
  if (startId === endId) return { steps: [], rooms: [startId] };
  const prev = new Map();           // roomId -> { from, type:'walk'|'train', dir, fly, lineId, lineName }
  const visited = new Set([startId]);
  const queue = [startId];
  const finish = (endId) => {
    const steps = [], rooms = [endId];
    let n = endId;
    while (n !== startId) {
      const p = prev.get(n);
      steps.unshift(p.type === "train"
        ? { type: "train", lineId: p.lineId, lineName: p.lineName, fromId: p.from, toId: n }
        : { type: "walk", dir: p.dir, fly: p.fly });
      rooms.unshift(p.from); n = p.from;
    }
    return { steps, rooms };
  };
  while (queue.length) {
    const cur = queue.shift();
    const room = S.map.rooms[cur];
    if (!room) continue;
    for (const dir of DIRS) {
      const t = room.exits[dir];
      if (!t || visited.has(t) || !S.map.rooms[t]) continue;
      const fly = !!(room.exitFly && room.exitFly[dir]);
      if (fly && !allowFly) continue;   // grounded: skip flight-only exits
      if (blocked(t)) continue;
      visited.add(t);
      prev.set(t, { from: cur, type: "walk", dir, fly });
      if (t === endId) return finish(endId);
      queue.push(t);
    }
    if (allowTrain) {
      for (const line of S.map.transitLines) {
        const stations = line.stations;
        // find every index where `cur` is boardable (a plain stop, or either side of a dual)
        for (let i = 0; i < stations.length; i++) {
          const e = stations[i];
          const boardableHere = typeof e === "string" ? e === cur : (e && e.dual && (e.a === cur || e.b === cur));
          if (!boardableHere) continue;
          for (let j = 0; j < stations.length; j++) {
            if (j === i) continue;
            // a loop line never travels "backward" — it only ever continues forward,
            // wrapping past the end back to the start
            const forward = line.loop ? true : j > i;
            // for a dual stop, you can only depart toward `forward` from the side matching that direction
            if (e && e.dual && (forward ? e.a !== cur : e.b !== cur)) continue;
            const t = resolveStop(stations[j], forward);
            if (!t || visited.has(t) || !S.map.rooms[t] || blocked(t)) continue;
            visited.add(t);
            prev.set(t, { from: cur, type: "train", lineId: line.id, lineName: line.name });
            if (t === endId) return finish(endId);
            queue.push(t);
          }
        }
      }
    }
  }
  return null;
}
// The route the route box and //goto use. Trains are a last resort: only tried if no walk-only
// route exists at all (see model.js docs). Like flight, going through havens/lockable rooms and
// sewers has to be allowed: opts {fly, lock, sewer}. Without, there's no route that way (routeHint
// says what would give one). Your start and destination may be such rooms.
try { localStorage.removeItem("mushMapEditor.route.v1"); } catch (e) { /* the old "avoid" switches */ }
export function bestRoute(startId, endId, opts = {}) {
  const avoid = { lock: !opts.lock, sewer: !opts.sewer };
  return findPath(startId, endId, !!opts.fly, false, avoid) || findPath(startId, endId, !!opts.fly, true, avoid);
}
// No route with `opts`: every smallest set of extra allowances that gives one ([["lock"], ["sewer"]],
// [["fly", "lock"]], ...), or null.
export function routeHint(startId, endId, opts = {}) {
  const off = ["fly", "lock", "sewer"].filter(k => !opts[k]);
  const sets = [];
  for (let n = 1; n <= off.length; n++)
    (function pick(from, chosen) {
      if (chosen.length === n) { sets.push(chosen); return; }
      for (let i = from; i < off.length; i++) pick(i + 1, [...chosen, off[i]]);
    })(0, []);
  const found = [];
  for (const extra of sets) {
    if (found.length && extra.length > found[0].length) break;
    const o = Object.assign({}, opts);
    for (const k of extra) o[k] = true;
    if (bestRoute(startId, endId, o)) found.push(extra);
  }
  return found.length ? found : null;
}
const HINT_WORD = { fly: "✈ flight", lock: "🔒 lockable rooms", sewer: "🕳 sewers" };
export function hintText(found) {
  return found.map(extra => extra.map(k => HINT_WORD[k]).join(" and ")).join(", or with ");
}
const routeOpts = () => ({ fly: S.pathCanFly, lock: S.pathLock, sewer: S.pathSewer });
// only offer a switch when the map has rooms it would matter for
function mapHas(kind) {
  return Object.values(S.map.rooms).some(r => kind === "lock" ? r.haven || r.lockable : r.sewer);
}
export function computePath(startId, endId) {
  S.pathLast = { startId, endId };
  const res = bestRoute(startId, endId, routeOpts());
  const box = document.getElementById("pathResult");
  box.style.display = "block";
  const flyChk = `<label class="flychk"><input type="checkbox" id="pathFly"${S.pathCanFly ? " checked" : ""}> ✈ allow flight</label>` +
    (mapHas("lock") || S.pathLock ? ` <label class="flychk" title="Off: routes go around havens and lockable rooms (your start and destination may be one)"><input type="checkbox" id="pathLock"${S.pathLock ? " checked" : ""}> 🔒 through lockable</label>` : "") +
    (mapHas("sewer") || S.pathSewer ? ` <label class="flychk" title="Off: routes stay out of the sewers (your start and destination may be one)"><input type="checkbox" id="pathSewer"${S.pathSewer ? " checked" : ""}> 🕳 through sewers</label>` : "");
  if (!res) {
    S.pathRooms = new Set();
    const hint = routeHint(startId, endId, routeOpts());
    box.innerHTML = `<div><b>No ${S.pathCanFly ? "" : "ground "}route</b> from “${escapeHtml(roomName(startId))}” to “${escapeHtml(roomName(endId))}”.</div>` +
      (hint ? `<div class="hint">There is one with ${escapeHtml(hintText(hint))}.</div>` : "") +
      `<div>${flyChk}</div>${reverseBtn(startId, endId)}<button id="pathClose">✕ close</button>`;
  } else {
    S.pathRooms = new Set(res.rooms);
    const flyCount = res.steps.filter(s => s.fly).length;
    const trainCount = res.steps.filter(s => s.type === "train").length;
    let dirsHtml;
    if (!res.steps.length) {
      dirsHtml = `<div class="pathdirs">(same room)</div>`;
    } else {
      // Split into runs: consecutive walk steps chunk into groups of 5 (queue max) as before;
      // each train step stands alone and breaks the chunking (boarding is a natural pause).
      const parts = []; let buf = [];
      for (const s of res.steps) {
        if (s.type === "train") { if (buf.length) { parts.push({ kind:"walk", steps:buf }); buf = []; } parts.push({ kind:"train", step:s }); }
        else buf.push(s);
      }
      if (buf.length) parts.push({ kind:"walk", steps:buf });
      dirsHtml = parts.map(part => {
        if (part.kind === "train") {
          const s = part.step;
          return `<div class="trainstep">🚆 Board the <b>${escapeHtml(s.lineName)}</b> at ${escapeHtml(roomName(s.fromId))}, ride to <b>${escapeHtml(roomName(s.toId))}</b></div>`;
        }
        const groups = [];
        for (let i = 0; i < part.steps.length; i += 5) groups.push(part.steps.slice(i, i + 5));
        return `<div class="pathdirs">` + groups.map((g, i) => {
          const plain = g.map(s => DIRWORD[s.dir]).join(" ");   // copied text stays plain words
          const shown = g.map(s => s.fly ? `<span class="flystep">${DIRWORD[s.dir]}</span>` : DIRWORD[s.dir]).join(" ");
          return (i > 0 ? `<span class="pathsep">|</span>` : "") +
            `<span class="pathgroup"><span class="pathwords">${shown}</span>` +
            `<button class="pathcopy" data-copy="${escapeAttr(plain)}" title="Copy these ${g.length} step${g.length !== 1 ? "s" : ""}">⧉</button></span>`;
        }).join("") + `</div>`;
      }).join("");
    }
    box.innerHTML =
      `<div><b>${escapeHtml(roomName(startId))}</b> → <b>${escapeHtml(roomName(endId))}</b> · ${res.steps.length} step${res.steps.length !== 1 ? "s" : ""}` +
        (flyCount ? ` · <span class="flystep" style="font-weight:700">${flyCount} flown</span>` : "") +
        (trainCount ? ` · <span class="trainstep" style="font-weight:700">${trainCount} train leg${trainCount !== 1 ? "s" : ""}</span>` : "") + `</div>` +
      dirsHtml + spacesHtml(res.rooms) + walkHtml(startId, res) +
      `<div>${flyChk}</div>` +
      reverseBtn(startId, endId) + `<button id="pathClose">✕ clear</button>`;
  }
  document.getElementById("pathClose").onclick = clearPath;
  const rb = document.getElementById("pathReverse");
  if (rb) rb.onclick = () => computePath(reverseFrom(startId, endId), startId);
  const wb = document.getElementById("pathWalk");
  if (wb) wb.onclick = () => { startWalk(res); computePath(startId, endId); };
  const sb = document.getElementById("pathStop");
  if (sb) sb.onclick = () => stopWalk("Stopped by you.");
  const fc = document.getElementById("pathFly");
  if (fc) fc.onchange = () => { S.pathCanFly = fc.checked; if (S.pathLast) computePath(S.pathLast.startId, S.pathLast.endId); };
  for (const key of ["pathLock", "pathSewer"]) {
    const el = document.getElementById(key);
    if (el) el.onchange = () => { S[key] = el.checked; if (S.pathLast) computePath(S.pathLast.startId, S.pathLast.endId); };
  }
  box.querySelectorAll(".pathleg").forEach(b => { b.onclick = () => gotoRoom(b.dataset.goto); });
  box.querySelectorAll(".pathcopy").forEach(b => {
    b.onclick = () => copyText(b.dataset.copy).then(() => {
      const prev = b.textContent; b.textContent = "✓";
      setTimeout(() => { b.textContent = prev; }, 1000);
    }).catch(() => {});
  });
  render();
}
// The way back to the start. It starts from where the live link puts you (you may have wandered
// off after arriving), or from the old destination when the position isn't known, or is still
// the start because you haven't set off yet.
function reverseFrom(startId, endId) {
  return S.here && S.map.rooms[S.here] && S.here !== startId ? S.here : endId;
}
function reverseBtn(startId, endId) {
  const from = reverseFrom(startId, endId);
  const where = from !== endId ? ` from where you are (${roomName(from)})` : ` from ${roomName(endId)}`;
  return `<button id="pathReverse" title="${escapeAttr("Route back to " + roomName(startId) + where)}">⇄ Reverse</button> `;
}
// "▶ Walk it" for the live link (live.js): types the route into the MUSH client 5 moves at a time.
function walkHtml(startId, res) {
  if (!liveBridge() || !res.steps.length) return "";
  if (walking()) return `<div class="pathwalk"><button id="pathStop" class="danger">■ Stop walking</button></div>`;
  const off = S.here && S.here !== startId && S.map.rooms[S.here];
  return `<div class="pathwalk">` +
    (off ? `<div class="hint">⚠ The live link thinks you're at <b>${escapeHtml(off.name)}</b>, not the start.</div>` : "") +
    `<button id="pathWalk" class="primary" title="Type this route into the MUSH client, a few moves at a time">▶ Walk it</button>` +
    (res.steps.some(s => s.type === "train") ? ` <span class="hint">rides the train too</span>` : "") +
    `</div>`;
}
// When a route crosses spaces, list the hand-offs ("Main map → ⧉ Highrise Apts") with each
// leg clickable, since only the part of the route in the viewed space is highlighted.
function spacesHtml(roomIds) {
  const legs = [];
  for (const id of roomIds) {
    const sp = S.map.rooms[id].space || null;
    if (!legs.length || legs[legs.length - 1].sp !== sp) legs.push({ sp, id });
  }
  if (legs.length < 2) return "";
  return `<div class="pathspaces">Crosses spaces: ` + legs.map(l =>
    `<button class="pathleg" data-goto="${escapeAttr(l.id)}" style="color:${spaceColor(l.sp)}">${l.sp ? "⧉ " : ""}${escapeHtml(spaceName(l.sp))}</button>`
  ).join(" → ") + `</div>`;
}
export function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return new Promise((res, rej) => {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); res(); } catch (e) { rej(e); } finally { ta.remove(); }
  });
}
export function clearPath() {
  S.pathRooms = new Set(); S.pathStart = null;
  document.getElementById("pathResult").style.display = "none";
  setMode("none");
  render();
}
export function setPathHint() {
  const box = document.getElementById("pathResult");
  if (!S.pathMode) return;
  box.style.display = "block";
  box.innerHTML = S.pathStart
    ? `<div>Start: <b>${escapeHtml(roomName(S.pathStart))}</b> — now click the destination (any layer or space).</div><button id="pathClose">✕ cancel</button>`
    : `<div>Pathfinder: click the <b>start</b> room.</div><button id="pathClose">✕ cancel</button>`;
  document.getElementById("pathClose").onclick = clearPath;
}
