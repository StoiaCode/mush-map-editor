// ---------- What's new popup ----------
// Newest entry first. To announce something, add an entry at the top with a new unique id:
// everyone whose browser last saw an older id gets the popup once on their next visit.
// "Seen" is stored per browser (localStorage), so a new device or cleared site data shows the
// latest entry again; that's fine for patch notes.
export const CHANGELOG = [
  {
    id: "2026-10-toolbar",
    date: "2026-10-02",
    title: "Toolbar cleanup",
    html: `
      <ul>
        <li><b>☰ Map ▾</b> (top right): Export, Import, Sync, What's new, New map.</li>
        <li><b>👁 View ▾</b>: Legend, Onion-skin, Stats.</li>
        <li>Link, Path, Area and Transit are grouped together.</li>
        <li>Zoom controls moved to the bottom-left corner of the map.</li>
      </ul>`,
  },
  {
    id: "2026-10-spaces",
    date: "2026-10-02",
    title: "Spaces",
    html: `
      <p><b>What it's for.</b> Some areas don't line up with the grid they hang off: upper floors too big
      to fit next to the street, interiors that open somewhere else entirely. A <b>space</b> is a separate
      pocket map for those rooms, attached to the main map through ordinary exits, which act as its doors.</p>
      <p><b>How it works.</b></p>
      <ul>
        <li>Each space has its own grid and layers; positions inside don't collide with the main map.</li>
        <li>Floors are numbered from the door: reached by going UP from outside = Floor +1, walked into = Floor 0.</li>
        <li>Exits, pathfinding and transit lines work across spaces as normal.</li>
      </ul>
      <p><b>Creating a space.</b></p>
      <ul>
        <li><b>From an exit:</b> select the outside room, click <b>⧉</b> next to the exit in the inspector. Everything reachable through that exit is selected.</li>
        <li><b>From a selection:</b> multi-select rooms → <b>⧉ Move N rooms into a space…</b></li>
        <li><b>Empty:</b> <b>⧉ Spaces → + New empty space</b>, then connect it with 🔗 Link.</li>
      </ul>
      <p>A preview opens first. Rooms that will move are highlighted and their future doors drawn in red.
      If they connect back to the outside room another way, the move is blocked and the route is shown;
      click a room on it to leave it out. The move is a single undo step.</p>
      <p><b>Moving rooms back.</b> <b>↩ Move all to main map…</b> in the Spaces panel, or
      <b>↩ Move N rooms to the main map…</b> on a selection. Place with the mouse (overlaps show red), click to drop.</p>
      <p><b>Finding your way.</b> The breadcrumb shows where you are. Inside a space the map has a coloured
      frame and a <b>↩ Main map</b> button. Switching spaces and undo/redo show a notice. Rooms with a door
      into a space get a <b>⧉</b> badge (click to go through). The <b>⧉ Spaces</b> panel lists every space
      and flags any that lost its last door.</p>
      <p class="hint">Existing maps load unchanged.</p>`,
  },
];

const SEEN_KEY = "mushMapEditor.changelogSeen";

function readSeen() { try { return localStorage.getItem(SEEN_KEY); } catch (e) { return null; } }
function markSeen() { try { localStorage.setItem(SEEN_KEY, CHANGELOG[0].id); } catch (e) { /* private mode etc. */ } }

// Entries newer than the last one this browser saw (all of them if it saw none).
function unseen() {
  const seen = readSeen();
  const i = CHANGELOG.findIndex(e => e.id === seen);
  return i === -1 ? CHANGELOG : CHANGELOG.slice(0, i);
}

const MAX_POPUP = 3;   // more unseen than this: show the newest few and point at the rest

export function showChangelog(entries = CHANGELOG, hidden = 0) {
  const box = document.getElementById("changelogModal");
  document.getElementById("changelogBody").innerHTML = entries.map(e =>
    `<section class="cl-entry"><h4>${e.title} <span class="cl-date">${e.date}</span></h4>${e.html}</section>`).join("") +
    (hidden ? `<p class="hint cl-more">…and ${hidden} older update${hidden !== 1 ? "s" : ""}. Read ${hidden !== 1 ? "them" : "it"} any time under <b>☰ Map ▾ → 📰 What's new</b>.</p>` : "");
  box.style.display = "flex";
  document.getElementById("changelogOk").focus();
}
function closeChangelog() {
  document.getElementById("changelogModal").style.display = "none";
  markSeen();
}

// Called once at startup. `hadMap`: whether this browser already had a saved map before this
// load. Brand-new visitors don't need patch notes, so they're just marked as up to date.
export function initChangelog(hadMap) {
  if (!hadMap) { if (!readSeen()) markSeen(); return; }
  const fresh = unseen();
  if (fresh.length) showChangelog(fresh.slice(0, MAX_POPUP), Math.max(0, fresh.length - MAX_POPUP));
}

document.getElementById("changelogOk").onclick = closeChangelog;
document.getElementById("whatsNewBtn").onclick = () => showChangelog();
document.getElementById("changelogModal").addEventListener("mousedown", e => {
  if (e.target.id === "changelogModal") closeChangelog();   // click the backdrop
});
window.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("changelogModal").style.display === "flex") {
    e.stopImmediatePropagation(); closeChangelog();
  }
}, true);
