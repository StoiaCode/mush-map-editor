import { PALETTE } from "./constants.js";
import { S } from "./state.js";
import { uid, escapeHtml, escapeAttr, areaHex } from "./utils.js";
import { spaceOf, curSpace, layersPresent } from "./model.js";
import { commit } from "./persistence.js";
import { render, fitInitial } from "./app.js";
import { positionPopover } from "./toolbar.js";
import { gotoRoom } from "./inspector.js";
import { centerCellView } from "./render-flat.js";
import { GRID_N } from "./constants.js";
import { startRelease } from "./release.js";
import { MAIN_NAME, doorsOf, roomsInSpace, roomLocation, setSpace, spaceColor, toast } from "./spaces.js";

// ---------- Spaces panel ----------
// The "nothing is ever unreachable" list (docs/plans/spaces.md, rule 4): every space with its
// room count and doors, orphaned spaces (no doors left) flagged and sorted first, and a way in.

// One entry per outside↔inside room pair, preferring the direction you'd walk to get in.
function doorPairs(spaceId) {
  const pairs = new Map();
  for (const d of doorsOf(spaceId)) {
    const key = d.outside.id + "|" + d.inside.id;
    const prev = pairs.get(key);
    if (!prev || (d.entering && !prev.entering)) pairs.set(key, d);
  }
  return [...pairs.values()];
}
const DIRWORD = { UP: "↑ up", DOWN: "↓ down" };
function doorLabel(d) {
  const dir = d.entering ? (DIRWORD[d.dir] || d.dir) : "from " + d.dir;
  return `${d.outside.name} (${roomLocation(d.outside)}) ${dir}`;
}

// Enter a space: land on the room its first door leads to, or just open it if it has none.
export function enterSpace(id) {
  const d = doorPairs(id).find(x => x.entering) || doorPairs(id)[0];
  if (d) { gotoRoom(d.inside.id); return; }
  const rooms = roomsInSpace(id);
  if (rooms.length) { gotoRoom(rooms[0].id); return; }
  setSpace(id, 0);
  render(); centerCellView(GRID_N / 2, GRID_N / 2);
}

export function buildSpacesPanel() {
  const body = document.getElementById("spacesBody");
  body.innerHTML = "";
  const here = curSpace();

  // the main map gets a row too, so "where am I / how do I get back" is answered in one place
  const main = document.createElement("div");
  main.className = "spacerow" + (here === null ? " here" : "");
  main.innerHTML = `<div class="spacerow-hdr"><span class="sw" style="background:${spaceColor(null)}"></span>
    <b class="sp-title">🗺 ${MAIN_NAME}</b><span class="cnt">${roomsInSpace(null).length} rooms</span></div>`;
  main.appendChild(enterBtn(null, here === null));
  body.appendChild(main);

  const rows = S.map.spaces.map(sp => ({ sp, doors: doorPairs(sp.id), n: roomsInSpace(sp.id).length }));
  const orphan = row => row.n > 0 && !row.doors.length;
  rows.sort((a, b) => (orphan(b) ? 1 : 0) - (orphan(a) ? 1 : 0));   // orphans first, otherwise keep creation order
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "hint"; none.style.margin = "8px 0";
    none.innerHTML = "No spaces yet. A space is a separate pocket map (a building's upper floors, a sewer…) that hangs off a door on the main map.";
    body.appendChild(none);
  }
  for (const { sp, doors, n } of rows) {
    const row = document.createElement("div");
    row.className = "spacerow" + (here === sp.id ? " here" : "") + (n && !doors.length ? " orphan" : "");
    const floors = n ? layersPresent(sp.id).length : 0;
    const head = document.createElement("div");
    head.className = "spacerow-hdr";
    head.innerHTML = `<span class="sw" style="background:${areaHex(sp)}"></span>
      <input type="text" class="sp-name" value="${escapeAttr(sp.name)}" title="Rename this space">
      <span class="cnt">${n} room${n !== 1 ? "s" : ""}${floors > 1 ? ` · ${floors} floors` : ""}</span>`;
    row.appendChild(head);
    head.querySelector(".sp-name").onchange = e => {
      sp.name = e.target.value.trim() || sp.name; commit(); buildSpacesPanel(); render();
    };

    const sw = document.createElement("div");
    sw.className = "swatches";
    PALETTE.forEach(p => {
      const s = document.createElement("div");
      s.className = "swatch" + (p.name === sp.color ? " sel" : "");
      s.style.background = p.c; s.title = p.name;
      s.onclick = () => { sp.color = p.name; commit(); buildSpacesPanel(); render(); };
      sw.appendChild(s);
    });
    row.appendChild(sw);

    const dl = document.createElement("div");
    dl.className = "sp-doors";
    if (!n) {
      dl.innerHTML = `<div class="hint">Empty: no rooms in here. Delete it, or enter it and add rooms.</div>`;
    } else if (!doors.length) {
      dl.innerHTML = `<div class="sp-orphan">⚠ Orphaned: no door connects this space to anything. Its rooms are safe; enter it and link one of them to give it a door again.</div>`;
    } else {
      dl.innerHTML = `<div class="sp-doorhdr">Door${doors.length !== 1 ? "s" : ""}</div>`;
      for (const d of doors) {
        const b = document.createElement("button");
        b.className = "sp-door"; b.title = "Go to this door's outside room";
        b.textContent = "🚪 " + doorLabel(d);
        b.onclick = () => { closePanel(); gotoRoom(d.outside.id); };
        dl.appendChild(b);
      }
    }
    row.appendChild(dl);

    const acts = document.createElement("div");
    acts.className = "sp-actions";
    acts.appendChild(enterBtn(sp.id, here === sp.id));
    if (n) {
      const rel = document.createElement("button");
      rel.textContent = "↩ Move all to main map…";
      rel.title = "Place this space's rooms back onto the main map (you pick the spot first; one undo step)";
      rel.onclick = () => { closePanel(); startRelease(roomsInSpace(sp.id).map(r => r.id)); };
      acts.appendChild(rel);
    }
    const del = document.createElement("button");
    del.className = "danger"; del.textContent = "Delete space";
    del.disabled = n > 0;
    del.title = n ? "Only an empty space can be deleted. Enter it and delete its rooms first (so the usual confirmations and undo apply)."
                  : "Delete this empty space";
    del.onclick = () => {
      if (!confirm(`Delete the empty space "${sp.name}"?`)) return;
      S.map.spaces = S.map.spaces.filter(x => x.id !== sp.id);
      S.map.areas = S.map.areas.filter(a => spaceOf(a) !== sp.id);
      if (curSpace() === sp.id) setSpace(null);
      commit(); buildSpacesPanel(); render();
    };
    acts.appendChild(del);
    row.appendChild(acts);
    body.appendChild(row);
  }
}
function enterBtn(id, isHere) {
  const b = document.createElement("button");
  b.className = "sp-enter" + (isHere ? " active" : "");
  b.textContent = isHere ? "● You are here" : (id ? "Enter →" : "Go to main map");
  b.disabled = isHere;
  b.onclick = () => {
    closePanel();
    if (id) enterSpace(id);
    else { setSpace(null); render(); fitInitial(); }
  };
  return b;
}
function closePanel() { document.getElementById("spacesPanel").style.display = "none"; }

export function createSpace(name) {
  const used = new Set(S.map.spaces.map(sp => sp.color));
  const color = (PALETTE.find(p => !used.has(p.name) && p.name !== "Slate") || PALETTE[7]).name;
  const sp = { id: uid(), name: name || "New space", color };
  S.map.spaces.push(sp);
  return sp;
}

document.getElementById("spacesBtn").onclick = () => {
  const panel = document.getElementById("spacesPanel");
  if (panel.style.display === "block") { closePanel(); return; }
  buildSpacesPanel();
  positionPopover(panel, document.getElementById("spacesBtn"));
};
document.getElementById("spacesNewBtn").onclick = () => {
  const name = prompt("Name for the new space (e.g. \"Highrise Apts – upper floors\"):", "New space");
  if (name === null) return;
  const sp = createSpace(name.trim());
  setSpace(sp.id, 0);
  commit(); closePanel(); render(); centerCellView(GRID_N / 2, GRID_N / 2);
  toast(`Created <b>${escapeHtml(sp.name)}</b>. Double-click to add rooms, then use 🔗 Link to connect one to a door on the main map.`);
};
