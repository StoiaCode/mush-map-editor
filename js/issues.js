import { DIRS, DIRWORD } from "./constants.js";
import { S } from "./state.js";
import { escapeHtml } from "./utils.js";
import { setExitFly } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { gotoRoom } from "./inspector.js";

// ---------- Things to check (live.js) ----------
// Where your map and the game disagree, collected while you walk. Exits are compared by the
// destination NAME the game's compass shows, never by grid position: exits can lead several
// tiles away. Both directions: what the map has that the game doesn't, and the other way round.
// Not checked: an exit on the map that the game's compass doesn't show. Flight, hidden and locked
// exits made that one wrong far more often than right.
// Kept per browser; an entry disappears by itself once the disagreement is gone (checked again
// whenever you're back in that room), and a dismissed one stays dismissed while it's unchanged.
//
// Entry: { type, roomId, dir, game, mapTo, at }
//   other      map's dir leads to mapTo, the game's to `game`             fix: relink (unique name)
//   fly / nofly  the game says flight-only / a normal exit, map disagrees  fix: (un)mark ✈
//   missing    the game has exit dir to `game`, map has nothing           fix: link (unique name) or
//                                                                          note it as unexplored
//   arrived    walked dir, map said mapTo, arrived in `game`              fix: relink (unique name)
//   name       the game calls this room `game`                            fix: rename the tile
//   desc/image the game's description / image differs (low priority)      fix: use the game's

const ISSUE_KEY = "mushMapEditor.issues.v1";
const I = { items: {}, dismissed: {} };   // key -> entry; key -> signature it was dismissed at
const LOW = new Set(["desc", "image"]);
const keyOf = e => `${e.type}|${e.roomId}|${e.dir || ""}`;
const sigOf = e => `${e.game || ""}|${e.mapTo || ""}`;

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(ISSUE_KEY) || "{}");
    if (o.items && typeof o.items === "object") I.items = o.items;
    for (const [k, e] of Object.entries(I.items)) if (e.type === "extra") delete I.items[k];   // no longer checked
    if (o.dismissed && typeof o.dismissed === "object") I.dismissed = o.dismissed;
  } catch (e) { /* no storage: the list just starts empty each visit */ }
}
function save() { try { localStorage.setItem(ISSUE_KEY, JSON.stringify(I)); } catch (e) { /* ignore */ } }
load();

let onChange = () => {};
export function onIssuesChange(fn) { onChange = fn; }

function put(e) {
  const k = keyOf(e);
  if (I.dismissed[k] === sigOf(e)) return;
  const old = I.items[k];
  if (old && sigOf(old) === sigOf(e)) return;
  I.items[k] = { ...e, at: Date.now() };
}
const same = (a, b) => (a || "").replace(/\s+/g, " ").trim() === (b || "").replace(/\s+/g, " ").trim();
function uniqueNamed(name) {
  if (!name) return null;
  const hits = Object.values(S.map.rooms).filter(r => r.name === name);
  return hits.length === 1 ? hits[0] : null;
}

// Re-check the room you're standing in against the game's side panel (bridge "room" snapshot).
export function checkRoom(r, snap) {
  if (!r || !snap) return;
  // everything about this room is decided fresh, except a walk's "arrived" findings
  for (const [k, e] of Object.entries(I.items)) if (e.roomId === r.id && e.type !== "arrived") delete I.items[k];
  if (r.name !== snap.name) {
    put({ type: "name", roomId: r.id, game: snap.name });
  } else {
    const exits = snap.exits || {};
    for (const d of DIRS) {
      const mapT = r.exits[d] ? S.map.rooms[r.exits[d]] : null;
      const g = exits[d] || null;
      if (mapT && g) {
        if (g.name && g.name !== mapT.name) put({ type: "other", roomId: r.id, dir: d, mapTo: mapT.name, game: g.name });
        const fly = !!(r.exitFly && r.exitFly[d]);
        if (g.aerial && !fly) put({ type: "fly", roomId: r.id, dir: d, mapTo: mapT.name });
        if (!g.aerial && fly) put({ type: "nofly", roomId: r.id, dir: d, mapTo: mapT.name });
      } else if (!mapT && g && !(r.openExits && r.openExits[d])) {
        put({ type: "missing", roomId: r.id, dir: d, game: g.name || null });
      }
    }
    // an earlier "arrived somewhere else" is settled once the map's exit names what the game names
    for (const [k, e] of Object.entries(I.items)) {
      if (e.type !== "arrived" || e.roomId !== r.id) continue;
      const t = r.exits[e.dir] && S.map.rooms[r.exits[e.dir]];
      if (t && t.name === e.game) delete I.items[k];
    }
    if (r.description && snap.description && !same(r.description, snap.description))
      put({ type: "desc", roomId: r.id, game: snap.description.slice(0, 2000) });
    if (r.imageUrl && snap.image && r.imageUrl !== snap.image)
      put({ type: "image", roomId: r.id, game: snap.image });
  }
  save(); onChange();
}

// A move along dir from `from` ended in a room the game calls `gameName`, not where the map's
// exit leads.
export function noteArrived(from, dir, gameName) {
  const t = from && from.exits[dir] && S.map.rooms[from.exits[dir]];
  if (!t || t.name === gameName) return;
  put({ type: "arrived", roomId: from.id, dir, mapTo: t.name, game: gameName });
  save(); onChange();
}

// ---------- Listing ----------
function live() {
  // entries whose room was deleted since are dropped quietly
  for (const [k, e] of Object.entries(I.items)) if (!S.map.rooms[e.roomId]) delete I.items[k];
  return Object.entries(I.items).sort((a, b) => b[1].at - a[1].at);
}
export function issueCount() { return live().filter(([, e]) => !LOW.has(e.type)).length; }

const D = d => DIRWORD[d] || d;
function describe(e, room) {
  const at = `<b>${escapeHtml(room.name)}</b>`, t = s => `<b>${escapeHtml(s)}</b>`;
  switch (e.type) {
    case "other":   return `${at}: ${D(e.dir)} goes to ${t(e.game)} in the game, to ${t(e.mapTo)} on your map.`;
    case "fly":     return `${at}: ${D(e.dir)} is flight-only in the game, a normal exit on your map.`;
    case "nofly":   return `${at}: ${D(e.dir)} is a normal exit in the game, flight-only on your map.`;
    case "missing": return `${at}: the game has an exit ${D(e.dir)}${e.game ? " to " + t(e.game) : " (flight)"}, your map doesn't.`;
    case "arrived": return `Going ${D(e.dir)} from ${at} you arrived in ${t(e.game)}; your map leads to ${t(e.mapTo)}.`;
    case "name":    return `The game calls ${at} “${t(e.game)}”.`;
    case "desc":    return `${at}: the game's description differs from yours.`;
    case "image":   return `${at}: the game shows a different image.`;
  }
  return "";
}
// [label, action] or null
function fixFor(e, room) {
  switch (e.type) {
    case "other": case "arrived": {
      const to = uniqueNamed(e.game);
      return to ? [`Relink to ${to.name}`, () => { room.exits[e.dir] = to.id; }] : null;
    }
    case "fly":   return ["Mark ✈", () => setExitFly(room.id, e.dir, true)];
    case "nofly": return ["Unmark ✈", () => setExitFly(room.id, e.dir, false)];
    case "missing": {
      const to = uniqueNamed(e.game);
      if (to) return [`Link to ${to.name}`, () => { room.exits[e.dir] = to.id; if (room.openExits) delete room.openExits[e.dir]; }];
      return ["Add as unexplored", () => { (room.openExits ||= {})[e.dir] = { name: e.game || null, fly: !e.game }; }];
    }
    case "name":  return ["Rename tile", () => { room.name = e.game; }];
    case "desc":  return ["Use the game's", () => { room.description = e.game; }];
    case "image": return ["Use the game's", () => { room.imageUrl = e.game; }];
  }
  return null;
}

let lowOpen = false;
export function issuesHtml() {
  const all = live();
  if (!all.length) return "";
  const main = all.filter(([, e]) => !LOW.has(e.type)), low = all.filter(([, e]) => LOW.has(e.type));
  const row = ([k, e]) => {
    const room = S.map.rooms[e.roomId], fix = fixFor(e, room);
    return `<div class="issue" data-issue="${escapeHtml(k)}"><div class="issue-text">${describe(e, room)}</div>
      <div class="issue-btns"><button class="livebtn" data-act="show">Show</button>` +
      (fix ? `<button class="livebtn primary" data-act="fix">${escapeHtml(fix[0])}</button>` : "") +
      `<button class="liveicon" data-act="dismiss" title="Dismiss">✕</button></div></div>`;
  };
  let h = `<div class="livelabel livesettings issue-hdr">Things to check${main.length ? ` (${main.length})` : ""}` +
    `<button class="linkbtn" id="issueClearAll" title="Dismiss every entry in this list">dismiss all</button></div>`;
  h += main.map(row).join("");
  if (low.length) {
    h += `<button class="issue-low" id="issueLowToggle">${lowOpen ? "▾" : "▸"} Descriptions &amp; images (${low.length})</button>`;
    if (lowOpen) h += low.map(row).join("");
  }
  return h;
}
export function wireIssues(container, rebuild) {
  const all = container.querySelector("#issueClearAll");
  if (all) all.onclick = () => {
    for (const [k, e] of Object.entries(I.items)) I.dismissed[k] = sigOf(e);
    I.items = {};
    save(); onChange(); rebuild();
  };
  const t = container.querySelector("#issueLowToggle");
  if (t) t.onclick = () => { lowOpen = !lowOpen; rebuild(); };
  container.querySelectorAll(".issue").forEach(el => {
    const k = el.dataset.issue, e = I.items[k];
    if (!e) return;
    el.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
      const room = S.map.rooms[e.roomId];
      if (b.dataset.act === "show") { gotoRoom(e.roomId); return; }
      if (b.dataset.act === "fix") {
        const fix = room && fixFor(e, room);
        if (fix) { fix[1](); commit(); render(); }
      } else {
        I.dismissed[k] = sigOf(e);
      }
      delete I.items[k];
      save(); onChange(); rebuild();
    });
  });
}
