import { PALETTE, DIRS } from "./constants.js";
import { S, world, inspector } from "./state.js";
import { escapeHtml, escapeAttr, areaHex } from "./utils.js";
import {
  areaCells, deleteArea, splitArea,
  carve, changeRoomLayer, setExitFly, deleteRoom, clearSelection, selectSingle, stationLinesFor
} from "./model.js";
import { commit, save } from "./persistence.js";
import { render } from "./app.js";
import { centerOnRoom } from "./render-flat.js";
import { updateViewButtons } from "./toolbar.js";

// ---------- Inspector ----------
export function renderInspector() {
  // Area selected → area editor takes precedence
  const ar = S.selectedAreaId && S.map.areas.find(a => a.id === S.selectedAreaId);
  if (ar) {
    const nCells = areaCells(ar).size;
    inspector.innerHTML = `<h3>Area</h3>
      <div class="insec">
        <div class="field"><label>Name</label><input type="text" id="a_name" value="${escapeAttr(ar.name)}"></div>
        <div class="field"><label>Colour</label><div class="swatches" id="a_color"></div></div>
        <div class="hint">${ar.rects.length} rect${ar.rects.length !== 1 ? "s" : ""} · ${nCells} cells · spans all layers</div>
      </div>
      <div class="insec">
        <button id="a_merge" style="width:100%;margin-bottom:6px;${S.areaMergeSource === ar.id ? "outline:2px solid var(--good);" : ""}">🔗 Merge with another area…</button>
        ${ar.rects.length > 1 ? `<button id="a_split" style="width:100%;">✂ Split into rectangles</button>` : ""}
      </div>
      <div class="insec"><button class="danger" id="a_del" style="width:100%">Delete area</button></div>
      <div class="empty-note hint">${S.areaMergeSource === ar.id
        ? `<b style="color:var(--good)">Click another area to merge it in</b> (Esc cancels).`
        : `Drag the area to move it${ar.rects.length === 1 ? "; drag the bottom-right handle to resize" : ""}. Merge adjacent areas to make L-shapes.`}</div>`;
    const sw = document.getElementById("a_color");
    PALETTE.forEach(p => {
      const s = document.createElement("div");
      s.className = "swatch" + (p.name === ar.color ? " sel" : "");
      s.style.background = p.c; s.title = (S.map.tagLabels[p.name] || p.name);
      s.onclick = () => { ar.color = p.name; commit(); render(); };
      sw.appendChild(s);
    });
    document.getElementById("a_name").oninput = e => {
      ar.name = e.target.value; save();
      const lab = world.querySelector(`.area-label[data-aid="${ar.id}"]`);
      if (lab) lab.textContent = ar.name;   // live-update without rebuilding the inspector
    };
    document.getElementById("a_name").onchange = () => commit();
    document.getElementById("a_merge").onclick = () => {
      S.areaMergeSource = (S.areaMergeSource === ar.id) ? null : ar.id;   // toggle the pick
      render();
    };
    const splitBtn = document.getElementById("a_split");
    if (splitBtn) splitBtn.onclick = () => { splitArea(ar.id); commit(); render(); };
    document.getElementById("a_del").onclick = () => { if (confirm(`Delete area "${ar.name}"?`)) { deleteArea(ar.id); commit(); render(); } };
    return;
  }
  if (!S.selectedId || !S.map.rooms[S.selectedId]) {
    inspector.innerHTML = `<h3>Inspector</h3>
      <div class="empty-note">
        <p>No room selected.</p>
        <p><b>Double-click an empty cell</b> to create a room.<br>
        <b>Click a room</b> to select & edit it.<br>
        <b>Drag a room</b> to move it on this layer.<br>
        <b>Drag empty space</b> to pan (<b>middle-drag</b> pans in any mode).<br>
        <b>Shift-drag</b> room→room to link two rooms on this layer.<br>
        <b>🔗 Link mode</b>: click a room, switch layers if needed, then click the target — links across layers / gaps.</p>
        <p class="hint"><b>Ctrl+click</b> rooms or <b>Shift-drag</b> empty space to multi-select (add <b>Alt</b> to box-select across <i>all</i> layers), then move / recolor / delete them together.</p>
        <p class="hint">With a room selected — carve with the <b>Q W E / A S D / Z X C</b> rose: edges are compass (<b>X</b> = south), centre <b>S</b> = up a layer, <b>Shift+S</b> = down · <b>Del</b> delete · <b>Esc</b> deselect.</p>
        <p class="hint"><b>Ctrl+Z / Ctrl+Y</b> undo / redo · the <b>👁 Onion</b> menu controls which neighbour layers ghost through.</p>
        <p class="hint" style="margin-top:14px;opacity:.7;">© 2026 Stoia · MIT Licensed · <a href="https://github.com/StoiaCode/mush-map-editor" target="_blank" rel="noopener" style="color:var(--accent)">GitHub</a></p>
      </div>`;
    return;
  }
  // Multiple rooms selected → bulk-edit panel
  if (S.selection.size > 1) {
    inspector.innerHTML =
      `<h3>${S.selection.size} rooms selected</h3>` +
      `<div class="insec"><label class="seclabel">Set colour tag (all)</label><div class="swatches" id="bulk_color"></div></div>` +
      `<div class="insec"><div class="field"><label>Set size (all)</label>
        <select id="bulk_size">
          <option value="">— keep —</option>
          <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
        </select></div></div>` +
      `<div class="insec">
        <button id="bulk_clear" style="width:100%;margin-bottom:6px;">Clear selection</button>
        <button class="danger" id="bulk_del" style="width:100%">Delete ${S.selection.size} rooms</button>
      </div>` +
      `<div class="empty-note hint">Drag any selected room to move them together. Ctrl+click adds/removes; Shift-drag box-selects (hold Alt to span all layers).</div>`;
    const bsw = document.getElementById("bulk_color");
    PALETTE.forEach(p => {
      const s = document.createElement("div");
      s.className = "swatch"; s.style.background = p.c;
      s.title = (S.map.tagLabels[p.name] || p.name);
      s.onclick = () => { for (const id of S.selection) S.map.rooms[id].color = p.name; commit(); render(); };
      bsw.appendChild(s);
    });
    document.getElementById("bulk_size").onchange = e => {
      if (!e.target.value) return;
      for (const id of S.selection) S.map.rooms[id].size = e.target.value;
      commit(); render();
    };
    document.getElementById("bulk_clear").onclick = () => { clearSelection(); render(); };
    document.getElementById("bulk_del").onclick = () => {
      if (confirm(`Delete ${S.selection.size} selected rooms?`)) { for (const id of [...S.selection]) deleteRoom(id); clearSelection(); commit(); render(); }
    };
    return;
  }

  const r = S.map.rooms[S.selectedId];
  let h = `<h3>Room — Layer ${r.z}</h3>`;
  h += `<div class="insec insec-info">
    <div class="field"><label>Name</label><input type="text" id="f_name" value="${escapeAttr(r.name)}"></div>
    <div class="field field-grow"><label>Description / notes</label><textarea id="f_desc">${escapeHtml(r.description)}</textarea></div>
    <div class="field"><label>Color tag</label><div class="swatches" id="f_color"></div></div>
    <div class="field"><label>Size (visual only)</label>
      <select id="f_size">
        <option value="small"${r.size==="small"?" selected":""}>Small</option>
        <option value="medium"${r.size==="medium"?" selected":""}>Medium</option>
        <option value="large"${r.size==="large"?" selected":""}>Large</option>
      </select></div>
    <div class="field"><label>Layer</label>
      <div style="display:flex;gap:4px;align-items:center;">
        <button id="f_layer_dn" class="iconbtn" title="Move down a layer">−</button>
        <input type="text" inputmode="numeric" id="f_layer" value="${r.z}" style="width:60px;text-align:center;">
        <button id="f_layer_up" class="iconbtn" title="Move up a layer">+</button>
      </div></div>
    <div class="field"><label>Image URL</label><input type="text" id="f_img" value="${escapeAttr(r.imageUrl || "")}" placeholder="https://…/room.webp"></div>
    <div id="f_img_wrap"></div>
    <div class="hint">grid (${r.x}, ${r.y})</div>
  </div>`;

  h += `<div class="insec">
    <span class="seclabel">Carve (creates + links a neighbour)</span>
    <div class="rose" id="rose">
      <button data-carve="NW">NW</button><button data-carve="N">N</button><button data-carve="NE">NE</button>
      <button data-carve="W">W</button>
        <div class="center">
          <button data-carve="UP" title="Carve a room one layer up (same cell)">↑ up</button>
          <button data-carve="DOWN" title="Carve a room one layer down (same cell)">↓ dn</button>
        </div>
      <button data-carve="E">E</button>
      <button data-carve="SW">SW</button><button data-carve="S">S</button><button data-carve="SE">SE</button>
    </div>
  </div>`;

  h += `<div class="insec"><span class="seclabel">Exits</span>`;
  const exitDirs = DIRS.filter(d => r.exits[d]);
  if (!exitDirs.length) h += `<div class="hint">No exits yet.</div>`;
  for (const d of exitDirs) {
    const t = S.map.rooms[r.exits[d]];
    const tname = t ? t.name + (t.z !== r.z ? ` (L${t.z})` : "") : "??";
    const fly = r.exitFly && r.exitFly[d];
    h += `<div class="exitrow"><span class="dir">${d}</span>
      <span class="tgt" data-goto="${r.exits[d]}">${escapeHtml(tname)}</span>
      <button class="flytoggle${fly ? " on" : ""}" data-fly="${d}" title="Flight-only exit (requires flying)">✈</button>
      <button data-delexit="${d}">✕</button></div>`;
  }
  h += `</div>`;
  const lines = stationLinesFor(r.id);
  if (lines.length) {
    h += `<div class="insec"><span class="seclabel">Stations</span>`;
    for (const line of lines) {
      const stop = line.stations.indexOf(r.id) + 1;
      h += `<div class="hint">🚆 <span style="color:${areaHex(line)}">${escapeHtml(line.name)}</span> — stop ${stop} of ${line.stations.length}</div>`;
    }
    h += `<div class="hint" style="margin-top:4px;">Edit via the 🚆 Transit panel.</div></div>`;
  }
  h += `<div class="insec"><button class="danger" id="delRoom" style="width:100%">Delete room</button></div>`;
  inspector.innerHTML = h;

  const sw = document.getElementById("f_color");
  PALETTE.forEach(p => {
    const s = document.createElement("div");
    s.className = "swatch" + (p.name === r.color ? " sel" : "");
    s.style.background = p.c; s.title = (S.map.tagLabels[p.name] || p.name);
    s.onclick = () => { r.color = p.name; commit(); render(); };
    sw.appendChild(s);
  });
  // text fields: live autosave on input, single undo step committed on blur/change
  document.getElementById("f_name").oninput = e => { r.name = e.target.value; save(); refreshRoomLabel(r); };
  document.getElementById("f_name").onchange = () => commit();
  document.getElementById("f_desc").oninput = e => { r.description = e.target.value; save(); };
  document.getElementById("f_desc").onchange = () => commit();
  document.getElementById("f_size").onchange = e => { r.size = e.target.value; commit(); render(); };
  document.getElementById("f_layer").onchange = e => changeRoomLayer(r, parseInt(e.target.value, 10));
  document.getElementById("f_layer_up").onclick = () => changeRoomLayer(r, r.z + 1);
  document.getElementById("f_layer_dn").onclick = () => changeRoomLayer(r, r.z - 1);
  function renderImgPreview(url) {
    const wrap = document.getElementById("f_img_wrap");
    wrap.innerHTML = "";
    if (!url) return;
    const img = document.createElement("img");
    img.src = url;
    img.onerror = () => { wrap.innerHTML = `<div class="imgerr">Couldn't load image from that URL.</div>`; };
    wrap.appendChild(img);
  }
  renderImgPreview(r.imageUrl);
  document.getElementById("f_img").oninput = e => {
    r.imageUrl = e.target.value.trim(); save();
    renderImgPreview(r.imageUrl);
    const el = world.querySelector(`.room[data-id="${r.id}"]`);
    if (el) {
      if (r.imageUrl) {
        el.style.backgroundImage = `url("${r.imageUrl.replace(/"/g, '%22')}")`;
        el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center";
        el.classList.add("has-image");
      } else {
        el.style.backgroundImage = ""; el.classList.remove("has-image");
      }
    }
  };
  document.getElementById("f_img").onchange = () => commit();
  document.querySelectorAll("[data-carve]").forEach(b => b.onclick = () => carve(r.id, b.dataset.carve));
  document.querySelectorAll("[data-delexit]").forEach(b => b.onclick = () => { delete r.exits[b.dataset.delexit]; delete r.exitFly[b.dataset.delexit]; commit(); render(); });
  document.querySelectorAll("[data-fly]").forEach(b => b.onclick = () => { const d = b.dataset.fly; setExitFly(r.id, d, !(r.exitFly && r.exitFly[d])); commit(); render(); });
  document.querySelectorAll("[data-goto]").forEach(el => el.onclick = () => gotoRoom(el.dataset.goto));
  document.getElementById("delRoom").onclick = () => {
    if (confirm(`Delete "${r.name}"? Exits referencing it will be removed. The cell is left empty.`)) { deleteRoom(r.id); commit(); render(); }
  };
}
export function refreshRoomLabel(r) {
  const el = world.querySelector(`.room[data-id="${r.id}"] .rname`);
  if (el) el.textContent = r.name;
}
export function gotoRoom(id) {
  const r = S.map.rooms[id];
  if (!r) return;
  selectSingle(id);
  if (S.view !== "flat") { S.view = "flat"; updateViewButtons(); }
  S.map.currentLayer = r.z;
  render();
  centerOnRoom(r);
}
