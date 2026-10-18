import { DIRWORD, VEC, COMPASS, GRID_N, OPP } from "./constants.js";
import { S, viewport } from "./state.js";
import { escapeHtml, clamp } from "./utils.js";
import { spaceOf, curSpace, roomAtCell, createRoom, deleteRoom } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { centerOnRoom, roomWorldCenter } from "./render-flat.js";
import { setSpace, toast, roomLocation } from "./spaces.js";
import { positionPopover } from "./toolbar.js";
import { gotoRoom } from "./inspector.js";
import { stationLinesFor } from "./model.js";
import { computePath, findPath } from "./search-path.js";
import { addGhosts, ghostCount, dismissedCount, clearGhosts, resetDismissed } from "./ghosts.js";
import { checkRoom, noteArrived, issueCount, issuesHtml, wireIssues, onIssuesChange } from "./issues.js";
import { onGather, gatherHtml } from "./gather.js";
import { setCharacter, currentCharacter, recordMove, historyHtml, wireHistory, onHistoryChange } from "./history.js";

// ---------- Live link to the MUSH web client ----------
// The MUSH client is another site, so this page can't touch it. The bridge userscript
// (userscript/mush-mapper-bridge.user.js) runs on both pages and relays through its own storage:
//   bridge → page  {mm:"bridge", type:"hello"}               userscript is installed
//                  {mm:"bridge", type:"client", char}        the MUSH tab answered a ping (char: who's playing)
//                  {mm:"bridge", type:"move", dir, name}     MUSH printed "You move <dir> to <name>."
//                  {mm:"bridge", type:"goto", q}             "//goto <q>" typed in the PbN client
//                  {mm:"bridge", type:"sys", text}           the game refused a move ("You can't go that way.")
//                  {mm:"bridge", type:"train", text}         a /train line (see Trains below)
//                  {mm:"bridge", type:"gather", text}        /scavenge or /harvest sent, or its result (gather.js)
//                  {mm:"bridge", type:"room", room}          the side panel caught up: {name, description,
//                                                            image, exits:{N:{name,locked,aerial}}, grid:{N:name}}
//   page → bridge  {mm:"page", type:"probe"}                 ask for a hello
//                  {mm:"page", type:"send", cmds:[...]}      type these into the MUSH client
//                  {mm:"page", type:"reply", lines:[...]}    show as a local [MAPPER] line in PbN's chat
// All the logic (where you are, what to send next) lives here so it updates with the site;
// the userscript only moves messages around.
//
// Position: follow the reported direction along the map's exits. The direction is what the game
// actually did, the room name is only a cross-check, since mapped names can be stale.
//
// Walking: the game takes a chain of up to 5 directions as ONE input ("north north east") and
// refuses inputs sent while you're still moving ("You are moving too quickly"). So send a chain of
// L.window steps, wait until every "You move" of it has arrived, then send the next. Stop on a
// direction that isn't the next step (manual move, wrong start), on "You can't go that way" and the
// like, or when nothing has moved for L.stallSec. "Too quickly" resends the rest of the chain.

const LIVE_KEY = "mushMapEditor.live.v1";
const CLIENT_STALE_MS = 15000;   // the bridge pings every 5s
const DIR_OF = Object.fromEntries(Object.entries(DIRWORD).map(([k, w]) => [w, k]));

const L = {
  bridge: false,      // userscript answered on this page
  clientAt: 0,        // last time the MUSH tab answered a ping
  follow: true,       // keep the view on your position
  window: 5,          // directions per input chain (the game's limit is 5)
  stallSec: 20,       // give up a walk after this long without a move
  seenName: null,     // name the MUSH gave for the current room, when it differs from the map's
  snap: null,         // last room snapshot from the side panel (bridge "room" message)
  bridgeV: null,      // version the installed bridge reported
  latestV: null,      // @version of the bridge file this site serves
  gotoList: [],       // room ids of the last numbered //goto list, for "//goto 2"
  gotoFly: false,     // ...and whether that list was a "//goto fly" one
  gotoPreview: false, // ...or a "//goto ?" one
  riding: null,       // name of the train line you're aboard, from "You step aboard the ..."
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
    L.window = clamp(parseInt(o.window, 10) || 5, 1, 5);
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
// known position whose name agrees with the game's: safe to write things onto that room
export function positionSure() { return !!hereRoom() && !L.seenName; }

function neighbourCell(r, dir) {
  if (dir === "UP" || dir === "DOWN") return roomAtCell(r.z + (dir === "UP" ? 1 : -1), r.x, r.y, spaceOf(r));
  const [dx, dy] = VEC[dir];
  return roomAtCell(r.z, r.x + dx, r.y + dy, spaceOf(r));
}
// A room with exactly this name that already has an exit INTO `from`: when the way out isn't
// mapped, the way in usually is. Prefers the opposite direction (walking west out of B, the room
// whose east exit leads into B). This is what finds the way back out of a space, whose grid has
// nothing to do with the street outside, so looking at the next cell would be wrong.
function linkedInto(from, dir, name) {
  const into = Object.values(S.map.rooms).filter(r => r.name === name && Object.values(r.exits).includes(from.id));
  return into.find(r => r.exits[OPP[dir]] === from.id) || (into.length === 1 ? into[0] : null);
}
// Where did "You move <dir> to <name>" put us? Most to least trusted:
//   the mapped exit, when its name agrees → a room with that name that leads back into this one
//   (exit not linked this way yet) → a room in that cell with that name → the only room anywhere
//   with that name (we were tracking the wrong room) → the mapped exit anyway (its name is
//   probably just out of date) → lost.
export function resolveMove(from, dir, name) {
  const want = norm(name);
  const viaExit = from && dir ? S.map.rooms[from.exits[dir]] || null : null;
  if (viaExit && norm(viaExit.name) === want) return viaExit;
  const back = from && dir ? linkedInto(from, dir, name) : null;
  if (back) return back;
  const cell = from && dir ? neighbourCell(from, dir) : null;
  if (cell && norm(cell.name) === want) return cell;
  const byName = Object.values(S.map.rooms).filter(r => norm(r.name) === want);
  if (byName.length === 1) return byName[0];
  if (viaExit) return viaExit;
  return null;
}
export function setHere(id, seenName) {
  S.here = id && S.map.rooms[id] ? id : null;
  if (S.here && L.bridge && clientAlive()) recordMove(S.here);   // history.js
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

// ---------- Anchoring from the side panel ----------
// Every "room" snapshot carries the mini-map: the names of the rooms around this one on the game's
// grid. With duplicate names ("Street" ×6) that's enough to tell which one we're in, so the
// position can be found on page load without moving, and a wrong one gets corrected.
function gridScore(r, grid) {
  let score = 0;
  for (const d of COMPASS) {
    const n = neighbourCell(r, d);
    if (n && grid[d]) score += n.name === grid[d] ? 1 : -1;
  }
  return score;
}
function anchor(snap) {
  const cands = Object.values(S.map.rooms).filter(r => r.name === snap.name);
  if (cands.length === 1) return cands[0];
  if (cands.length < 2) return null;
  const scored = cands.map(r => ({ r, score: gridScore(r, snap.grid || {}) })).sort((a, b) => b.score - a.score);
  return scored[0].score > 0 && scored[0].score > scored[1].score ? scored[0].r : null;
}
function onRoom(snap) {
  if (!snap || typeof snap.name !== "string") return;
  // A flight exit's compass label can name the room next door on the grid ("Go east to X
  // (aerial)"), but flight exits often skip several tiles: that name says nothing about where it
  // goes. Dropped here, before anything compares or links by it (issues.js, autoFill).
  for (const ex of Object.values(snap.exits || {})) if (ex && ex.aerial) ex.name = null;
  L.snap = snap;
  const cur = hereRoom();
  if (!cur || cur.name !== snap.name) {
    const found = anchor(snap);
    if (found && found !== cur) setHere(found.id, snap.name);
  }
  if (automapOn()) autoFill(hereRoom(), snap);
  checkRoom(hereRoom(), snap);   // issues.js: where map and game disagree
}

// ---------- Auto-map (hidden: only while the URL has #automap) ----------
// Walking off the map creates the room you walk into, and the side panel fills in what it knows.
// Rules: only build from a position we're sure of; create into empty cells only; touch an existing
// room only when its name matches the game's exactly, and then only its empty fields (description,
// image, missing exits). Rooms it creates get `auto: true` until you mark them verified.
export function automapOn() { return /(^#|&)automap(&|$)/.test(location.hash); }
function inGrid(r, dir) {
  if (dir === "UP" || dir === "DOWN") return true;
  const [dx, dy] = VEC[dir];
  return r.x + dx >= 0 && r.x + dx < GRID_N && r.y + dy >= 0 && r.y + dy < GRID_N;
}
// One-way on purpose: whether the way back exists is only known once the next room's exits arrive.
function linkOneWay(a, dir, b, fly) {
  a.exits[dir] = b.id;
  if (fly) a.exitFly[dir] = true;
  if (a.openExits) delete a.openExits[dir];
}
// Called on a move along an exit the map doesn't have yet. Returns the room we're now in, or null.
let autoWarned = false;   // autoStep explained why it stopped: don't bury that under "Lost"
function autoStep(from, dir, name) {
  const took = L.snap && L.snap.name === from.name && L.snap.exits ? L.snap.exits[dir] : null;
  const fly = !!(took && took.aerial);
  // already mapped the other way round (e.g. back out of a space): link it, build nothing
  const back = linkedInto(from, dir, name);
  if (back) {
    linkOneWay(from, dir, back, fly);
    commit();
    return back;
  }
  const cell = neighbourCell(from, dir);
  if (cell) {
    if (cell.name !== name) {
      toast(`🤖 Auto-map: ${DIRWORD[dir]} of “${escapeHtml(from.name)}” your map has “${escapeHtml(cell.name)}”, ` +
        `but the game says “${escapeHtml(name)}”. Left alone; maybe it belongs in a space.`);
      autoWarned = true;
      return null;
    }
    linkOneWay(from, dir, cell, fly);
    commit();
    return cell;
  }
  if (!inGrid(from, dir)) return null;
  const [dx, dy] = dir === "UP" || dir === "DOWN" ? [0, 0] : VEC[dir];
  const dz = dir === "UP" ? 1 : dir === "DOWN" ? -1 : 0;
  const r = createRoom(from.z + dz, from.x + dx, from.y + dy, name, spaceOf(from));
  r.auto = true; r.autoAt = Date.now();
  linkOneWay(from, dir, r, fly);
  commit();
  return r;
}
// Fill the current room's empty fields from the panel, and link exits whose destination is
// already on the map in that direction (this is also how the way back gets linked).
function autoFill(r, snap) {
  if (!r || r.name !== snap.name) return;
  let changed = false;
  if (!r.description && snap.description) { r.description = snap.description; changed = true; }
  if (!r.imageUrl && snap.image) { r.imageUrl = snap.image; changed = true; }
  for (const [d, ex] of Object.entries(snap.exits || {})) {
    if (!ex || r.exits[d]) continue;
    // flight exits never name where they go, so they can't be matched to a mapped room
    let n = ex.name ? neighbourCell(r, d) : null;
    if (n && n.name !== ex.name) n = null;
    if (!n && ex.name) n = linkedInto(r, d, ex.name);   // e.g. the street outside a space's door
    if (n) {
      r.exits[d] = n.id;
      if (r.openExits) delete r.openExits[d];
      changed = true;
      continue;
    }
    // the game has this exit, the map doesn't know where it goes: note it as unexplored
    const cur = r.openExits && r.openExits[d];
    if (!cur) { (r.openExits ||= {})[d] = { name: ex.name || null, fly: !!ex.aerial }; changed = true; }
    else if (!cur.name && ex.name) { cur.name = ex.name; changed = true; }
  }
  if (changed) { commit(); render(); }
  // ghost tiles for mini-map neighbours on empty cells (ghosts.js; per browser, not map data)
  const list = [];
  for (const d of COMPASS) {
    const name = snap.grid && snap.grid[d];
    if (!name || !inGrid(r, d)) continue;
    const [dx, dy] = VEC[d];
    list.push({ space: spaceOf(r), z: r.z, x: r.x + dx, y: r.y + dy, name });
  }
  if (addGhosts(list)) render();
}

function onMove(word, name) {
  const dir = DIR_OF[(word || "").toLowerCase()] || null;
  if (dir && hereRoom()) noteArrived(hereRoom(), dir, name);
  L.riding = null;
  if (W) {
    const exp = W.steps[W.done];
    if (exp.train) {
      stopWalk("You moved while the walk was waiting for the train.");
    } else if (dir !== exp.dir) {
      stopWalk(`Expected <b>${DIRWORD[exp.dir]}</b> but you moved <b>${escapeHtml(word)}</b>.`);
    } else {
      W.done++; W.lastMove = Date.now();
      if (W.done > W.sent) W.sent = W.done;   // it walked a step we'd taken back after "too quickly"
      setHere(exp.toId, name);   // the route's room is the mapped exit we meant to take
      if (W.done === W.steps.length) finishWalk(); else pump();
      updateChip();
      return;
    }
  }
  const from = hereRoom();
  let to = null;
  autoWarned = false;
  if (automapOn() && from && !L.seenName && dir && !from.exits[dir]) to = autoStep(from, dir, name);
  if (!to) to = resolveMove(from, dir, name);
  if (!to && S.here && !autoWarned) toast(`📍 Lost: “${escapeHtml(name)}” isn't on the map (or not uniquely). Select it and press 📍 I'm here.`);
  setHere(to ? to.id : null, name);
}

// ---------- Walking a route ----------
// res is a findPath() result. Walk steps go out in chains; a train leg is one step of its own,
// ridden with /train wait + /train stop (see Trains below).
export function startWalk(res, fromGame = false) {
  if (W) stopWalk(null);
  const steps = res.steps.map((s, i) => s.type === "train"
    ? { train: true, lineName: s.lineName, toId: s.toId }
    : { dir: s.dir, toId: res.rooms[i + 1] });
  const note = null;
  if (!steps.length) { toast("Nothing to walk."); return; }
  if (!clientAlive()) { toast("📡 No MUSH tab answering. Open (or click into) the MUSH client tab first."); return; }
  setHere(res.rooms[0]);   // you start the walk at the route's start
  W = { steps, sent: 0, done: 0, lastMove: Date.now(), note, timer: null, fromGame, retries: 0, phase: null };
  W.timer = setInterval(() => {
    // waiting for and riding a train take real time: no stall timeout then
    if (W && W.sent > W.done && W.phase !== "waiting" && W.phase !== "riding" && Date.now() - W.lastMove > L.stallSec * 1000)
      stopWalk(W.phase ? `The train didn't answer for ${L.stallSec}s.` : `No movement for ${L.stallSec}s (locked door, blocked, or you stopped?).`);
  }, 1000);
  pump();
  updateChip(); refreshLivePanel();
}
// Next chain, once the previous one has fully arrived. A short pause first: sent the instant the
// last move lands, the game may still count you as moving.
const CHAIN_GAP_MS = 300;
function pump(delay = W.sent ? CHAIN_GAP_MS : 0) {
  if (W.sent > W.done || W.sent >= W.steps.length || W.pending) return;
  W.pending = setTimeout(() => {
    if (!W) return;
    W.pending = null;
    if (W.steps[W.sent].train) {
      // boards at once if the doors are open, otherwise when the train comes in
      post("send", { cmds: ["/train wait"] });
      W.sent++; W.phase = "requested"; W.lastMove = Date.now();
      updateChip(); refreshLivePanel();
      return;
    }
    let n = 0;   // a chain stops short of a train leg
    while (n < L.window && W.sent + n < W.steps.length && !W.steps[W.sent + n].train) n++;
    post("send", { cmds: [W.steps.slice(W.sent, W.sent + n).map(s => DIRWORD[s.dir]).join(" ")] });
    W.sent += n;
    W.lastMove = Date.now();   // the stall clock starts when the chain goes out
  }, delay);
}
// The game refused something. "Too quickly" means the chain wasn't taken: send what's left of it
// again after a pause. Anything else ("You can't go that way.") ends the walk right away.
function onSys(text) {
  if (!W || W.sent === W.done) return;
  if (/moving too quickly/i.test(text) && W.retries < 2) {
    W.retries++;
    W.sent = W.done;
    clearTimeout(W.pending); W.pending = null;
    pump(1500);
    return;
  }
  stopWalk(`The game said: “${escapeHtml(text)}”`);
}
function finishWalk() {
  const dest = S.map.rooms[W.steps[W.steps.length - 1].toId];
  const note = W.note, fromGame = W.fromGame;
  clearInterval(W.timer); clearTimeout(W.pending); W = null;
  toast(`🏁 Arrived at <b>${escapeHtml(dest ? dest.name : "?")}</b>.` + (note ? " " + note : ""));
  if (fromGame) reply(`Arrived at ${dest ? dest.name : "?"}.` + (note ? " " + plain(note) : ""));
  walkEnded();
}
// why = null: replaced by a new walk, say nothing.
export function stopWalk(why) {
  if (!W) return;
  // mid train leg: stop waiting, or drop the chosen stop (cancel aboard keeps you on the train)
  if (W.phase && W.sent > W.done) post("send", { cmds: ["/train cancel"] });
  const queued = W.phase ? 0 : Math.max(0, W.sent - W.done), left = W.steps.length - W.done, fromGame = W.fromGame;
  clearInterval(W.timer); clearTimeout(W.pending); W = null;
  if (why !== null) {
    const msg = `Walk stopped. ${why || ""} ${left} step${left !== 1 ? "s" : ""} left` +
      (queued ? `, up to ${queued} more may still be walked from the last input.` : ".");
    toast("⏹ " + msg);
    if (fromGame) reply(plain(msg));
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

// ---------- Trains ----------
// Confirmed PbN lines. Riding a leg: at the boarding station send "/train wait"; once aboard send
// "/train stop <destination>" (full name, commas and all) and check the game confirms that very
// station; the game then steps you off there by itself. A ride has no "You move", so "Now arriving"
// and "You step off onto" carry the position, for manual rides too.
const TRAIN = {
  waiting:  /^You wait for the next train/,
  aboard:   /^You step aboard the (.+?)\./,
  stopSet:  /^You will step off at (.+?)\. Use \/train cancel/,
  arriving: /Now arriving: (.+?)\. The doors open\./,
  closing:  /^The chime sounds\. The doors close on (.+?) and the train moves off/,
  off:      /^You step off onto (.+?)\.$/,
};
// the room with that name, preferring stations when several rooms share it
function stationNamed(name) {
  const hits = Object.values(S.map.rooms).filter(r => r.name === name);
  const stations = hits.filter(r => stationLinesFor(r.id).length);
  return stations.length === 1 ? stations[0] : hits.length === 1 ? hits[0] : null;
}
function onTrain(text) {
  let m;
  if ((m = TRAIN.aboard.exec(text))) L.riding = m[1];
  const step = W && W.steps[W.done];
  if (step && step.train && W.sent > W.done && trainStep(step, text)) return;
  // position, walking or not
  if ((m = TRAIN.off.exec(text))) {
    L.riding = null;
    const st = stationNamed(m[1]);
    if (st) setHere(st.id, m[1]);
  } else if ((m = TRAIN.arriving.exec(text)) && L.riding) {
    const st = stationNamed(m[1]);
    if (st) setHere(st.id, m[1]);   // the ring rides along
  }
  updateChip(); refreshLivePanel();
}
// The current walk step is a train leg. Returns true when it fully handled the line.
function trainStep(step, text) {
  const dest = S.map.rooms[step.toId];
  let m;
  W.lastMove = Date.now();
  if (TRAIN.waiting.test(text)) { W.phase = "waiting"; }
  else if (TRAIN.aboard.test(text)) {
    W.phase = "aboard";
    post("send", { cmds: [`/train stop ${dest.name}`] });
  } else if ((m = TRAIN.stopSet.exec(text))) {
    if (m[1] !== dest.name) {
      stopWalk(`The game set your stop to “${escapeHtml(m[1])}” instead of “${escapeHtml(dest.name)}”, so I cancelled it. You're still aboard.`);
      return true;
    }
    W.phase = "riding";
  } else if ((m = TRAIN.closing.exec(text)) && m[1] === dest.name && W.phase === "riding") {
    // the doors closed on our stop and we're still aboard: held up (a fight, the Beast)
    stopWalk(`You missed your stop at ${escapeHtml(dest.name)} and are still on the train.`);
    return true;
  } else if ((m = TRAIN.off.exec(text))) {
    L.riding = null;
    if (m[1] !== dest.name) {
      W.phase = null;   // already off the train: nothing to cancel
      stopWalk(`You got off at ${escapeHtml(m[1])}, not ${escapeHtml(dest.name)}.`);
      return false;     // the general handler still moves the ring to where you got off
    }
    W.done++; W.sent = W.done; W.phase = null;
    setHere(dest.id, m[1]);
    if (W.done === W.steps.length) finishWalk(); else pump();
    updateChip(); refreshLivePanel();
    return true;
  }
  updateChip(); refreshLivePanel();
  return false;
}

// ---------- //goto from the PbN client ----------
// "//goto cafe bar" walks to the room whose name holds every word typed. Several matches come back
// as a numbered list ("//goto 2" picks one), so even identical names can be told apart.
// "//goto stop" stops a walk, a bare "//goto" says where the mapper thinks you are.
// Ground-only unless you say "//goto fly <room>": lifting off in public breaches the Masquerade,
// so flight is never picked up silently from the route box's checkbox (/stalk first is on you).
function reply(...lines) { post("reply", { lines }); }
// toast HTML → chat text: drop tags, undo escapeHtml/escapeAttr ("Broad &amp; Market" → "Broad & Market")
const plain = html => String(html).replace(/<[^>]+>/g, "")
  .replace(/&(lt|gt|quot|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', amp: "&" }[e]));
const fold = s => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
function matchRooms(q) {
  const all = Object.values(S.map.rooms);
  const exact = all.filter(r => fold(r.name) === fold(q));
  if (exact.length) return exact;
  const words = fold(q).split(" ");
  return all.filter(r => { const n = fold(r.name); return words.every(w => n.includes(w)); });
}
// walk-only first, trains only when there's no other way (same rule as the route box)
function routeTo(fromId, toId, fly) {
  return findPath(fromId, toId, fly, false) || findPath(fromId, toId, fly, true);
}
// "south south | east · 🚆 Broad Street Line to Northbound Platform · east": walk steps in the
// chains the walker would send, flown steps marked ✈, trains spelled out.
function routeText(res) {
  const parts = [];
  let chain = [];
  const flush = () => {
    for (let i = 0; i < chain.length; i += L.window) parts.push(chain.slice(i, i + L.window).join(" "));
    chain = [];
  };
  for (const st of res.steps) {
    if (st.type === "train") { flush(); parts.push(`🚆 ${st.lineName} to ${S.map.rooms[st.toId].name}`); }
    else chain.push(DIRWORD[st.dir] + (st.fly ? "✈" : ""));
  }
  flush();
  return parts.join(" | ");
}
const GOTO_HELP = [
  "//goto <room> — walk there; every word you type must be in the room's name",
  "//goto fly <room> — also use flight exits (/stalk first)",
  "//goto ? <room> — show the route without walking (also: //goto ? fly <room>)",
  "//goto <number> — pick from the last list",
  "//goto stop — stop walking (cancels a train wait or stop)",
  "//goto — where the mapper thinks you are",
];

function gotoRoomFromGame(target, fly, preview = false) {
  const here = hereRoom();
  if (!here) return reply("I don't know where you are yet. Move once, or press 📍 I'm here in the mapper.");
  if (here.id === target.id) return reply(`You're already in ${target.name}.`);
  const res = routeTo(here.id, target.id, fly);
  if (!res) {
    const byAir = !fly && routeTo(here.id, target.id, true);
    return reply(`No ${fly ? "" : "ground "}route from ${here.name} to ${target.name} on your map.` +
      (byAir ? ` There is one with flight: //goto fly ${target.name}` : ""));
  }
  const trains = res.steps.filter(s => s.type === "train");
  const walkSteps = res.steps.length - trains.length;
  const flown = res.steps.filter(s => s.fly).length;
  S.pathCanFly = !!fly;              // the route box shows what's actually walked
  computePath(here.id, target.id);   // show it in the mapper too
  const summary = `${walkSteps} step${walkSteps !== 1 ? "s" : ""}` + (flown ? ` (${flown} flown)` : "") +
    (trains.length ? ` and ${trains.map(t => "the " + t.lineName).join(", then ")}` : "");
  if (preview) {
    // "//goto 1" walks exactly this room, even when other rooms share its name
    L.gotoList = [target.id]; L.gotoFly = !!fly; L.gotoPreview = false;
    const unique = Object.values(S.map.rooms).filter(r => r.name === target.name).length === 1;
    return reply(`Route to ${target.name}: ${summary}.`, routeText(res),
      (unique ? `//goto ${fly ? "fly " : ""}${target.name} or ` : "") + "//goto 1 to walk it.");
  }
  startWalk(res, true);
  if (!W) return reply("Couldn't start the walk. Is this the linked PbN tab?");
  reply(`Walking to ${target.name}: ${summary}. //goto stop to stop.`);
}
function onGoto(q) {
  if (!S.map) return;
  q = String(q || "").trim();
  if (!q) {
    const r = hereRoom();
    return reply(r ? `You are in ${r.name} (${roomLocation(r)}).` : "I don't know where you are yet.");
  }
  if (/^stop$/i.test(q)) {
    if (!W) return reply("Not walking.");
    return stopWalk("Stopped from the game.");
  }
  if (/^(help|\?)$/i.test(q)) return reply(...GOTO_HELP);
  if (/^\d+$/.test(q) && L.gotoList.length) {
    const r = S.map.rooms[L.gotoList[parseInt(q, 10) - 1]];
    return r ? gotoRoomFromGame(r, L.gotoFly, L.gotoPreview) : reply(`Pick a number from 1 to ${L.gotoList.length}.`);
  }
  // Leading switches, in any order: "fly" allows flight exits, "?" previews without walking.
  // Only the first of each counts, so a room starting with "fly" is "//goto fly fly trap".
  let fly = false, preview = false, m;
  while ((m = /^(fly|\?)(?:\s+|$)/i.exec(q))) {
    const isFly = m[1].toLowerCase() === "fly";
    if (isFly ? fly : preview) break;
    if (isFly) fly = true; else preview = true;
    q = q.slice(m[0].length).trim();
  }
  if (!q) return reply(`Where to? //goto ${preview ? "? " : ""}${fly ? "fly " : ""}<room>`);
  const hits = matchRooms(q);
  if (!hits.length) return reply(`Nothing on your map matches "${q}".`);
  if (hits.length === 1) return gotoRoomFromGame(hits[0], fly, preview);
  // several: nearest first, with where they are and how far, so duplicates can be told apart
  const here = hereRoom();
  const rows = hits.map(r => {
    const res = here ? routeTo(here.id, r.id, fly) : null;
    return { r, steps: res ? res.steps.length : (here && here.id === r.id ? 0 : Infinity) };
  }).sort((a, b) => a.steps - b.steps || a.r.name.localeCompare(b.r.name));
  const shown = rows.slice(0, 8);
  L.gotoList = shown.map(x => x.r.id);
  L.gotoFly = fly;
  L.gotoPreview = preview;
  reply(`${hits.length} rooms match "${q}":`,
    ...shown.map((x, i) => `${i + 1}. ${x.r.name} · ${roomLocation(x.r)}` +
      (x.steps === Infinity ? (here ? " · no route" : "") : x.steps === 0 ? " · you are here" : ` · ${x.steps} step${x.steps !== 1 ? "s" : ""}`)),
    (hits.length > shown.length ? `…and ${hits.length - shown.length} more. ` : "") + `Type //goto <number> to pick one${fly ? " (flying)" : ""}${preview ? " (route only)" : ""}, or be more specific.`);
}

// ---------- Toolbar chip + panel ----------
function updateChip() {
  const btn = document.getElementById("liveBtn");
  if (!btn) return;
  btn.style.display = L.bridge ? "" : "none";
  const alive = clientAlive();
  btn.classList.toggle("live-on", alive);
  btn.classList.toggle("live-update", bridgeOutdated());
  const issues = issueCount();
  const train = W && W.phase === "waiting" ? "🚆 waiting" : L.riding ? `🚆 ${L.riding}` : null;
  btn.textContent = (train || (W ? `🚶 ${W.done}/${W.steps.length}` : alive ? "📡 Live" : "📡 No MUSH tab")) +
    (issues ? ` · ⚠${issues}` : "") + (automapOn() ? " · 🤖" : "");
  btn.title = bridgeOutdated() ? "A newer version of the bridge userscript is available. Click to update." :
    W ? "Walking a route. Click for details or to stop." :
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
  const alive = clientAlive();
  const pill = document.getElementById("liveStatus");
  pill.className = "livepill" + (alive ? " on" : "");
  pill.textContent = alive ? "Connected" : "No MUSH tab";

  let h = "";
  if (bridgeOutdated()) {
    h += `<div class="livecard liveupdate"><div><b>Bridge update</b><div class="livesub">${escapeHtml(L.bridgeV)} → ${escapeHtml(L.latestV)}</div></div>
      <a class="livebtn primary" href="${BRIDGE_URL}" target="_blank" rel="noopener">Update</a></div>`;
  }
  h += `<div class="livecard">` + (r
    ? `<div class="livelabel">${currentCharacter() ? escapeHtml(currentCharacter()) + " is in" : "You are in"}</div>
       <div class="livehere">
         <button class="liveroom" id="liveGoto" title="Show on the map">${escapeHtml(r.name)}</button>
         <button class="liveicon" id="liveForget" title="Forget my position">✕</button>
       </div>
       <div class="livesub">${escapeHtml(roomLocation(r))}</div>`
    : `<div class="livelabel">You are in</div>
       <div class="livesub">Unknown. Move once in the game, or select your room and press <b>📍 I'm here</b>.</div>`) +
    `</div>`;
  if (W) {
    const dest = S.map.rooms[W.steps[W.steps.length - 1].toId];
    const pct = Math.round(W.done / W.steps.length * 100);
    h += `<div class="livecard">
      <div class="livewalkhead"><div><div class="livelabel">Walking to</div><b>${escapeHtml(dest ? dest.name : "?")}</b></div>
        <button class="livebtn danger" id="liveStop">■ Stop</button></div>
      <div class="liveprog"><span style="width:${pct}%"></span></div>
      <div class="livesub">${W.done} of ${W.steps.length} steps` +
      (W.phase === "requested" ? " · 🚆 calling the train…" : W.phase === "waiting" ? " · 🚆 waiting for the train" :
       W.phase ? ` · 🚆 riding to ${escapeHtml(S.map.rooms[W.steps[W.done].toId].name)}` : "") + `</div></div>`;
  }
  h += issuesHtml();
  const gn = ghostCount(), gd = dismissedCount();
  if (gn || gd) {
    h += `<div class="livelabel livesettings">Ghost tiles</div>` +
      (gn ? `<div class="livesetting"><div><div>${gn} on the map</div><div class="livesub">Seen on the game's mini-map, not visited</div></div>
        <button class="livebtn" id="liveGhostClear">Clear all</button></div>` : "") +
      (gd ? `<div class="livesetting"><div><div>${gd} dismissed</div><div class="livesub">Won't come back until reset</div></div>
        <button class="livebtn" id="liveGhostReset">Reset</button></div>` : "");
  }
  const autos = Object.values(S.map.rooms).filter(x => x.auto);
  if (autos.length) {
    const recent = autos.filter(x => x.autoAt && Date.now() - x.autoAt < 3600e3).length;
    h += `<div class="livelabel livesettings">Auto-created rooms</div>
      <div class="livesetting"><div><div>${autos.length} not verified yet</div><div class="livesub">Made by auto-map, not marked ✓ Verified</div></div></div>
      <div class="histbtns">` +
      (recent ? `<button class="livebtn" id="autoDelRecent" title="Delete the unverified rooms auto-map made in the last hour">Delete last hour (${recent})</button>` : "") +
      `<button class="livebtn danger" id="autoDelAll" title="Delete every unverified auto-created room">Delete all (${autos.length})</button></div>`;
  }
  h += `<div class="livelabel livesettings">Gathering</div>` + gatherHtml();
  h += historyHtml();
  h += `<div class="livelabel livesettings">Settings</div>
    <div class="livesetting">
      <div><div>Follow my position</div><div class="livesub">Keep the map centred on you</div></div>
      <label class="liveswitch"><input type="checkbox" id="liveFollow"${L.follow ? " checked" : ""}><span></span></label>
    </div>
    <div class="livesetting">
      <div><div>Steps per input</div><div class="livesub">Sent as one line, e.g. “north north east”</div></div>
      ${stepper("liveWindow", L.window, "")}
    </div>
    <div class="livesetting">
      <div><div>Give up after</div><div class="livesub">Stop a walk with no movement</div></div>
      ${stepper("liveStall", L.stallSec, "s")}
    </div>`;
  if (automapOn()) h += `<div class="liveauto">🤖 Auto-map is on</div>`;
  body.innerHTML = h;

  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
  on("liveGoto", "onclick", () => gotoRoom(r.id));
  on("liveStop", "onclick", () => stopWalk("Stopped by you."));
  on("liveFollow", "onchange", e => { L.follow = e.target.checked; saveLive(); if (L.follow && r) followTo(r); });
  on("liveForget", "onclick", () => setHere(null));
  on("liveGhostClear", "onclick", () => { clearGhosts(); buildLivePanel(); });
  wireIssues(body, buildLivePanel);
  on("autoDelRecent", "onclick", () => deleteAutoRooms(true));
  on("autoDelAll", "onclick", () => deleteAutoRooms(false));
  wireHistory();
  on("liveGhostReset", "onclick", () => { resetDismissed(); buildLivePanel(); });
  wireStepper("liveWindow", v => { L.window = clamp(v, 1, 5); saveLive(); return L.window; });
  wireStepper("liveStall", v => { L.stallSec = clamp(v, 5, 300); saveLive(); return L.stallSec; });
}
// Unverified auto-created rooms, all or just the last hour's: one undo step brings them back.
function deleteAutoRooms(recentOnly) {
  const ids = Object.values(S.map.rooms)
    .filter(x => x.auto && (!recentOnly || (x.autoAt && Date.now() - x.autoAt < 3600e3))).map(x => x.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} unverified auto-created room${ids.length !== 1 ? "s" : ""}` +
    `${recentOnly ? " from the last hour" : ""}? Exits to them are removed too. Ctrl+Z undoes it.`)) return;
  for (const id of ids) deleteRoom(id);
  if (S.here && !S.map.rooms[S.here]) setHere(null);
  commit(); render(); buildLivePanel();
  toast(`🗑 Deleted ${ids.length} auto-created room${ids.length !== 1 ? "s" : ""}.`);
}
// − value +  (the stall timeout steps by 5s above 10s)
function stepper(id, value, unit) {
  return `<div class="livestep" id="${id}"><button data-d="-1" aria-label="Less">−</button>` +
    `<span>${value}${unit ? `<small>${unit}</small>` : ""}</span><button data-d="1" aria-label="More">+</button></div>`;
}
function wireStepper(id, apply) {
  const el = document.getElementById(id);
  const span = el.querySelector("span"), unit = span.querySelector("small");
  el.querySelectorAll("button").forEach(b => b.onclick = () => {
    const cur = parseInt(span.firstChild.textContent, 10);
    const up = b.dataset.d > 0;
    const step = id === "liveStall" && (up ? cur >= 10 : cur > 10) ? 5 : 1;
    const next = apply(cur + (up ? step : -step));
    span.firstChild.textContent = next;
    if (unit) span.appendChild(unit);
  });
}
document.getElementById("liveBtn").onclick = () => {
  const panel = document.getElementById("livePanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  buildLivePanel();
  positionPopover(panel, document.getElementById("liveBtn"));
};

// ---------- Bridge updates ----------
// Userscript managers only look for updates about once a day, so tell bridge users when the file
// this site serves is newer than what they run. The Update link opens the manager's update screen.
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function bridgeOutdated() { return !!(L.bridgeV && L.latestV && cmpVer(L.latestV, L.bridgeV) > 0); }
async function checkBridgeVersion() {
  try {
    const src = await (await fetch(BRIDGE_URL, { cache: "no-cache" })).text();
    const m = /@version\s+([\d.]+)/.exec(src);
    if (m) L.latestV = m[1];
  } catch (e) { /* offline or not deployed with the file: just don't nag */ }
  updateChip(); refreshLivePanel();
}

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
    L.bridgeV = m.v ? String(m.v) : null;
    if (first) checkBridgeVersion();
    updateChip();
    document.getElementById("bridgeOffer").style.display = "none";
    if (first) render();   // the inspector and path box grow live buttons
  } else if (m.type === "client") {
    L.clientAt = Date.now();
    if (m.char) setCharacter(String(m.char));
    updateChip(); refreshLivePanel();
  } else if (["move", "sys", "train", "gather", "room"].includes(m.type) && S.map) {
    queueGameEvent(m);
  } else if (m.type === "goto") {
    onGoto(m.q);
  }
});
// Safety net against replayed chat (bridges before 1.6.2 re-read the whole chat when you switched
// chat tabs): in-game moves take time, so game events never come fractions of a second apart.
// Panel snapshots ("room") go through the same queue so they're never handled before the move
// they belong to (a snapshot overtaking its move made the move look like it started from its own
// destination). They don't count toward a burst and are kept even in one: they show the panel as
// it really is.
// They're held for a moment; BURST_N or more in one rush are a replay and are dropped together.
const BURST_N = 4, BURST_QUIET_MS = 150;
let gameQ = [], gameTimer = null;
function queueGameEvent(m) {
  gameQ.push(m);
  clearTimeout(gameTimer);
  gameTimer = setTimeout(() => {
    let q = gameQ; gameQ = [];
    const lines = q.filter(e => e.type !== "room").length;
    if (lines >= BURST_N) {
      toast(`⚠ Ignored ${lines} game lines that arrived at once (old chat shown again?). Update the bridge if this repeats.`);
      q = q.filter(e => e.type === "room");
    }
    for (const e of q) {
      if (e.type === "room") onRoom(e.room);
      else if (e.type === "move") onMove(String(e.dir || ""), String(e.name || ""));
      else if (e.type === "sys") onSys(String(e.text || ""));
      else if (e.type === "train") onTrain(String(e.text || ""));
      else if (e.type === "gather") { onGather(String(e.text || "")); refreshLivePanel(); }
    }
  }, BURST_QUIET_MS);
}
setInterval(() => { if (L.bridge) { updateChip(); refreshLivePanel(); } }, 5000);   // notice a closed MUSH tab
onIssuesChange(() => { updateChip(); refreshLivePanel(); });
onHistoryChange(() => refreshLivePanel());
window.addEventListener("hashchange", () => { updateChip(); if (automapOn()) toast("🤖 Auto-map on"); });
loadLive();
post("probe");
