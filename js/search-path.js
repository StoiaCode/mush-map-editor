import { DIRS, DIRWORD } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml, escapeAttr } from "./utils.js";
import { resolveStop } from "./model.js";
import { gotoRoom } from "./inspector.js";
import { render } from "./app.js";
import { setMode } from "./toolbar.js";

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
  el.textContent = n ? `${n} match${n !== 1 ? "es" : ""} · ↵ to jump` : "no matches";
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
export function findPath(startId, endId, allowFly, allowTrain) {
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
            const forward = j > i;
            // for a dual stop, you can only depart toward `forward` from the side matching that direction
            if (e && e.dual && (forward ? e.a !== cur : e.b !== cur)) continue;
            const t = resolveStop(stations[j], forward);
            if (!t || visited.has(t) || !S.map.rooms[t]) continue;
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
export function computePath(startId, endId) {
  S.pathLast = { startId, endId };
  // Trains are a last resort: only tried if no walk-only route exists at all (see model.js docs).
  let res = findPath(startId, endId, S.pathCanFly, false);
  if (!res) res = findPath(startId, endId, S.pathCanFly, true);
  const box = document.getElementById("pathResult");
  box.style.display = "block";
  const flyChk = `<label class="flychk"><input type="checkbox" id="pathFly"${S.pathCanFly ? " checked" : ""}> ✈ allow flight</label>`;
  if (!res) {
    S.pathRooms = new Set();
    box.innerHTML = `<div><b>No ${S.pathCanFly ? "" : "ground "}route</b> from “${escapeHtml(roomName(startId))}” to “${escapeHtml(roomName(endId))}”.</div>` +
      `<div>${flyChk}</div><button id="pathClose">✕ close</button>`;
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
      dirsHtml +
      `<div>${flyChk}</div>` +
      `<button id="pathClose">✕ clear</button>`;
  }
  document.getElementById("pathClose").onclick = clearPath;
  const fc = document.getElementById("pathFly");
  if (fc) fc.onchange = () => { S.pathCanFly = fc.checked; if (S.pathLast) computePath(S.pathLast.startId, S.pathLast.endId); };
  box.querySelectorAll(".pathcopy").forEach(b => {
    b.onclick = () => copyText(b.dataset.copy).then(() => {
      const prev = b.textContent; b.textContent = "✓";
      setTimeout(() => { b.textContent = prev; }, 1000);
    }).catch(() => {});
  });
  render();
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
    ? `<div>Start: <b>${escapeHtml(roomName(S.pathStart))}</b> — now click the destination (any layer).</div><button id="pathClose">✕ cancel</button>`
    : `<div>Pathfinder: click the <b>start</b> room.</div><button id="pathClose">✕ cancel</button>`;
  document.getElementById("pathClose").onclick = clearPath;
}
