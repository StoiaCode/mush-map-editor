import { DIRWORD, VEC } from "./constants.js";
import { S, viewport } from "./state.js";
import { escapeHtml, clamp } from "./utils.js";
import { spaceOf, curSpace, roomAtCell } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { centerOnRoom, roomWorldCenter } from "./render-flat.js";
import { setSpace, toast, roomLocation } from "./spaces.js";
import { positionPopover } from "./toolbar.js";
import { gotoRoom } from "./inspector.js";
import { computePath } from "./search-path.js";

// ---------- Live link to the MUSH web client ----------
// The MUSH client is another site, so this page can't touch it. The bridge userscript
// (userscript/mush-mapper-bridge.user.js) runs on both pages and relays through its own storage:
//   bridge → page  {mm:"bridge", type:"hello"}               userscript is installed
//                  {mm:"bridge", type:"client"}              the MUSH tab answered a ping
//                  {mm:"bridge", type:"move", dir, name}     MUSH printed "You move <dir> to <name>."
//   page → bridge  {mm:"page", type:"probe"}                 ask for a hello
//                  {mm:"page", type:"send", cmds:[...]}      type these into the MUSH client
// All the logic (where you are, what to send next) lives here so it updates with the site;
// the userscript only moves messages around.
//
// Position: follow the reported direction along the map's exits. The direction is what the game
// actually did, the room name is only a cross-check, since mapped names can be stale.
//
// Walking: the game only queues 5 moves, so keep at most L.window commands in flight and top up
// as each "You move" arrives. Stop on a direction that isn't the next step (locked door, manual
// move, wrong start) or when nothing has moved for L.stallSec.

const LIVE_KEY = "mushMapEditor.live.v1";
const CLIENT_STALE_MS = 15000;   // the bridge pings every 5s
const DIR_OF = Object.fromEntries(Object.entries(DIRWORD).map(([k, w]) => [w, k]));

const L = {
  bridge: false,      // userscript answered on this page
  clientAt: 0,        // last time the MUSH tab answered a ping
  follow: true,       // keep the view on your position
  window: 5,          // max commands queued in the game at once
  stallSec: 20,       // give up a walk after this long without a move
  seenName: null,     // name the MUSH gave for the current room, when it differs from the map's
};
let W = null;         // running walk: { steps:[{dir,toId}], sent, done, lastMove, note, timer }

export const liveBridge = () => L.bridge;
export const clientAlive = () => Date.now() - L.clientAt < CLIENT_STALE_MS;
export const walking = () => !!W;

function loadLive() {
  try {
    const o = JSON.parse(localStorage.getItem(LIVE_KEY) || "{}");
    S.here = o.here || null;
    L.follow = o.follow !== false;
    L.window = clamp(parseInt(o.window, 10) || 5, 1, 20);
    L.stallSec = clamp(parseInt(o.stallSec, 10) || 20, 5, 300);
  } catch (e) { /* private window etc: defaults are fine */ }
}
function saveLive() {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify({ here: S.here, follow: L.follow, window: L.window, stallSec: L.stallSec })); }
  catch (e) { /* ignore */ }
}
function post(type, data = {}) { window.postMessage({ mm: "page", type, ...data }, location.origin); }

// ---------- Position ----------
const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
export function hereRoom() { return S.here ? S.map.rooms[S.here] || null : null; }

function neighbourCell(r, dir) {
  if (dir === "UP" || dir === "DOWN") return roomAtCell(r.z + (dir === "UP" ? 1 : -1), r.x, r.y, spaceOf(r));
  const [dx, dy] = VEC[dir];
  return roomAtCell(r.z, r.x + dx, r.y + dy, spaceOf(r));
}
// Where did "You move <dir> to <name>" put us? Most to least trusted:
//   the mapped exit, when its name agrees → a room in that cell with that name (exit not linked
//   yet) → the only room anywhere with that name (we were tracking the wrong room) → the mapped
//   exit anyway (its name is probably just out of date) → lost.
export function resolveMove(from, dir, name) {
  const want = norm(name);
  const viaExit = from && dir ? S.map.rooms[from.exits[dir]] || null : null;
  if (viaExit && norm(viaExit.name) === want) return viaExit;
  const cell = from && dir ? neighbourCell(from, dir) : null;
  if (cell && norm(cell.name) === want) return cell;
  const byName = Object.values(S.map.rooms).filter(r => norm(r.name) === want);
  if (byName.length === 1) return byName[0];
  if (viaExit) return viaExit;
  return null;
}
export function setHere(id, seenName) {
  S.here = id && S.map.rooms[id] ? id : null;
  const r = hereRoom();
  L.seenName = r && seenName && norm(seenName) !== norm(r.name) ? seenName : null;
  saveLive();
  if (r && L.follow) followTo(r);
  render();
  refreshLivePanel();
}
// Switch to the room's space/layer if needed, and re-centre only when it's near the edge,
// so the map doesn't jerk on every single step.
function followTo(r) {
  if (S.capture || S.view !== "flat") return;
  if (spaceOf(r) !== curSpace() || r.z !== S.map.currentLayer) {
    if (!setSpace(spaceOf(r), r.z)) return;
    render(); centerOnRoom(r); return;
  }
  const rect = viewport.getBoundingClientRect(), c = roomWorldCenter(r);
  const sx = c.x * S.scale + S.panX, sy = c.y * S.scale + S.panY;
  const mx = rect.width * 0.2, my = rect.height * 0.2;
  if (sx < mx || sx > rect.width - mx || sy < my || sy > rect.height - my) centerOnRoom(r);
}

function onMove(word, name) {
  const dir = DIR_OF[(word || "").toLowerCase()] || null;
  if (W) {
    const exp = W.steps[W.done];
    if (dir !== exp.dir) {
      stopWalk(`Expected <b>${DIRWORD[exp.dir]}</b> but you moved <b>${escapeHtml(word)}</b>.`);
    } else {
      W.done++; W.lastMove = Date.now();
      setHere(exp.toId, name);   // the route's room is the mapped exit we meant to take
      if (W.done === W.steps.length) finishWalk(); else pump();
      updateChip();
      return;
    }
  }
  const to = resolveMove(hereRoom(), dir, name);
  if (!to && S.here) toast(`📍 Lost: “${escapeHtml(name)}” isn't on the map (or not uniquely). Select it and press 📍 I'm here.`);
  setHere(to ? to.id : null, name);
}

// ---------- Walking a route ----------
// res is a findPath() result. Walks the leading walk steps; a train leg ends the walk with a note.
export function startWalk(res) {
  if (W) stopWalk(null);
  const steps = [];
  let note = null;
  for (let i = 0; i < res.steps.length; i++) {
    const s = res.steps[i];
    if (s.type === "train") { note = `Board the <b>${escapeHtml(s.lineName)}</b> to ${escapeHtml(S.map.rooms[s.toId].name)}.`; break; }
    steps.push({ dir: s.dir, toId: res.rooms[i + 1] });
  }
  if (!steps.length) { toast(note || "Nothing to walk."); return; }
  if (!clientAlive()) { toast("📡 No MUSH tab answering. Open (or click into) the MUSH client tab first."); return; }
  setHere(res.rooms[0]);   // you start the walk at the route's start
  W = { steps, sent: 0, done: 0, lastMove: Date.now(), note, timer: null };
  W.timer = setInterval(() => {
    if (W && W.sent > W.done && Date.now() - W.lastMove > L.stallSec * 1000)
      stopWalk(`No movement for ${L.stallSec}s (locked door, blocked, or you stopped?).`);
  }, 1000);
  pump();
  updateChip(); refreshLivePanel();
}
function pump() {
  const n = Math.min(L.window - (W.sent - W.done), W.steps.length - W.sent);
  if (n <= 0) return;
  post("send", { cmds: W.steps.slice(W.sent, W.sent + n).map(s => DIRWORD[s.dir]) });
  W.sent += n;
}
function finishWalk() {
  const dest = S.map.rooms[W.steps[W.steps.length - 1].toId];
  const note = W.note;
  clearInterval(W.timer); W = null;
  toast(`🏁 Arrived at <b>${escapeHtml(dest ? dest.name : "?")}</b>.` + (note ? " " + note : ""));
  walkEnded();
}
// why = null: replaced by a new walk, say nothing.
export function stopWalk(why) {
  if (!W) return;
  const queued = W.sent - W.done, left = W.steps.length - W.done;
  clearInterval(W.timer); W = null;
  if (why !== null) {
    toast(`⏹ Walk stopped. ${why || ""} ${left} step${left !== 1 ? "s" : ""} left` +
      (queued ? `, up to ${queued} still queued in the game.` : "."));
  }
  walkEnded();
}
// the route box shows Walk/Stop, so redraw it if it's open
function walkEnded() {
  updateChip(); refreshLivePanel();
  const box = document.getElementById("pathResult");
  if (S.pathLast && box.style.display === "block" && document.getElementById("pathStop"))
    computePath(S.pathLast.startId, S.pathLast.endId);
}

// ---------- Toolbar chip + panel ----------
function updateChip() {
  const btn = document.getElementById("liveBtn");
  if (!btn) return;
  btn.style.display = L.bridge ? "" : "none";
  const alive = clientAlive();
  btn.classList.toggle("live-on", alive);
  btn.textContent = W ? `🚶 ${W.done}/${W.steps.length}` : alive ? "📡 Live" : "📡 No MUSH tab";
  btn.title = W ? "Walking a route. Click for details or to stop." :
    alive ? "Linked to the MUSH client: following your position." :
    "The bridge userscript is installed, but no MUSH client tab is answering. Open the client, or click into it.";
}
export function refreshLivePanel() {
  const panel = document.getElementById("livePanel");
  if (!panel || panel.style.display !== "block") return;
  if (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // don't eat a half-typed number
  buildLivePanel();
}
function buildLivePanel() {
  const body = document.getElementById("liveBody");
  const r = hereRoom();
  let h = `<div class="liverow">${clientAlive() ? `<span class="livedot on"></span>MUSH tab connected` : `<span class="livedot"></span>No MUSH tab answering`}</div>`;
  h += `<div class="liverow"><b>📍 You are:</b> ` + (r
    ? `<button class="linkish" id="liveGoto">${escapeHtml(r.name)}</button> <span class="hint">${escapeHtml(roomLocation(r))}</span>`
    : `<span class="hint">unknown. Select your room and press <b>📍 I'm here</b> in the inspector, or just walk somewhere with a unique name.</span>`) + `</div>`;
  if (r && L.seenName) {
    h += `<div class="liverow livewarn">The MUSH calls this room “${escapeHtml(L.seenName)}”.
      <button id="liveRename">Rename the tile</button></div>`;
  }
  if (W) {
    const dest = S.map.rooms[W.steps[W.steps.length - 1].toId];
    h += `<div class="liverow"><b>🚶 Walking</b> to ${escapeHtml(dest ? dest.name : "?")}: ${W.done}/${W.steps.length} steps
      <button class="danger" id="liveStop">■ Stop</button></div>`;
  }
  h += `<label class="poprow"><input type="checkbox" id="liveFollow"${L.follow ? " checked" : ""}> Keep the map on my position</label>
    <label class="poprow">Moves queued at once <input type="number" id="liveWindow" min="1" max="20" value="${L.window}"></label>
    <label class="poprow">Stop a walk after <input type="number" id="liveStall" min="5" max="300" value="${L.stallSec}"> s without moving</label>`;
  if (r) h += `<button id="liveForget" style="width:100%;margin-top:6px;">Forget my position</button>`;
  body.innerHTML = h;
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
  on("liveGoto", "onclick", () => gotoRoom(r.id));
  on("liveRename", "onclick", () => { r.name = L.seenName; L.seenName = null; commit(); render(); buildLivePanel(); });
  on("liveStop", "onclick", () => stopWalk("Stopped by you."));
  on("liveFollow", "onchange", e => { L.follow = e.target.checked; saveLive(); if (L.follow && r) followTo(r); });
  on("liveWindow", "onchange", e => { L.window = clamp(parseInt(e.target.value, 10) || 5, 1, 20); e.target.value = L.window; saveLive(); });
  on("liveStall", "onchange", e => { L.stallSec = clamp(parseInt(e.target.value, 10) || 20, 5, 300); e.target.value = L.stallSec; saveLive(); });
  on("liveForget", "onclick", () => setHere(null));
}
document.getElementById("liveBtn").onclick = () => {
  const panel = document.getElementById("livePanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  buildLivePanel();
  positionPopover(panel, document.getElementById("liveBtn"));
};

// ---------- Install offer ----------
// Only for people who already run userscripts: PbN Compass Tools (from the PbN scripts repo) marks
// this page with data-pbn-scripts. Websites can't see installed extensions, so a running script is
// the only honest signal. Everyone else never sees any of this.
const OFFER_KEY = "mushMapEditor.bridgeOffer.v1";
const BRIDGE_URL = "userscript/mush-mapper-bridge.user.js";
function maybeOffer() {
  const box = document.getElementById("bridgeOffer");
  if (L.bridge || document.documentElement.dataset.pbnScripts !== "1") { box.style.display = "none"; return; }
  try { if (localStorage.getItem(OFFER_KEY)) return; } catch (e) { /* no storage: offer anyway */ }
  box.innerHTML = `<div class="bo-text"><b>🗺 Map link for Philadelphia by Night</b><br>
      Since you use PbN userscripts: this one lets the map follow you around in the client
      and walk routes for you.</div>
    <div class="bo-btns"><a class="bo-install" href="${BRIDGE_URL}" target="_blank" rel="noopener">Install map link</a>
      <button id="boNo">No thanks</button></div>`;
  box.style.display = "";
  box.querySelector(".bo-install").onclick = () => { box.style.display = "none"; };
  document.getElementById("boNo").onclick = () => {
    try { localStorage.setItem(OFFER_KEY, "dismissed"); } catch (e) { /* ignore */ }
    box.style.display = "none";
  };
}
// the userscripts run at document-idle, after this module: give them a moment to show up
setTimeout(maybeOffer, 3000);

// ---------- Wiring ----------
window.addEventListener("message", e => {
  if (e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.mm !== "bridge") return;
  if (m.type === "hello") {
    const first = !L.bridge;
    L.bridge = true;
    updateChip();
    document.getElementById("bridgeOffer").style.display = "none";
    if (first) render();   // the inspector and path box grow live buttons
  } else if (m.type === "client") {
    L.clientAt = Date.now();
    updateChip(); refreshLivePanel();
  } else if (m.type === "move" && S.map) {
    onMove(String(m.dir || ""), String(m.name || ""));
  }
});
setInterval(() => { if (L.bridge) { updateChip(); refreshLivePanel(); } }, 5000);   // notice a closed MUSH tab
loadLive();
post("probe");
