import { DIRWORD, VEC, COMPASS, GRID_N, OPP } from "./constants.js";
import { S, viewport } from "./state.js";
import { escapeHtml, escapeAttr, clamp } from "./utils.js";
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
import { onGather, gatherHtml, mergeNightCounts } from "./gather.js";
import { setCharacter, recordMove, recordedSteps, renameHistoryChar, historyHtml, wireHistory, onHistoryChange } from "./history.js";
import { API_BASE, CLIENT_KEY } from "./sync.js";

// ---------- Live link to the MUSH web client ----------
// The MUSH client is another site, so this page can't touch it. The bridge userscript
// (userscript/mush-mapper-bridge.user.js) runs on both pages and relays through its own storage:
//   bridge → page  {mm:"bridge", type:"hello", sending}      userscript is installed (sending: this
//                                                            browser feeds a mapper elsewhere, see Relay)
//                  {mm:"bridge", type:"client", char}        the MUSH tab answered a ping (char: who's playing)
//                  {mm:"bridge", type:"move", dir, name}     MUSH printed "You move <dir> to <name>."
//                  {mm:"bridge", type:"goto", q}             "//goto <q>" typed in the PbN client
//                  {mm:"bridge", type:"sys", text}           the game refused a move ("You can't go that way.")
//                  {mm:"bridge", type:"train", text}         a /train line (see Trains below)
//                  {mm:"bridge", type:"gather", text}        /scavenge or /harvest sent, or its result (gather.js)
//                  {mm:"bridge", type:"room", room}          the side panel caught up: {name, description,
//                                                            image, exits:{N:{name,locked,aerial}}, grid:{N:name}}
//                  game events (move…room, goto) also carry char: the character they belong to
//   page → bridge  {mm:"page", type:"probe"}                 ask for a hello
//                  {mm:"page", type:"send", cmds, char}      type these into that character's MUSH tab
//                  {mm:"page", type:"reply", lines, char}    show as a local [MAPPER] line in PbN's chat
//                  {mm:"page", type:"pair", code, api}       feed this browser's game to another mapper
//                  {mm:"page", type:"unpair"}                ...and stop
// All the logic (where you are, what to send next) lives here so it updates with the site;
// the userscript only moves messages around.
//
// Characters: one mapper can follow several characters at once, each with its own position, walk,
// train ride and //goto list (charState). A PbN tab on another device feeds in through the
// relay (see Relay below). Code that acts for a character runs inside withChar(name, …), which
// points C at that character; everywhere else C is the focused one, the character the map follows
// and the panel shows: whoever moved last, or whoever you clicked.
//
// Position: follow the reported direction along the map's exits. The direction is what the game
// actually did, the room name is only a cross-check, since mapped names can be stale. A position
// is only "sure" (safe to map and check from) once the game's room panel has confirmed it.
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
  sending: false,     // this browser's game goes to a mapper on another device: stay out of it
  follow: true,       // keep the view on the focused character
  window: 5,          // directions per input chain (the game's limit is 5)
  stallSec: 20,       // give up a walk after this long without a move
  bridgeV: null,      // version the installed bridge reported
  latestV: null,      // @version of the bridge file this site serves
  namesOpen: false,   // the panel shows the focused character's names (masks)
};

// ---------- Characters ----------
const CH = {};                              // name -> charState
let saved = {};                             // name -> room id, as the last session left them
let focus = "";                             // the character the map follows and the panel shows
let C = null;                               // the character the code is acting for (see withChar)
let depth = 0;
const pathChar = { direct: null, relay: null };   // who is playing on each way in
function charState(name) {
  name = canon(name || "");
  return CH[name] ||= {
    name,
    here: saved[name] || null,
    sure: false,        // a room panel confirmed `here` (a remembered position isn't, yet)
    seenName: null,     // name the MUSH gave for the current room, when it differs from the map's
    snap: null,         // last room snapshot from the side panel (bridge "room" message)
    riding: null,       // name of the train line aboard, from "You step aboard the ..."
    W: null,            // running walk: { steps:[{dir,toId}], sent, done, lastMove, timer, ... }
    gotoList: [], gotoFly: false, gotoPreview: false,   // the last numbered //goto list
    clientAt: 0,        // last sign of life from this character's MUSH tab
    seenAt: 0,          // last game event this session
    via: "direct",      // "direct" (this browser's bridge) or "relay" (another device)
    shown: null,        // the name the journal shows right now, when it's a mask
  };
}

// ---------- Masks ----------
// Obfuscate masks change the name the journal (and so the bridge) reports. The bridge also sends a
// token per visit to /play, and switching characters always leaves /play: every name seen in one
// visit is the same character. Those names are grouped under one main name, everything else being
// an alias of it, remembered from then on (logging in with a known mask on is recognised at once).
// Which name is the main one can't be told from the game (you can go from mask to mask without the
// real name ever showing), so it's yours to pick in the 📡 panel; until then it's the name this
// mapper has known longest. A picked main name is never changed by anything automatic.
const ALIAS_KEY = "mushMapEditor.aliases.v1";
// alias: name -> name it stands for; first/seen: name -> first/last seen (ms); picked: main name -> true
let A = { alias: {}, first: {}, seen: {}, picked: {} };
const visitName = {};               // visit token -> main name of that visit's character (this page load)
function loadAliases() {
  try {
    const o = JSON.parse(localStorage.getItem(ALIAS_KEY) || "{}");
    A = { alias: o.alias || {}, first: o.first || {}, seen: o.seen || {}, picked: o.picked || {} };
  } catch (e) { /* no storage: masks are re-learned each visit */ }
}
function saveAliases() { try { localStorage.setItem(ALIAS_KEY, JSON.stringify(A)); } catch (e) { /* ignore */ } }
function canon(name) {
  for (let i = 0; i < 20 && A.alias[name] !== undefined; i++) name = A.alias[name];
  return name;
}
// every name of the character whose main name this is, the main one first
function namesOf(main) {
  return [main, ...Object.keys(A.alias).filter(n => n !== main && canon(n) === main)];
}
// The character behind a reported name (and visit token).
function identify(shown, sess) {
  const name = canon(shown);
  if (!name) return name;
  const now = Date.now();
  const stale = !A.seen[shown] || now - A.seen[shown] > 60e3;   // "last seen" needn't be exact to the second
  A.seen[shown] = now;
  if (!A.first[name]) A.first[name] = now;
  if (stale) saveAliases();
  if (!sess) return name;
  const before = visitName[sess] !== undefined ? canon(visitName[sess]) : undefined;
  if (before === undefined || before === name) { visitName[sess] = name; return name; }
  return mergeNames(before, name, sess);
}
// Two names met in one visit: one character. A picked main name stays; otherwise the one known
// longer (names from before masks were told apart all count as old: then more recorded moves).
function mergeNames(a, b, sess) {
  const fa = A.first[a] || Infinity, fb = A.first[b] || Infinity;
  const keep = A.picked[a] ? a : A.picked[b] ? b :
    fa !== fb ? (fa < fb ? a : b) : recordedSteps(a) >= recordedSteps(b) ? a : b;
  const drop = keep === a ? b : a;
  for (const [n, to] of Object.entries(A.alias)) if (to === drop) A.alias[n] = keep;
  A.alias[drop] = keep;
  delete A.picked[drop];
  saveAliases();
  visitName[sess] = keep;
  absorb(drop, keep);
  toast(`🎭 ${escapeHtml(drop)} and ${escapeHtml(keep)} are one character (a mask). Pick its main name in the 📡 panel.`);
  return keep;
}
// The character called `drop` is called `keep` from now on (merged, or its main name changed).
// Whichever was played more recently carries the live state (position, walk, ...).
function absorb(drop, keep) {
  const a = CH[drop], b = CH[keep];
  delete CH[drop];
  const aWins = !!a && (!b || a.seenAt >= b.seenAt);
  if (aWins) {
    if (b && b.W && b.W !== a.W) { clearInterval(b.W.timer); clearTimeout(b.W.pending); }
    CH[keep] = Object.assign(a, { name: keep });
  }
  if (saved[drop] && (aWins || !saved[keep])) saved[keep] = saved[drop];
  delete saved[drop];
  for (const v of ["direct", "relay"]) if (pathChar[v] === drop) pathChar[v] = keep;
  for (const t of Object.keys(visitName)) if (visitName[t] === drop) visitName[t] = keep;
  if (focus === drop) { focus = keep; setCharacter(keep); }
  if (C === a || C === b) C = charState(keep);
  mergeNightCounts(drop, keep);
  renameHistoryChar(drop, keep);
  syncMarkers(); saveLive();
}
// your pick in the names list: permanent
function pickMainName(main, name) {
  if (main === name || canon(name) !== main) return;
  for (const [n, to] of Object.entries(A.alias)) if (to === main) A.alias[n] = name;
  delete A.alias[name];
  A.alias[main] = name;
  delete A.picked[main];
  A.picked[name] = true;
  saveAliases();
  absorb(main, name);
  render(); updateChip();
  toast(`🎭 This character goes by <b>${escapeHtml(name)}</b> now.`);
}
// a mask you deleted in the game; if the name shows up again, it's grouped again by visit
function forgetName(name) {
  if (A.alias[name] === undefined) return;   // never the main name
  delete A.alias[name]; delete A.first[name]; delete A.seen[name];
  saveAliases();
}
function withChar(name, fn) {
  const prev = C;
  C = charState(name); depth++;
  try { return fn(); }
  finally { depth--; C = depth ? prev : charState(focus); }
}
const alive = c => Date.now() - c.clientAt < CLIENT_STALE_MS;
const known = () => Object.values(CH).filter(c => c.seenAt || alive(c));
// several characters in play: messages say whose they are
const who = () => known().length > 1 ? `<b>${escapeHtml(C.name || "?")}</b>: ` : "";
// The map follows this one. Their markers: S.here for the focused character, S.alts for the rest.
function setFocus(name) {
  if (focus === name) return;
  focus = name;
  if (!depth) C = charState(name);
  setCharacter(name);   // history.js labels and records under this name
  syncMarkers(); saveLive();
  const r = roomOf(charState(name));
  if (r && L.follow) followTo(r);
  render(); updateChip(); refreshLivePanel();
}
function syncMarkers() {
  if (!S.map) { S.here = charState(focus).here; S.alts = {}; return; }   // still loading: checked again on use
  S.here = roomOf(charState(focus)) ? charState(focus).here : null;
  const alts = {};
  for (const c of known()) {
    if (c.name === focus || !roomOf(c)) continue;
    alts[c.here] = alts[c.here] ? alts[c.here] + ", " + (c.name || "?") : (c.name || "?");
  }
  S.alts = alts;
}
const roomOf = c => c && c.here && S.map ? S.map.rooms[c.here] || null : null;

export const liveBridge = () => L.bridge && !L.sending;
export const clientAlive = () => alive(C);
export const walking = () => !!(C && C.W);
export function liveCharacter() { return C ? C.name : ""; }

function loadLive() {
  try {
    const o = JSON.parse(localStorage.getItem(LIVE_KEY) || "{}");
    saved = o.chars && typeof o.chars === "object" ? o.chars : {};
    if (o.here && !o.chars) saved[o.char || ""] = o.here;   // saved before there were several
    // known before masks were told apart: older than any name seen from now on
    for (const n of Object.keys(saved)) if (n && !A.first[n]) A.first[n] = 1;
    focus = typeof o.focus === "string" ? o.focus : (o.char || "");
    L.follow = o.follow !== false;
    L.window = clamp(parseInt(o.window, 10) || 5, 1, 5);
    L.stallSec = clamp(parseInt(o.stallSec, 10) || 20, 5, 300);
  } catch (e) { /* private window etc: defaults are fine */ }
  C = charState(focus);
  syncMarkers();
}
function saveLive() {
  for (const c of Object.values(CH)) saved[c.name] = c.here;
  try { localStorage.setItem(LIVE_KEY, JSON.stringify({ chars: saved, focus, follow: L.follow, window: L.window, stallSec: L.stallSec })); }
  catch (e) { /* ignore */ }
}
function post(type, data = {}) { window.postMessage({ mm: "page", type, ...data }, location.origin); }
// to the acting character's MUSH tab, whichever way it's connected
function sendCmds(cmds) {
  if (C.via === "relay") relayDown({ kind: "cmd", char: C.name, cmds });
  else post("send", { cmds, char: C.name });
}

// ---------- Position ----------
const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
export function hereRoom() { return roomOf(C); }
// known position, confirmed by the game, whose name agrees with it: safe to write things onto that room
export function positionSure() { return !!hereRoom() && C.sure && !C.seenName; }

function neighbourCell(r, dir) {
  if (dir === "UP" || dir === "DOWN") return roomAtCell(r.z + (dir === "UP" ? 1 : -1), r.x, r.y, spaceOf(r));
  const [dx, dy] = VEC[dir];
  return roomAtCell(r.z, r.x + dx, r.y + dy, spaceOf(r));
}
// A room with exactly this name whose exit in the OPPOSITE direction leads into `from`: when the
// way out isn't mapped, the way in usually is (walking west out of B, the room whose east exit
// leads into B). This is what finds the way back out of a space, whose grid has nothing to do with
// the street outside, so looking at the next cell would be wrong. Only the opposite direction
// counts: a room can have two exits to different rooms with the same name, and one that leads in
// from another side is a different way, not this one.
function linkedInto(from, dir, name) {
  return Object.values(S.map.rooms).find(r => r.name === name && r.exits[OPP[dir]] === from.id) || null;
}
// Where did "You move <dir> to <name>" put us? Most to least trusted:
//   the mapped exit, when its name agrees → a room with that name that leads back into this one
//   (exit not linked this way yet) → a room in that cell with that name → the only room anywhere
//   with that name (we were tracking the wrong room) → the mapped exit anyway (its name is
//   probably just out of date) → lost.
function resolveMove(from, dir, name) {
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
// Moves the acting character.
function place(id, seenName) {
  C.here = id && S.map.rooms[id] ? id : null;
  if (C.here && L.bridge && alive(C)) recordMove(C.here, C.name);   // history.js
  const r = hereRoom();
  C.seenName = r && seenName && norm(seenName) !== norm(r.name) ? seenName : null;
  if (!r) C.sure = false;
  syncMarkers(); saveLive();
  if (r && L.follow && C.name === focus) followTo(r);
  render();
  refreshLivePanel();
}
// 📍 I'm here (inspector): you said so, which is as sure as it gets.
export function setHere(id) {
  place(id);
  C.sure = !!C.here;
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
  C.snap = snap;
  const cur = hereRoom();
  if (!cur || cur.name !== snap.name) {
    const found = anchor(snap);
    if (found && found !== cur) { place(found.id, snap.name); C.sure = true; }
    // The panel shows another room than the one we think we're in, and no move explains it (a move
    // along a mapped exit whose name is out of date sets seenName): we're somewhere else, e.g. a
    // character switch or a teleport. Lost beats mapping and checking from the wrong room.
    else if (!found && cur && !(C.seenName && norm(C.seenName) === norm(snap.name))) place(null);
  } else if (!C.sure) {
    // The name agrees. With several rooms of that name, the mini-map has to agree too.
    const twins = Object.values(S.map.rooms).filter(r => r.name === snap.name).length > 1;
    const best = twins ? anchor(snap) : cur;
    if (best && best !== cur) place(best.id, snap.name);
    if (best) C.sure = true;
  }
  if (!C.sure) return;   // not sure where this is: don't write anything onto the map from it
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
// PbN's exits go both ways (even when one end is hidden; one known exception, which gets its
// back exit deleted by hand), so auto-map always links both directions at once. The way back is
// only added where that direction is still free: an exit that leads elsewhere is never replaced.
// Callers only link directions that are free; the check here makes sure of it regardless.
function linkBoth(a, dir, b, fly) {
  if (a.exits[dir]) return;
  a.exits[dir] = b.id;
  if (fly) a.exitFly[dir] = true;
  if (a.openExits) delete a.openExits[dir];
  const back = OPP[dir];
  if (b.exits[back]) return;
  b.exits[back] = a.id;
  if (fly) b.exitFly[back] = true;
  if (b.openExits) delete b.openExits[back];
}
// Called on a move along an exit the map doesn't have yet. Returns the room we're now in, or null.
let autoWarned = false;   // autoStep explained why it stopped: don't bury that under "Lost"
function autoStep(from, dir, name) {
  const took = C.snap && C.snap.name === from.name && C.snap.exits ? C.snap.exits[dir] : null;
  const fly = !!(took && took.aerial);
  // already mapped the other way round (e.g. back out of a space): link it, build nothing
  const back = linkedInto(from, dir, name);
  if (back) {
    linkBoth(from, dir, back, fly);
    commit();
    return back;
  }
  const cell = neighbourCell(from, dir);
  if (cell) {
    if (cell.name !== name) {
      toast(`🤖 ${who()}Auto-map: ${DIRWORD[dir]} of “${escapeHtml(from.name)}” your map has “${escapeHtml(cell.name)}”, ` +
        `but the game says “${escapeHtml(name)}”. Left alone; maybe it belongs in a space.`);
      autoWarned = true;
      return null;
    }
    linkBoth(from, dir, cell, fly);
    commit();
    return cell;
  }
  if (!inGrid(from, dir)) return null;
  const [dx, dy] = dir === "UP" || dir === "DOWN" ? [0, 0] : VEC[dir];
  const dz = dir === "UP" ? 1 : dir === "DOWN" ? -1 : 0;
  const r = createRoom(from.z + dz, from.x + dx, from.y + dy, name, spaceOf(from));
  r.auto = true; r.autoAt = Date.now();
  linkBoth(from, dir, r, fly);
  commit();
  return r;
}
// Fill the current room's empty fields from the panel, and link exits whose destination is
// already on the map in that direction (this is also how the way back gets linked).
function autoFill(r, snap) {
  if (!r || r.name !== snap.name) return;
  let changed = false;
  // repair links made one way by older versions: whatever leads in here gets the way back
  for (const other of Object.values(S.map.rooms)) {
    for (const [d, id] of Object.entries(other.exits)) {
      if (id !== r.id || r.exits[OPP[d]]) continue;
      r.exits[OPP[d]] = other.id;
      if (other.exitFly && other.exitFly[d]) r.exitFly[OPP[d]] = true;
      if (r.openExits) delete r.openExits[OPP[d]];
      changed = true;
    }
  }
  if (!r.description && snap.description) { r.description = snap.description; changed = true; }
  if (!r.imageUrl && snap.image) { r.imageUrl = snap.image; changed = true; }
  for (const [d, ex] of Object.entries(snap.exits || {})) {
    if (!ex || r.exits[d]) continue;
    // flight exits never name where they go, so they can't be matched to a mapped room
    let n = ex.name ? neighbourCell(r, d) : null;
    if (n && n.name !== ex.name) n = null;
    if (!n && ex.name) n = linkedInto(r, d, ex.name);   // e.g. the street outside a space's door
    if (n) {
      linkBoth(r, d, n, false);
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
  if (dir && positionSure()) noteArrived(hereRoom(), dir, name);
  C.riding = null;
  const W = C.W;
  if (W) {
    const exp = W.steps[W.done];
    if (exp.train) {
      stopWalk("You moved while the walk was waiting for the train.");
    } else if (dir !== exp.dir) {
      stopWalk(`Expected <b>${DIRWORD[exp.dir]}</b> but you moved <b>${escapeHtml(word)}</b>.`);
    } else {
      W.done++; W.lastMove = Date.now();
      if (W.done > W.sent) W.sent = W.done;   // it walked a step we'd taken back after "too quickly"
      place(exp.toId, name);   // the route's room is the mapped exit we meant to take
      if (W.done === W.steps.length) finishWalk(); else pump();
      updateChip();
      return;
    }
  }
  const from = hereRoom();
  let to = null;
  autoWarned = false;
  if (automapOn() && positionSure() && dir && !from.exits[dir]) to = autoStep(from, dir, name);
  if (!to) to = resolveMove(from, dir, name);
  if (!to && C.here && !autoWarned) toast(`📍 ${who()}Lost: “${escapeHtml(name)}” isn't on the map (or not uniquely). Select it and press 📍 I'm here.`);
  place(to ? to.id : null, name);
}

// ---------- Walking a route ----------
// res is a findPath() result. Walk steps go out in chains; a train leg is one step of its own,
// ridden with /train wait + /train stop (see Trains below). Walks the acting character.
export function startWalk(res, fromGame = false) {
  if (C.W) stopWalk(null);
  const steps = res.steps.map((s, i) => s.type === "train"
    ? { train: true, lineName: s.lineName, toId: s.toId }
    : { dir: s.dir, toId: res.rooms[i + 1] });
  if (!steps.length) { toast("Nothing to walk."); return; }
  if (!alive(C)) { toast(`📡 ${who()}No MUSH tab answering. Open (or click into) the MUSH client tab first.`); return; }
  place(res.rooms[0]);   // you start the walk at the route's start
  const name = C.name;
  const W = C.W = { steps, sent: 0, done: 0, lastMove: Date.now(), timer: null, fromGame, retries: 0, phase: null };
  W.timer = setInterval(() => withChar(name, () => {
    // waiting for and riding a train take real time: no stall timeout then
    if (C.W === W && W.sent > W.done && W.phase !== "waiting" && W.phase !== "riding" && Date.now() - W.lastMove > L.stallSec * 1000)
      stopWalk(W.phase ? `The train didn't answer for ${L.stallSec}s.` : `No movement for ${L.stallSec}s (locked door, blocked, or you stopped?).`);
  }), 1000);
  pump();
  updateChip(); refreshLivePanel();
}
// Next chain, once the previous one has fully arrived. A short pause first: sent the instant the
// last move lands, the game may still count you as moving.
const CHAIN_GAP_MS = 300;
function pump(delay) {
  const W = C.W, name = C.name;
  if (delay === undefined) delay = W.sent ? CHAIN_GAP_MS : 0;
  if (W.sent > W.done || W.sent >= W.steps.length || W.pending) return;
  W.pending = setTimeout(() => withChar(name, () => {
    if (C.W !== W) return;
    W.pending = null;
    if (W.steps[W.sent].train) {
      // boards at once if the doors are open, otherwise when the train comes in
      sendCmds(["/train wait"]);
      W.sent++; W.phase = "requested"; W.lastMove = Date.now();
      updateChip(); refreshLivePanel();
      return;
    }
    let n = 0;   // a chain stops short of a train leg
    while (n < L.window && W.sent + n < W.steps.length && !W.steps[W.sent + n].train) n++;
    sendCmds([W.steps.slice(W.sent, W.sent + n).map(s => DIRWORD[s.dir]).join(" ")]);
    W.sent += n;
    W.lastMove = Date.now();   // the stall clock starts when the chain goes out
  }), delay);
}
// The game refused something. "Too quickly" means the chain wasn't taken: send what's left of it
// again after a pause. Anything else ("You can't go that way.") ends the walk right away.
function onSys(text) {
  const W = C.W;
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
  const W = C.W;
  const dest = S.map.rooms[W.steps[W.steps.length - 1].toId];
  clearInterval(W.timer); clearTimeout(W.pending); C.W = null;
  toast(`🏁 ${who()}Arrived at <b>${escapeHtml(dest ? dest.name : "?")}</b>.`);
  if (W.fromGame) reply(`Arrived at ${dest ? dest.name : "?"}.`);
  walkEnded();
}
// why = null: replaced by a new walk, say nothing.
export function stopWalk(why) {
  const W = C.W;
  if (!W) return;
  // mid train leg: stop waiting, or drop the chosen stop (cancel aboard keeps you on the train)
  if (W.phase && W.sent > W.done) sendCmds(["/train cancel"]);
  const queued = W.phase ? 0 : Math.max(0, W.sent - W.done), left = W.steps.length - W.done;
  clearInterval(W.timer); clearTimeout(W.pending); C.W = null;
  if (why !== null) {
    const msg = `Walk stopped. ${why || ""} ${left} step${left !== 1 ? "s" : ""} left` +
      (queued ? `, up to ${queued} more may still be walked from the last input.` : ".");
    toast("⏹ " + who() + msg);
    if (W.fromGame) reply(plain(msg));
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
  if ((m = TRAIN.aboard.exec(text))) C.riding = m[1];
  const W = C.W;
  const step = W && W.steps[W.done];
  if (step && step.train && W.sent > W.done && trainStep(step, text)) return;
  // position, walking or not
  if ((m = TRAIN.off.exec(text))) {
    C.riding = null;
    const st = stationNamed(m[1]);
    if (st) place(st.id, m[1]);
  } else if ((m = TRAIN.arriving.exec(text)) && C.riding) {
    const st = stationNamed(m[1]);
    if (st) place(st.id, m[1]);   // the ring rides along
  }
  updateChip(); refreshLivePanel();
}
// The current walk step is a train leg. Returns true when it fully handled the line.
function trainStep(step, text) {
  const W = C.W;
  const dest = S.map.rooms[step.toId];
  let m;
  W.lastMove = Date.now();
  if (TRAIN.waiting.test(text)) { W.phase = "waiting"; }
  else if (TRAIN.aboard.test(text)) {
    W.phase = "aboard";
    sendCmds([`/train stop ${dest.name}`]);
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
    C.riding = null;
    if (m[1] !== dest.name) {
      W.phase = null;   // already off the train: nothing to cancel
      stopWalk(`You got off at ${escapeHtml(m[1])}, not ${escapeHtml(dest.name)}.`);
      return false;     // the general handler still moves the ring to where you got off
    }
    W.done++; W.sent = W.done; W.phase = null;
    place(dest.id, m[1]);
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
// Runs for the character whose tab it was typed in, and answers there.
function reply(...lines) {
  if (C.via === "relay") relayDown({ kind: "reply", char: C.name, lines });
  else post("reply", { lines, char: C.name });
}
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
    C.gotoList = [target.id]; C.gotoFly = !!fly; C.gotoPreview = false;
    const unique = Object.values(S.map.rooms).filter(r => r.name === target.name).length === 1;
    return reply(`Route to ${target.name}: ${summary}.`, routeText(res),
      (unique ? `//goto ${fly ? "fly " : ""}${target.name} or ` : "") + "//goto 1 to walk it.");
  }
  startWalk(res, true);
  if (!C.W) return reply("Couldn't start the walk. Is this the linked PbN tab?");
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
    if (!C.W) return reply("Not walking.");
    return stopWalk("Stopped from the game.");
  }
  if (/^(help|\?)$/i.test(q)) return reply(...GOTO_HELP);
  if (/^\d+$/.test(q) && C.gotoList.length) {
    const r = S.map.rooms[C.gotoList[parseInt(q, 10) - 1]];
    return r ? gotoRoomFromGame(r, C.gotoFly, C.gotoPreview) : reply(`Pick a number from 1 to ${C.gotoList.length}.`);
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
  C.gotoList = shown.map(x => x.r.id);
  C.gotoFly = fly;
  C.gotoPreview = preview;
  reply(`${hits.length} rooms match "${q}":`,
    ...shown.map((x, i) => `${i + 1}. ${x.r.name} · ${roomLocation(x.r)}` +
      (x.steps === Infinity ? (here ? " · no route" : "") : x.steps === 0 ? " · you are here" : ` · ${x.steps} step${x.steps !== 1 ? "s" : ""}`)),
    (hits.length > shown.length ? `…and ${hits.length - shown.length} more. ` : "") + `Type //goto <number> to pick one${fly ? " (flying)" : ""}${preview ? " (route only)" : ""}, or be more specific.`);
}

// ---------- Toolbar chip + panel ----------
// Both always show the focused character, even when redrawn while acting for another one.
function updateChip() { withChar(focus, drawChip); }
function drawChip() {
  const btn = document.getElementById("liveBtn");
  if (!btn) return;
  btn.style.display = L.bridge ? "" : "none";
  const anyAlive = Object.values(CH).some(alive);
  btn.classList.toggle("live-on", anyAlive || L.sending);
  btn.classList.toggle("live-update", bridgeOutdated());
  if (L.sending) {
    btn.textContent = "📡 Sending to linked device";
    btn.title = "This browser's game goes to the mapper on a linked device.";
    return;
  }
  const W = C.W;
  const issues = issueCount();
  const train = W && W.phase === "waiting" ? "🚆 waiting" : C.riding ? `🚆 ${C.riding}` : null;
  btn.textContent = (train || (W ? `🚶 ${W.done}/${W.steps.length}` : anyAlive ? "📡 Live" : "📡 No MUSH tab")) +
    (issues ? ` · ⚠${issues}` : "") + (automapOn() ? " · 🤖" : "");
  btn.title = bridgeOutdated() ? "A newer version of the bridge userscript is available. Click to update." :
    W ? "Walking a route. Click for details or to stop." :
    anyAlive ? "Linked to the MUSH client: following your position." :
    "The bridge userscript is installed, but no MUSH client tab is answering. Open the client, or click into it.";
}
export function refreshLivePanel() {
  const panel = document.getElementById("livePanel");
  if (!panel || panel.style.display !== "block") return;
  if (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // don't eat a half-typed number
  withChar(focus, buildLivePanel);
}
function buildLivePanel() {
  const body = document.getElementById("liveBody");
  const pill = document.getElementById("liveStatus");
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
  if (L.sending) {
    pill.className = "livepill on"; pill.textContent = "Sending";
    body.innerHTML = `<div class="livecard"><div class="livelabel">Linked device</div>
      <div class="livedone">✓ Linked. You can close this tab.</div>
      <div class="livesub">The PbN tab in this browser sends its moves to the mapper on your linked device by
      itself, and walks that mapper's routes. This mapper isn't needed for that.</div>
      <div class="livesub">To stop: open the mapper here again and press <b>Stop sending</b>.</div>
      <div class="histbtns"><button class="livebtn danger" id="relayUnpair">Stop sending</button></div></div>`;
    on("relayUnpair", "onclick", () => { post("unpair"); });
    return;
  }
  const r = hereRoom();
  const anyAlive = Object.values(CH).some(alive);
  pill.className = "livepill" + (anyAlive ? " on" : "");
  pill.textContent = anyAlive ? "Connected" : "No MUSH tab";
  if (L.namesOpen && C.name && namesOf(C.name).length > 1) return buildNamesView(body);
  L.namesOpen = false;

  let h = "";
  if (bridgeOutdated()) {
    h += `<div class="livecard liveupdate"><div><b>Bridge update</b><div class="livesub">${escapeHtml(L.bridgeV)} → ${escapeHtml(L.latestV)}</div></div>
      <a class="livebtn primary" href="${BRIDGE_URL}" target="_blank" rel="noopener">Update</a></div>`;
  }
  // several characters: one row each, click to follow that one
  const chars = known();
  if (chars.length > 1 || (chars.length === 1 && chars[0].name !== focus)) {
    h += `<div class="livecard"><div class="livelabel">Characters</div>` + chars.map(c => {
      const rm = roomOf(c);
      return `<button class="livechar${c.name === focus ? " on" : ""}" data-focus="${escapeAttr(c.name)}" title="Follow ${escapeAttr(c.name || "?")} on the map">
        <span class="livedot${alive(c) ? " on" : ""}"></span><b>${escapeHtml(c.name || "?")}</b>
        <span class="livesub">${c.shown ? "as " + escapeHtml(c.shown) + " · " : ""}${rm ? escapeHtml(rm.name) : "position unknown"}${c.via === "relay" ? " · linked device" : ""}${c.W ? " · 🚶" : ""}</span></button>`;
    }).join("") + `</div>`;
  }
  const names = C.name ? namesOf(C.name) : [];
  const namesLine = names.length > 1 ? `<button class="linkbtn livenames" id="liveNames" title="This character's names (masks): pick the main one, forget old ones">` +
    `🎭 ${names.length} names${A.picked[C.name] ? "" : " · main name guessed, pick one"} ▸</button>` : "";
  h += `<div class="livecard">` + (r
    ? `<div class="livelabel">${C.name ? escapeHtml(C.name) + " is in" : "You are in"}</div>
       <div class="livehere">
         <button class="liveroom" id="liveGoto" title="Show on the map">${escapeHtml(r.name)}</button>
         <button class="liveicon" id="liveForget" title="Forget this position">✕</button>
       </div>
       <div class="livesub">${escapeHtml(roomLocation(r))}${C.sure ? "" : " · not confirmed by the game yet"}</div>`
    : `<div class="livelabel">${C.name ? escapeHtml(C.name) + " is in" : "You are in"}</div>
       <div class="livesub">Unknown. Move once in the game, or select the room and press <b>📍 I'm here</b>.</div>`) +
    namesLine + `</div>`;
  const W = C.W;
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
      `<button class="livebtn" id="autoVerifyAll" title="Mark every auto-created room ✓ Verified">Verify all (${autos.length})</button>` +
      `<button class="livebtn danger" id="autoDelAll" title="Delete every unverified auto-created room">Delete all (${autos.length})</button></div>`;
  }
  h += `<div class="livelabel livesettings">Gathering${C.name ? " · " + escapeHtml(C.name) : ""}</div>` + gatherHtml();
  h += historyHtml();
  h += relayHtml();
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

  body.querySelectorAll("[data-focus]").forEach(b => b.onclick = () => setFocus(b.dataset.focus));
  on("liveNames", "onclick", () => { L.namesOpen = true; buildLivePanel(); });
  on("liveGoto", "onclick", () => gotoRoom(r.id));
  on("liveStop", "onclick", () => stopWalk("Stopped by you."));
  on("liveFollow", "onchange", e => { L.follow = e.target.checked; saveLive(); if (L.follow && r) followTo(r); });
  on("liveForget", "onclick", () => place(null));
  on("liveGhostClear", "onclick", () => { clearGhosts(); buildLivePanel(); });
  wireIssues(body, buildLivePanel);
  on("autoDelRecent", "onclick", () => deleteAutoRooms(true));
  on("autoDelAll", "onclick", () => deleteAutoRooms(false));
  on("autoVerifyAll", "onclick", () => {
    const list = Object.values(S.map.rooms).filter(x => x.auto);
    if (!list.length || !confirm(`Mark all ${list.length} auto-created room${list.length !== 1 ? "s" : ""} ✓ Verified? Ctrl+Z undoes it.`)) return;
    for (const x of list) { delete x.auto; delete x.autoAt; }
    commit(); render(); buildLivePanel();
    toast(`✓ Verified ${list.length} room${list.length !== 1 ? "s" : ""}.`);
  });
  wireHistory();
  wireRelay();
  on("liveGhostReset", "onclick", () => { resetDismissed(); buildLivePanel(); });
  wireStepper("liveWindow", v => { L.window = clamp(v, 1, 5); saveLive(); return L.window; });
  wireStepper("liveStall", v => { L.stallSec = clamp(v, 5, 300); saveLive(); return L.stallSec; });
}
// The focused character's names (masks), however many: the main one first, then the most recently
// seen. A filter box from 8 names up; the list itself scrolls.
const ago = t => {
  if (!t) return "not seen yet";
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
function buildNamesView(body) {
  const main = C.name;
  const names = namesOf(main);
  const rows = [main, ...names.slice(1).sort((a, b) => (A.seen[b] || 0) - (A.seen[a] || 0))];
  body.innerHTML = `<div class="livecard">
      <div class="livewalkhead"><div><div class="livelabel">Names of this character</div><b>${escapeHtml(main)}</b></div>
        <button class="livebtn" id="namesBack">‹ Back</button></div>
      <div class="livesub">◉ is the main name: positions, night counts and History are filed under it.
        ${A.picked[main] ? "You picked it." : "<b>Guessed</b>: pick the right one."}
        ✕ forgets a mask you no longer have; if it's used again, it's added again.</div>
      ${names.length >= 8 ? `<input type="text" id="namesFilter" class="namesfilter" placeholder="Filter ${names.length} names…">` : ""}
      <div class="namelist">` + rows.map(n => `
        <div class="namerow${n === main ? " main" : ""}" data-name="${escapeAttr(n.toLowerCase())}">
          <label title="${n === main ? "The main name" : "Make this the main name"}"><input type="radio" name="mainName" value="${escapeAttr(n)}"${n === main ? " checked" : ""}>
            <span class="nm">${escapeHtml(n)}</span></label>
          <span class="livesub">${ago(A.seen[n])}</span>
          ${n === main ? `<span class="livesub nmtag">main</span>` : `<button class="liveicon" data-forget="${escapeAttr(n)}" title="Forget this name">✕</button>`}
        </div>`).join("") + `</div></div>`;
  document.getElementById("namesBack").onclick = () => { L.namesOpen = false; buildLivePanel(); };
  const filter = document.getElementById("namesFilter");
  if (filter) filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    body.querySelectorAll(".namerow").forEach(el => { el.style.display = !q || el.dataset.name.includes(q) ? "" : "none"; });
  };
  body.querySelectorAll('input[name="mainName"]').forEach(el => el.onchange = () => { pickMainName(main, el.value); buildLivePanel(); });
  body.querySelectorAll("[data-forget]").forEach(b => b.onclick = () => { forgetName(b.dataset.forget); buildLivePanel(); });
}
// Unverified auto-created rooms, all or just the last hour's: one undo step brings them back.
function deleteAutoRooms(recentOnly) {
  const ids = Object.values(S.map.rooms)
    .filter(x => x.auto && (!recentOnly || (x.autoAt && Date.now() - x.autoAt < 3600e3))).map(x => x.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} unverified auto-created room${ids.length !== 1 ? "s" : ""}` +
    `${recentOnly ? " from the last hour" : ""}? Exits to them are removed too. Ctrl+Z undoes it.`)) return;
  for (const id of ids) deleteRoom(id);
  for (const c of Object.values(CH)) if (c.here && !S.map.rooms[c.here]) withChar(c.name, () => place(null));
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

// ---------- Relay: a PbN tab on another device ----------
// This mapper makes a link on the site's API (server/app.py) and shows its code; the other
// device's mapper page hands the code to its bridge ("pair"), and
// from then on that browser's PbN tab posts its events to the link and polls it for commands,
// while this mapper polls the events and posts the commands. This browser's own PbN tab stays on
// the direct way. Only polls while a link exists, so nobody else ever talks to the server for it.
const RELAY_KEY = "mushMapEditor.relay.v1";
const RELAY_POLL_MS = 1000, RELAY_PING_MS = 5000;
const R = { code: null, after: -1, busy: false, out: [], outBusy: false, seenAt: 0, error: null };
const relayUrl = path => `${API_BASE}/relay/${encodeURIComponent(R.code)}${path}`;
function loadRelay() { try { R.code = localStorage.getItem(RELAY_KEY) || null; } catch (e) { /* ignore */ } }
function saveRelay() { try { R.code ? localStorage.setItem(RELAY_KEY, R.code) : localStorage.removeItem(RELAY_KEY); } catch (e) { /* ignore */ } }
async function relayCreate() {
  try {
    const res = await fetch(`${API_BASE}/relay`, { method: "POST", headers: { "X-Client-Key": CLIENT_KEY } });
    if (!res.ok) throw new Error(res.status);
    R.code = (await res.json()).code; R.after = -1; R.seenAt = 0; R.error = null;
    saveRelay();
  } catch (e) {
    toast("📡 Couldn't reach the server to make a link. Try again in a moment.");
  }
  refreshLivePanel();
}
function relayEnd(why) {
  const code = R.code;
  R.code = null; R.out = []; saveRelay();
  for (const c of Object.values(CH)) if (c.via === "relay") withChar(c.name, () => { if (C.W) stopWalk(null); C.clientAt = 0; });
  pathChar.relay = null;
  if (why === "unlink" && code) fetch(`${API_BASE}/relay/${encodeURIComponent(code)}`, { method: "DELETE", headers: { "X-Client-Key": CLIENT_KEY } }).catch(() => {});
  else if (why) toast("📡 " + why);
  updateChip(); refreshLivePanel();
}
async function relayPoll() {
  if (!R.code || R.busy) return;
  R.busy = true;
  try {
    const res = await fetch(relayUrl(`/up?after=${R.after}`), { cache: "no-store" });
    if (res.status === 404) return relayEnd("The device link has expired. Make a new one in the 📡 panel.");
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    const first = R.after < 0;
    R.after = j.last; R.error = null;
    if (!first) for (const ev of j.items || []) onRelayItem(ev);
  } catch (e) {
    R.error = "Can't reach the server right now.";
  } finally { R.busy = false; }
}
function onRelayItem(ev) {
  if (!ev || typeof ev !== "object") return;
  R.seenAt = Date.now();
  const name = typeof ev.char === "string" && ev.char ? identify(ev.char, ev.sess) : pathChar.relay || "";
  if (ev.kind === "pong") {
    notePath("relay", name);
    charState(name).clientAt = Date.now();
    updateChip(); refreshLivePanel();
    return;
  }
  if (["move", "room", "sys", "train", "gather", "goto"].includes(ev.kind))
    handleEvent({ ...ev, type: ev.kind, char: name }, "relay");
}
function relayDown(item) {
  if (!R.code) return;
  R.out.push(item);
  flushDown();
}
async function flushDown() {
  if (R.outBusy || !R.out.length || !R.code) return;
  R.outBusy = true;
  const batch = R.out.slice(0, 50);
  let ok = false;
  try {
    const res = await fetch(relayUrl("/down"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: batch }) });
    if (res.ok) { R.out = R.out.slice(batch.length); ok = true; }
  } catch (e) { /* offline: try again with the next item or ping */ }
  R.outBusy = false;
  if (R.out.length > 100) R.out = R.out.slice(-100);
  if (ok && R.out.length) flushDown();   // queued while this batch was on its way
}
setInterval(relayPoll, RELAY_POLL_MS);
setInterval(() => { if (R.code) relayDown({ kind: "ping" }); }, RELAY_PING_MS);   // lets the other tab's //goto know we're here
function relayHtml() {
  if (!L.bridge) return "";
  let h = `<div class="livelabel livesettings">Link another device</div>`;
  if (!R.code) {
    return h + `<div class="livesetting"><div><div>Play from another device</div>
        <div class="livesub">Its moves show up on this map too, each character with their own marker</div></div></div>
      <div class="histbtns"><button class="livebtn" id="relayCreate">Link a device</button>
        <button class="livebtn" id="relayJoin" title="Use on the other device: enter the code shown by the mapper you want to feed">Enter a code…</button></div>`;
  }
  const remote = Object.values(CH).filter(c => c.via === "relay" && alive(c));
  return h + `<div class="livesetting"><div><div>Link code</div>
      <div class="livesub">On the other device (bridge installed): open this mapper, 📡 → <b>Enter a code…</b></div></div></div>
    <div class="relaycode"><code id="relayCode">${escapeHtml(R.code)}</code><button class="livebtn" id="relayCopy">Copy</button></div>
    <div class="livesub">${R.error ? escapeHtml(R.error) : remote.length ? "Connected: " + remote.map(c => escapeHtml(c.name || "?")).join(", ") :
      "Waiting for the other device's PbN tab…"}</div>
    <div class="histbtns"><button class="livebtn danger" id="relayUnlink">Unlink</button></div>`;
}
function wireRelay() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("relayCreate", relayCreate);
  on("relayUnlink", () => relayEnd("unlink"));
  on("relayCopy", () => {
    const b = document.getElementById("relayCopy");
    navigator.clipboard.writeText(R.code).then(() => { b.textContent = "✓"; setTimeout(() => { b.textContent = "Copy"; }, 1000); }).catch(() => {});
  });
  on("relayJoin", async () => {
    const code = (prompt("Code from the mapper on your other device:") || "").trim();
    if (!code) return;
    try {
      const res = await fetch(`${API_BASE}/relay/${encodeURIComponent(code)}/down`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
    } catch (e) { toast("📡 That code doesn't work (mistyped, or the link was ended)."); return; }
    post("pair", { code, api: new URL(API_BASE, location.href).href });
  });
}

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
    if (L.sending !== !!m.sending) {
      L.sending = !!m.sending;
      if (L.sending && R.code) relayEnd("unlink");   // can't both feed another mapper and be fed
      if (L.sending) toast(first ? "📡 This browser sends to your linked device. This tab isn't needed for that; close it any time."
        : "✓ Linked to your other device. You can close this tab now: the PbN tab sends on its own.");
      else if (!first) toast("📡 Stopped sending to the linked device.");
      render();
    }
    if (first) checkBridgeVersion();
    updateChip(); refreshLivePanel();
    document.getElementById("bridgeOffer").style.display = "none";
    if (first) render();   // the inspector and path box grow live buttons
    return;
  }
  if (L.sending) return;   // this browser's game is followed by the mapper on the linked device
  if (m.type === "client") {
    // a pong without a name (journal not loaded yet) still says the tab is there
    const name = m.char ? identify(String(m.char), m.sess) : pathChar.direct;
    if (name !== null) {
      if (m.char) notePath("direct", name);
      charState(name).clientAt = Date.now();
    }
    updateChip(); refreshLivePanel();
  } else if (["move", "sys", "train", "gather", "room"].includes(m.type) && S.map) {
    queueGameEvent(m);
  } else if (m.type === "goto") {
    handleEvent(m, "direct");
  }
});
// One game event, for the character it belongs to. Moving (or typing //goto) puts that character
// in focus: it's the one being played right now.
function handleEvent(e, via) {
  const name = typeof e.char === "string" && e.char ? identify(e.char, e.sess) : pathChar[via] || "";
  notePath(via, name);
  withChar(name, () => {
    C.via = via; C.seenAt = C.clientAt = Date.now();
    if (typeof e.char === "string" && e.char) C.shown = e.char !== C.name ? e.char : null;
    if (e.type === "move" || e.type === "goto" || !known().some(c => c.name === focus)) setFocus(name);
    if (e.type === "room") onRoom(e.room);
    else if (e.type === "move") onMove(String(e.dir || ""), String(e.name || ""));
    else if (e.type === "sys") onSys(String(e.text || ""));
    else if (e.type === "train") onTrain(String(e.text || ""));
    else if (e.type === "gather") { onGather(String(e.text || "")); refreshLivePanel(); }
    else if (e.type === "goto") onGoto(e.q);
  });
}
// Each way in (this browser's bridge, the relay) plays one character at a time. When it reports
// another one, that browser switched characters: the one before has left the game there, so their
// walk stops, and the new one's remembered position needs the game's confirmation before anything
// is mapped from it (the room panel the bridge sends right after a switch does that).
function notePath(via, name) {
  const prev = pathChar[via];
  if (prev === name) return;
  pathChar[via] = name;
  const c = charState(name);
  c.via = via; c.sure = false;
  if (prev === null) return;
  withChar(prev, () => { if (C.W) stopWalk("You switched characters."); C.clientAt = 0; C.sure = false; });
  if (focus === prev) setFocus(name);
  toast(`👤 Switched to ${escapeHtml(name || "another character")}: finding where they are…`);
  syncMarkers(); render();
}
// Safety net against replayed chat (bridges before 1.6.2 re-read the whole chat when you switched
// chat tabs): in-game moves take time, so game events never come fractions of a second apart.
// Panel snapshots ("room") go through the same queue so they're never handled before the move
// they belong to (a snapshot overtaking its move made the move look like it started from its own
// destination). They don't count toward a burst and are kept even in one: they show the panel as
// it really is.
// They're held for a moment; BURST_N or more in one rush are a replay and are dropped together.
// Only for this browser's bridge: the relay needs a current one, which never replays.
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
    for (const e of q) handleEvent(e, "direct");
  }, BURST_QUIET_MS);
}
// notice a closed MUSH tab, and drop markers of characters that went quiet
setInterval(() => { if (L.bridge) { const before = JSON.stringify(S.alts); syncMarkers(); if (JSON.stringify(S.alts) !== before) render(); updateChip(); refreshLivePanel(); } }, 5000);
onIssuesChange(() => { updateChip(); refreshLivePanel(); });
onHistoryChange(() => refreshLivePanel());
window.addEventListener("hashchange", () => { updateChip(); if (automapOn()) toast("🤖 Auto-map on"); });
loadAliases();
loadLive();
loadRelay();
post("probe");
