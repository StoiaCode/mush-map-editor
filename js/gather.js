import { S } from "./state.js";
import { createTrait } from "./model.js";
import { commit } from "./persistence.js";
import { render } from "./app.js";
import { toast } from "./spaces.js";
import { escapeHtml } from "./utils.js";
import { hereRoom, positionSure, automapOn } from "./live.js";

// ---------- Scavenging & harvesting (live.js) ----------
// The bridge reports when /scavenge or /harvest is sent, and the result lines. From that:
//   success   "[You haul away 2 units of paper stock.]" / "[You gather 1 unit of ritual herbs.]"
//             → (auto-map) the room gets that material's trait, created on first find
//   nothing   "There is nothing worth scavenging here." / "...of ritual use to gather here.", and the
//             aloft versions "...to scavenge in the open air." / "...to gather here but empty air."
//             → no site: a wrong "Unknown" mark is taken off
//   capped    "You have gathered all the night will give you." (harvest) / "You have pushed your luck
//             across the city enough for one night." (scavenge) → says nothing about the room; the
//             night's counter for that kind goes to 4/4
//   neither within a few seconds → a failed roll (caught, locked…): there IS a site, material not
//             known yet → (auto-map) "Unknown scavenge"/"Unknown harvest", if the room has no mark
//             of that kind yet
// Every room always yields the same material. Traits made here carry `gather: "scavenge"|"harvest"`.
// Separately, per browser: successful hauls per game night (cap 4 each; the night turns over at
// 17:00 Berlin time) and which rooms you've tapped tonight, dimmed on the map.

const FAIL_WAIT_MS = 6000;
const NIGHT_CAP = 4;
const SCAV_EMOJI = {
  "scrap steel": "🔩", "scrap electronics": "🔌", "crude chemicals": "🧪", "cadaver tissue": "🫀",
  "stripped surplus": "🧥", "paper stock": "📄", "studio salvage": "🎨",
};
const UNKNOWN = {
  scavenge: { label: "Unknown scavenge", emoji: "❓" },
  harvest:  { label: "Unknown harvest",  emoji: "❔" },
};
const SUCCESS_RE = /^\[You (haul away|gather) \d+ units? of (.+?)\.\]$/;
const NOTHING_RE = /^There is nothing (worth scavenging|of ritual use to gather|to scavenge in the open air|to gather here but empty air)/;
const CAPPED_RE = /^You have (gathered all the night will give you|pushed your luck across the city enough for one night)/;

// ---------- Game night ----------
// "2026-10-14" for the night that began at 17:00 Berlin time on that date.
let nightCache = { at: 0, id: "" };
export function nightId(now = Date.now()) {
  if (Math.abs(now - nightCache.at) < 30000) return nightCache.id;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  let day = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  if (+parts.hour < 17) day -= 86400000;   // before 17:00 it's still last night
  nightCache = { at: now, id: new Date(day).toISOString().slice(0, 10) };
  return nightCache.id;
}

const NIGHT_KEY = "mushMapEditor.gather.v1";
let N = { night: "", scavenge: [], harvest: [] };   // room ids with a successful haul tonight
function loadNight() {
  try { const o = JSON.parse(localStorage.getItem(NIGHT_KEY) || "{}"); if (o && o.night) N = { scavenge: [], harvest: [], ...o }; }
  catch (e) { /* no storage: counts just start at zero */ }
  if (N.night !== nightId()) N = { night: nightId(), scavenge: [], harvest: [] };
}
function saveNight() { try { localStorage.setItem(NIGHT_KEY, JSON.stringify(N)); } catch (e) { /* ignore */ } }
function tonight() { if (N.night !== nightId()) { N = { night: nightId(), scavenge: [], harvest: [] }; saveNight(); } return N; }
loadNight();

export function tappedTonight(roomId) { const n = tonight(); return n.scavenge.includes(roomId) || n.harvest.includes(roomId); }
export function gatherHtml() {
  const n = tonight();
  return `<div class="livesetting"><div><div>Tonight</div><div class="livesub">Resets at 17:00 Berlin time</div></div>
    <div class="gathercount"><span title="Successful scavenges tonight">🔩 ${n.scavenge.length}/${NIGHT_CAP}</span>
    <span title="Successful harvests tonight">🌿 ${n.harvest.length}/${NIGHT_CAP}</span></div></div>`;
}

// ---------- Traits ----------
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const traitById = id => S.map.traits.find(t => t.id === id);
function findTrait(label) { return S.map.traits.find(t => t.label.toLowerCase() === label.toLowerCase()) || null; }
// Harvest reagents get letters: "Grave earth" → G, or GE when G is taken, then GR, GRA…
function letterIcon(material) {
  const taken = new Set(S.map.traits.map(t => t.emoji));
  const w = material.toUpperCase().split(/\s+/).filter(Boolean);
  const tries = [w[0][0], w[1] ? w[0][0] + w[1][0] : null, w[0].slice(0, 2), w[0].slice(0, 3)].filter(Boolean);
  return tries.find(t => !taken.has(t)) || w[0].slice(0, 3);
}
function ensureTrait(label, emoji, kind) {
  let t = findTrait(label);
  if (!t) { t = createTrait(emoji, label); t.gather = kind; }
  return t;
}
function hasKind(r, kind) { return r.traits.some(id => { const t = traitById(id); return t && t.gather === kind; }); }
function removeUnknown(r, kind) {
  const u = findTrait(UNKNOWN[kind].label);
  if (!u || !r.traits.includes(u.id)) return false;
  r.traits = r.traits.filter(id => id !== u.id);
  return true;
}

// ---------- Events ----------
const pending = {};   // kind -> { roomId, timer }
function settle(kind) { if (pending[kind]) { clearTimeout(pending[kind].timer); delete pending[kind]; } }

export function onGather(text) {
  if (!S.map) return;
  const sent = /^\/(scavenge|harvest)$/.exec(text);
  if (sent) {
    const kind = sent[1];
    settle(kind);
    const roomId = positionSure() ? hereRoom().id : null;
    pending[kind] = { roomId, timer: setTimeout(() => {
      delete pending[kind];
      const r = roomId && S.map.rooms[roomId];
      // no result line in time: a failed roll, so there is a site here, of an unknown kind
      if (!r || !automapOn() || hasKind(r, kind)) return;
      const u = ensureTrait(UNKNOWN[kind].label, UNKNOWN[kind].emoji, kind);
      r.traits.push(u.id);
      commit(); render();
    }, FAIL_WAIT_MS) };
    return;
  }
  let m;
  if ((m = SUCCESS_RE.exec(text))) {
    const kind = m[1] === "haul away" ? "scavenge" : "harvest";
    const material = m[2].trim().toLowerCase();
    settle(kind);
    const r = positionSure() ? hereRoom() : null;
    const n = tonight();
    if (r && !n[kind].includes(r.id)) n[kind].push(r.id);
    else if (!r) n[kind].push("?" + Date.now());   // counts toward the cap even if we don't know where
    saveNight();
    if (r && automapOn()) {
      const t = ensureTrait(cap(material), SCAV_EMOJI[material] || letterIcon(material), kind);
      const changed = removeUnknown(r, kind) || !r.traits.includes(t.id);
      if (!r.traits.includes(t.id)) {
        r.traits.push(t.id);
        toast(`${escapeHtml(t.emoji)} <b>${escapeHtml(r.name)}</b> marked: ${escapeHtml(t.label)}`);
      }
      if (changed) commit();
    }
    render();
    return;
  }
  if ((m = CAPPED_RE.exec(text))) {
    const kind = m[1].startsWith("gathered") ? "harvest" : "scavenge";
    settle(kind);
    const n = tonight();
    while (n[kind].length < NIGHT_CAP) n[kind].push("?" + n[kind].length);   // hauls we didn't see
    saveNight(); render();
    return;
  }
  if ((m = NOTHING_RE.exec(text))) {
    const kind = /scaveng/.test(m[1]) ? "scavenge" : "harvest";
    settle(kind);
    const r = positionSure() ? hereRoom() : null;
    if (r && automapOn() && removeUnknown(r, kind)) { commit(); render(); }
  }
}
