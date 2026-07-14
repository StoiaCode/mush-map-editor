import { GRID_N, PALETTE } from "./constants.js";
import { S, viewport } from "./state.js";
import { clamp, escapeHtml, escapeAttr, areaHex } from "./utils.js";
import { savePrefs, undo, redo, commit, save } from "./persistence.js";
import { roomsOnLayer, createTransitLine, deleteTransitLine, moveStation, removeStop, addStubStation, entryId, entryName, isStub, isDual, unbindSecondRoom, createTrait, deleteTrait } from "./model.js";
import { render } from "./app.js";
import { stepLayer, zoomAt, centerOnRoom, centerCellView } from "./render-flat.js";
import { render3d } from "./render-3d.js";
import { buildLegend, buildStats, traitCounts } from "./stats-legend.js";
import { runSearch, jumpNextMatch, setPathHint } from "./search-path.js";

// ---------- Toolbar wiring ----------
export function updateViewButtons() {
  document.querySelectorAll("#viewseg button").forEach(b => b.classList.toggle("active", b.dataset.view === S.view));
}
document.querySelectorAll("#viewseg button").forEach(b => {
  b.onclick = () => { S.view = b.dataset.view; updateViewButtons(); render(); };
});
document.getElementById("layerUp").onclick = () => stepLayer(+1);
document.getElementById("layerDown").onclick = () => stepLayer(-1);
// Link and Path are mutually exclusive interaction modes.
export function setMode(mode) {
  S.linkMode = (mode === "link");
  S.pathMode = (mode === "path");
  S.areaMode = (mode === "area");
  S.transitMode = (mode === "transit");
  if (!S.linkMode) { S.pendingLink = null; const hint = document.getElementById("linkHint"); if (hint) hint.style.display = "none"; }
  if (!S.pathMode) S.pathStart = null;
  if (!S.areaMode && S.selectedAreaId) { S.selectedAreaId = null; }
  if (!S.areaMode) S.areaMergeSource = null;
  if (!S.transitMode) {
    S.transitActiveLine = null;
    if (S.transitBindPick) { S.transitBindPick = null; const h = document.getElementById("linkHint"); if (h) h.style.display = "none"; }
    const tp = document.getElementById("transitPanel"); if (tp) tp.style.display = "none";
  }
  document.getElementById("linkBtn").classList.toggle("active", S.linkMode);
  document.getElementById("pathBtn").classList.toggle("active", S.pathMode);
  document.getElementById("areaBtn").classList.toggle("active", S.areaMode);
  document.getElementById("transitBtn").classList.toggle("active", S.transitMode);
  viewport.classList.toggle("linkmode", S.linkMode || S.pathMode);
  viewport.classList.toggle("areamode", S.areaMode);
  viewport.classList.toggle("transitmode", S.transitMode);
  if (S.pathMode) setPathHint();
  render();
}
document.getElementById("linkBtn").onclick = () => setMode(S.linkMode ? "none" : "link");
document.getElementById("pathBtn").onclick = () => setMode(S.pathMode ? "none" : "path");
document.getElementById("areaBtn").onclick = () => setMode(S.areaMode ? "none" : "area");
document.getElementById("transitBtn").onclick = () => {
  if (S.transitMode) { setMode("none"); return; }
  setMode("transit");
  buildTransitPanel();
  positionPopover(document.getElementById("transitPanel"), document.getElementById("transitBtn"));
};
document.getElementById("searchBox").addEventListener("input", e => runSearch(e.target.value));
document.getElementById("searchBox").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); jumpNextMatch(); }
});
document.getElementById("undoBtn").onclick = undo;
document.getElementById("redoBtn").onclick = redo;

// ---------- Legend / onion / stats / export / import popovers ----------
export function positionPopover(panel, btn) {
  const r = btn.getBoundingClientRect();
  panel.style.display = "block";
  const w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + "px";
  panel.style.top = clamp(r.bottom + 6, 8, window.innerHeight - h - 8) + "px";
}
document.getElementById("legendBtn").onclick = () => {
  const panel = document.getElementById("legendPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildLegend();
  positionPopover(panel, document.getElementById("legendBtn"));
};
function syncOnionControls() {
  document.getElementById("onionBelow").checked = S.onion.below;
  document.getElementById("onionAbove").checked = S.onion.above;
  document.getElementById("onionOpacity").value = S.onion.opacity;
}
document.getElementById("onionBtn").onclick = () => {
  const panel = document.getElementById("onionPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  syncOnionControls();
  positionPopover(panel, document.getElementById("onionBtn"));
};
document.getElementById("onionBelow").onchange = e => { S.onion.below = e.target.checked; savePrefs(); render(); };
document.getElementById("onionAbove").onchange = e => { S.onion.above = e.target.checked; savePrefs(); render(); };
document.getElementById("onionOpacity").oninput = e => { S.onion.opacity = parseFloat(e.target.value); savePrefs(); render(); };
document.getElementById("statsBtn").onclick = () => {
  const panel = document.getElementById("statsPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildStats();
  positionPopover(panel, document.getElementById("statsBtn"));
};
document.querySelectorAll(".popclose").forEach(b => {
  b.onclick = () => { document.getElementById(b.dataset.close).style.display = "none"; };
});
// The transit panel is tied to transit mode (it's the only way to pick/create a line to
// edit), so its close button exits the mode too, overriding the generic handler above.
const transitCloseBtn = document.querySelector('#transitPanel .popclose');
if (transitCloseBtn) transitCloseBtn.onclick = () => setMode("none");

// Arm/disarm "click a room on the map to bind it as this stop's second room".
// Reuses the same status-chip element link mode uses for its pending-pick hint.
export function setBindPick(pick) {
  S.transitBindPick = pick;
  const hint = document.getElementById("linkHint");
  if (pick) {
    const name = entryName(S.map.transitLines.find(l => l.id === pick.lineId).stations.find(e => (typeof e === "string" ? e : e.id) === pick.stopId));
    hint.style.display = ""; hint.textContent = `Click the second room for "${name}" · Esc cancels`;
  } else if (hint) {
    hint.style.display = "none";
  }
  buildTransitPanel();
}

// ---------- Transit line panel ----------
export function buildTransitPanel() {
  const body = document.getElementById("transitBody");
  body.innerHTML = "";
  for (const line of S.map.transitLines) {
    const row = document.createElement("div");
    row.className = "transline" + (S.transitActiveLine === line.id ? " active" : "");
    const head = document.createElement("div");
    head.className = "transline-hdr";
    head.innerHTML = `<span class="sw" style="background:${areaHex(line)}"></span>
      <input type="text" class="tl-name" value="${escapeAttr(line.name)}">
      <span class="cnt">${line.stations.length} stop${line.stations.length !== 1 ? "s" : ""}</span>`;
    const editBtn = document.createElement("button");
    editBtn.className = "tl-active"; editBtn.textContent = (S.transitActiveLine === line.id) ? "● editing" : "Edit";
    const delBtn = document.createElement("button");
    delBtn.className = "danger tl-del"; delBtn.textContent = "✕";
    head.appendChild(editBtn); head.appendChild(delBtn);
    row.appendChild(head);

    const swatches = document.createElement("div");
    swatches.className = "swatches";
    PALETTE.forEach(p => {
      const s = document.createElement("div");
      s.className = "swatch" + (p.name === line.color ? " sel" : "");
      s.style.background = p.c;
      s.onclick = () => { line.color = p.name; commit(); buildTransitPanel(); render(); };
      swatches.appendChild(s);
    });
    row.appendChild(swatches);

    const stationsList = document.createElement("div");
    stationsList.className = "tl-stations";
    line.stations.forEach((entry, i) => {
      const id = entryId(entry), stub = isStub(entry), dual = isDual(entry);
      const srow = document.createElement("div");
      srow.className = "tl-station" + (stub ? " stub" : "") + (dual ? " dual" : "");
      srow.innerHTML = `<span class="tl-stopnum">${i + 1}</span>` +
        `<span class="tl-stopname">${stub ? "❓ " : ""}${escapeHtml(entryName(entry))}` +
        `${stub ? " <i>(unmapped)</i>" : ""}${dual ? ` <span class="tl-dirhint">→forward / ←backward</span>` : ""}</span>`;
      const up = document.createElement("button"); up.textContent = "▲"; up.disabled = i === 0;
      up.onclick = () => { moveStation(line.id, id, -1); commit(); buildTransitPanel(); render(); };
      const down = document.createElement("button"); down.textContent = "▼"; down.disabled = i === line.stations.length - 1;
      down.onclick = () => { moveStation(line.id, id, 1); commit(); buildTransitPanel(); render(); };
      srow.appendChild(up); srow.appendChild(down);
      if (!stub && !dual) {
        // single-room stop: offer binding a second room (e.g. the other-direction platform)
        const bind = document.createElement("button"); bind.textContent = "+2nd room";
        bind.title = "Bind a second room to this stop (e.g. a separate platform), used when riding the other direction";
        const armed = S.transitBindPick && S.transitBindPick.stopId === id;
        if (armed) bind.classList.add("active");
        bind.onclick = () => {
          if (S.transitBindPick && S.transitBindPick.stopId === id) { setBindPick(null); return; }
          setBindPick({ lineId: line.id, stopId: id });
        };
        srow.appendChild(bind);
      }
      if (dual) {
        const unbind = document.createElement("button"); unbind.textContent = "✕2nd"; unbind.title = "Remove the second room, keep only the forward one";
        unbind.onclick = () => { unbindSecondRoom(line.id, id); commit(); buildTransitPanel(); render(); };
        srow.appendChild(unbind);
      }
      const rm = document.createElement("button"); rm.textContent = "✕";
      rm.onclick = () => { removeStop(line.id, id); commit(); buildTransitPanel(); render(); };
      srow.appendChild(rm);
      stationsList.appendChild(srow);
    });
    if (!line.stations.length) stationsList.innerHTML = `<div class="hint">No stations yet — click "Edit" then click rooms on the map to add them.</div>`;
    row.appendChild(stationsList);

    const addStubBtn = document.createElement("button");
    addStubBtn.textContent = "+ Add unmapped stop"; addStubBtn.style.width = "100%"; addStubBtn.style.marginTop = "4px";
    addStubBtn.onclick = () => {
      const name = prompt("Name of the stop (you haven't mapped this room yet):");
      if (name === null) return;
      addStubStation(line.id, name); commit(); buildTransitPanel(); render();
    };
    row.appendChild(addStubBtn);
    body.appendChild(row);

    head.querySelector(".tl-name").onchange = e => { line.name = e.target.value.trim() || line.name; commit(); render(); };
    editBtn.onclick = () => {
      S.transitActiveLine = (S.transitActiveLine === line.id) ? null : line.id;
      buildTransitPanel();
    };
    delBtn.onclick = () => {
      if (confirm(`Delete line "${line.name}"?`)) { deleteTransitLine(line.id); commit(); buildTransitPanel(); render(); }
    };
  }
}
document.getElementById("transitNewBtn").onclick = () => {
  const line = createTransitLine("New Line", "Teal");
  S.transitActiveLine = line.id;
  commit(); buildTransitPanel(); render();
};

// ---------- Traits panel ----------
export function buildTraitsPanel() {
  const body = document.getElementById("traitsBody");
  const tc = traitCounts();
  body.innerHTML = "";
  if (!S.map.traits.length) { body.innerHTML = `<div class="hint">No traits yet — click "+ New trait" below.</div>`; return; }
  for (const t of S.map.traits) {
    const row = document.createElement("div");
    row.className = "traitrow";
    const emoji = document.createElement("input");
    emoji.type = "text"; emoji.className = "trait-emoji-input"; emoji.value = t.emoji; emoji.maxLength = 8;
    const label = document.createElement("input");
    label.type = "text"; label.value = t.label; label.placeholder = "Label";
    const cnt = document.createElement("span");
    cnt.className = "cnt"; cnt.textContent = tc[t.id] || 0; cnt.title = (tc[t.id] || 0) + " room(s) with this trait";
    const del = document.createElement("button");
    del.className = "danger"; del.textContent = "✕";
    row.appendChild(emoji); row.appendChild(label); row.appendChild(cnt); row.appendChild(del);
    body.appendChild(row);
    emoji.addEventListener("input", () => { t.emoji = emoji.value; save(); });
    emoji.addEventListener("change", () => { commit(); buildTraitsPanel(); render(); });
    label.addEventListener("input", () => { t.label = label.value; save(); });
    label.addEventListener("change", () => { commit(); buildTraitsPanel(); render(); });
    del.onclick = () => {
      if (confirm(`Delete trait "${t.emoji} ${t.label}"? It will be removed from every room that has it.`)) {
        deleteTrait(t.id); commit(); buildTraitsPanel(); render();
      }
    };
  }
}
document.getElementById("traitsBtn").onclick = () => {
  const panel = document.getElementById("traitsPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  buildTraitsPanel();
  positionPopover(panel, document.getElementById("traitsBtn"));
};
document.getElementById("traitsNewBtn").onclick = () => {
  createTrait("✨", "New Trait");
  commit(); buildTraitsPanel(); render();
};

// close popovers when clicking elsewhere
const POPS = { legendPanel: "legendBtn", onionPanel: "onionBtn", statsPanel: "statsBtn",
               exportPanel: "exportBtn", importPanel: "importBtn", traitsPanel: "traitsBtn" };
document.addEventListener("mousedown", e => {
  for (const id of Object.keys(POPS)) {
    const panel = document.getElementById(id);
    const btn = document.getElementById(POPS[id]);
    if (panel.style.display === "block" && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target))
      panel.style.display = "none";
  }
});
document.getElementById("zoomIn").onclick = () => {
  if (S.view === "3d") { S.cam3d.dist = clamp(S.cam3d.dist / 1.2, 200, 12000); render3d(); return; }
  const r = viewport.getBoundingClientRect(); zoomAt(r.left+r.width/2, r.top+r.height/2, 1.2);
};
document.getElementById("zoomOut").onclick = () => {
  if (S.view === "3d") { S.cam3d.dist = clamp(S.cam3d.dist * 1.2, 200, 12000); render3d(); return; }
  const r = viewport.getBoundingClientRect(); zoomAt(r.left+r.width/2, r.top+r.height/2, 1/1.2);
};
document.getElementById("zoomReset").onclick = () => {
  if (S.view === "3d") {
    // recenter & reframe the orbit camera to the default ¾ view
    S.cam3d.yaw = 0.7; S.cam3d.pitch = 0.5; S.cam3d.fitted = false;
    render3d();
    return;
  }
  S.scale = 1;
  const sel = S.selectedId && S.map.rooms[S.selectedId];
  if (sel && sel.z === S.map.currentLayer) centerOnRoom(sel);
  else { const rooms = roomsOnLayer(S.map.currentLayer); rooms.length ? centerOnRoom(rooms[0]) : centerCellView(GRID_N/2, GRID_N/2); }
};
