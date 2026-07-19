import { PALETTE, CLAN_SUGGESTIONS, SECT_SUGGESTIONS } from "./constants.js";
import { S, inspector, fullProfile } from "./state.js";
import { escapeHtml, escapeAttr, colorOf } from "./utils.js";
import {
  deleteCharacter, addTag, removeTag, addImageUrl, removeImageUrl, moveImageUrl, primaryImage,
  relationshipsFor, otherEnd, createRelationship, updateRelationshipLabel, deleteRelationship,
  deleteAnnotation, charactersInAnnotation, clearSelection, selectCharacter,
} from "./model.js";
import { commit, save } from "./persistence.js";
import { render } from "./app.js";
import { centerOnCharacter } from "./render-web.js";

// ---------- Sidebar: quick card ----------
export function renderInspector() {
  const ann = S.selectedAnnotationId && S.map.annotations.find(a => a.id === S.selectedAnnotationId);
  if (ann) { renderAnnotationCard(ann); closeFullProfile(); return; }

  if (!S.selectedId || !S.map.characters[S.selectedId]) {
    inspector.innerHTML = `<h3>Inspector</h3>
      <div class="empty-note">
        <p>No character selected.</p>
        <p><b>Double-click empty space</b> to add a character.<br>
        <b>Click a node</b> to select & edit it.<br>
        <b>Drag a node</b> to reposition it anywhere.</p>
        <p class="hint"><b>🔗 Link mode</b>: click one character, then another, to draw a labeled relationship between them. Click a relationship line to relabel or remove it.</p>
        <p class="hint"><b>◯ Circle mode</b>: drag across empty space to draw a freeform group — good for coteries, hangout spots, factions, anything you want to visually cluster.</p>
        <p class="hint"><b>Ctrl+Z / Ctrl+Y</b> undo / redo · <b>Del</b> delete selection · <b>Esc</b> deselect.</p>
      </div>`;
    closeFullProfile();
    return;
  }

  const ch = S.map.characters[S.selectedId];
  const img = primaryImage(ch);
  let h = `<h3>Character</h3>
    <div class="insec">
      <div class="qc-portrait" style="${img ? `background-image:url('${escapeAttr(img)}')` : `background-color:${colorOf(ch)}`}"></div>
      <div class="field"><label>Name</label><input type="text" id="q_name" value="${escapeAttr(ch.name)}"></div>
      <div class="field"><label>Colour tag</label><div class="swatches" id="q_color"></div></div>
      <div class="field"><label>Clan / Sect / Coterie</label>
        <input type="text" id="q_clan" placeholder="Clan" value="${escapeAttr(ch.clan)}" style="margin-bottom:4px;">
        <input type="text" id="q_sect" placeholder="Sect" value="${escapeAttr(ch.sect)}" style="margin-bottom:4px;">
        <input type="text" id="q_coterie" placeholder="Coterie" value="${escapeAttr(ch.coterie)}">
      </div>
      <div class="field"><label>Tags</label><div class="trait-chips" id="q_tags"></div>
        <input type="text" id="q_tagadd" placeholder="Add a tag, press Enter…" style="margin-top:5px;"></div>
    </div>
    <div class="insec">
      <span class="seclabel">Relationships (${relationshipsFor(ch.id).length})</span>
      <div id="q_rels"></div>
    </div>
    <div class="insec">
      <button class="primary" id="q_openFull" style="width:100%;">✎ Open full profile</button>
    </div>
    <div class="insec"><button class="danger" id="q_del" style="width:100%">Delete character</button></div>`;
  inspector.innerHTML = h;

  bindSwatches(document.getElementById("q_color"), ch, () => { commit(); render(); });
  bindTags(document.getElementById("q_tags"), document.getElementById("q_tagadd"), ch);

  const relsWrap = document.getElementById("q_rels");
  const rels = relationshipsFor(ch.id);
  if (!rels.length) relsWrap.innerHTML = `<div class="hint">None yet — use 🔗 Link mode on the Web view, or add one from the full profile.</div>`;
  else for (const rel of rels) {
    const other = S.map.characters[otherEnd(rel, ch.id)];
    const row = document.createElement("div");
    row.className = "exitrow";
    row.innerHTML = `<span class="tgt" data-goto="${other.id}">${escapeHtml(other.name)}</span><span class="hint">${escapeHtml(rel.label || "—")}</span>`;
    relsWrap.appendChild(row);
  }
  relsWrap.querySelectorAll("[data-goto]").forEach(el => el.onclick = () => gotoCharacter(el.dataset.goto));

  document.getElementById("q_name").oninput = e => { ch.name = e.target.value; save(); refreshNodeLabel(ch); };
  document.getElementById("q_name").onchange = () => commit();
  for (const [id, field] of [["q_clan","clan"],["q_sect","sect"],["q_coterie","coterie"]]) {
    document.getElementById(id).oninput = e => { ch[field] = e.target.value; save(); };
    document.getElementById(id).onchange = () => commit();
  }
  document.getElementById("q_openFull").onclick = () => openFullProfile();
  document.getElementById("q_del").onclick = () => {
    if (confirm(`Delete "${ch.name}"? Their relationships will be removed too.`)) { deleteCharacter(ch.id); clearSelection(); commit(); render(); }
  };
}

function renderAnnotationCard(ann) {
  const n = charactersInAnnotation(ann).length;
  inspector.innerHTML = `<h3>Group</h3>
    <div class="insec">
      <div class="field"><label>Name</label><input type="text" id="a_name" value="${escapeAttr(ann.name)}"></div>
      <div class="field"><label>Colour</label><div class="swatches" id="a_color"></div></div>
      <div class="hint">${n} character${n !== 1 ? "s" : ""} currently inside this circle</div>
    </div>
    <div class="insec"><button class="danger" id="a_del" style="width:100%">Delete group circle</button></div>
    <div class="empty-note hint">Drag the circle to move it; drag its bottom-right handle to resize. Membership is just "inside the circle" — nothing is stored on the characters themselves.</div>`;
  bindSwatches(document.getElementById("a_color"), ann, () => { commit(); render(); });
  document.getElementById("a_name").oninput = e => {
    ann.name = e.target.value; save();
    const lab = document.querySelector(`.ann-label[data-aid="${ann.id}"]`);
    if (lab) lab.textContent = ann.name;
  };
  document.getElementById("a_name").onchange = () => commit();
  document.getElementById("a_del").onclick = () => {
    if (confirm(`Delete the "${ann.name}" group circle? Characters inside it are not affected.`)) { deleteAnnotation(ann.id); commit(); render(); }
  };
}

function bindSwatches(wrap, entity, onPick) {
  PALETTE.forEach(p => {
    const s = document.createElement("div");
    s.className = "swatch" + (p.name === entity.color ? " sel" : "");
    s.style.background = p.c; s.title = p.name;
    s.onclick = () => { entity.color = p.name; onPick(); };
    wrap.appendChild(s);
  });
}
function bindTags(chipWrap, addInput, ch) {
  function draw() {
    chipWrap.innerHTML = "";
    for (const t of ch.tags) {
      const chip = document.createElement("span");
      chip.className = "trait-chip sel";
      chip.innerHTML = `${escapeHtml(t)} <span data-rm="${escapeAttr(t)}" style="cursor:pointer;opacity:.7;">✕</span>`;
      chip.querySelector("[data-rm]").onclick = () => { removeTag(ch, t); commit(); render(); };
      chipWrap.appendChild(chip);
    }
    if (!ch.tags.length) chipWrap.innerHTML = `<span class="hint">No tags yet.</span>`;
  }
  draw();
  addInput.onkeydown = e => {
    if (e.key !== "Enter") return;
    addTag(ch, addInput.value); addInput.value = ""; commit(); render();
  };
}
export function refreshNodeLabel(ch) {
  const el = document.querySelector(`.node[data-id="${ch.id}"] .nname`);
  if (el) el.textContent = ch.name;
}
export function gotoCharacter(id) {
  const ch = S.map.characters[id];
  if (!ch) return;
  selectCharacter(id);
  S.view = "web";
  render();
  centerOnCharacter(ch);
}

// ---------- Full profile: big scrollable panel with every field ----------
export function openFullProfile() { S.fullProfileOpen = true; render(); }
export function closeFullProfile() { S.fullProfileOpen = false; if (fullProfile) fullProfile.style.display = "none"; }

export function renderFullProfile() {
  if (!S.fullProfileOpen || !S.selectedId || !S.map.characters[S.selectedId]) { fullProfile.style.display = "none"; return; }
  const ch = S.map.characters[S.selectedId];
  fullProfile.style.display = "flex";

  fullProfile.innerHTML = `
    <div class="pop-hdr">Full profile — ${escapeHtml(ch.name)} <button class="popclose" id="fp_close">✕</button></div>
    <div class="fp-body">
      <div class="fp-sec">
        <span class="seclabel">Identity</span>
        <div class="field"><label>Name</label><input type="text" id="fp_name" value="${escapeAttr(ch.name)}"></div>
        <div class="field"><label>Description</label><textarea id="fp_desc" style="min-height:90px;">${escapeHtml(ch.description)}</textarea></div>
        <div class="field"><label>Colour tag</label><div class="swatches" id="fp_color"></div></div>
      </div>
      <div class="fp-sec">
        <span class="seclabel">Affiliations</span>
        <div class="field"><label>Clan</label><input type="text" id="fp_clan" list="clanList" value="${escapeAttr(ch.clan)}"></div>
        <div class="field"><label>Sect</label><input type="text" id="fp_sect" list="sectList" value="${escapeAttr(ch.sect)}"></div>
        <div class="field"><label>Coterie</label><input type="text" id="fp_coterie" value="${escapeAttr(ch.coterie)}"></div>
      </div>
      <div class="fp-sec">
        <span class="seclabel">Your relationship</span>
        <div class="field"><label>My relationship to them</label><input type="text" id="fp_myrel" value="${escapeAttr(ch.myRelationship)}" placeholder="e.g. mentor, rival, sire…"></div>
        <div class="field"><label>Notable features</label><textarea id="fp_features" style="min-height:60px;">${escapeHtml(ch.notableFeatures)}</textarea></div>
      </div>
      <div class="fp-sec">
        <span class="seclabel">Tags</span>
        <div class="trait-chips" id="fp_tags"></div>
        <input type="text" id="fp_tagadd" placeholder="Add a tag, press Enter…" style="margin-top:6px;width:100%;">
      </div>
      <div class="fp-sec">
        <span class="seclabel">Images <span class="hint">(first is the primary shown on cards &amp; the web view — outfits, portraits, etc.)</span></span>
        <div id="fp_images"></div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <input type="text" id="fp_imgadd" placeholder="https://…/image.webp" style="flex:1;">
          <button id="fp_imgaddbtn">+ Add</button>
        </div>
      </div>
      <div class="fp-sec">
        <span class="seclabel">Relationships to other characters</span>
        <div id="fp_rels"></div>
        <button id="fp_reladd" style="width:100%;margin-top:6px;">+ Add relationship</button>
        <div id="fp_reladdrow" style="display:none;margin-top:6px;"></div>
      </div>
      <div class="fp-sec"><button class="danger" id="fp_del" style="width:100%">Delete character</button></div>
    </div>
    <datalist id="clanList">${CLAN_SUGGESTIONS.map(c => `<option value="${escapeAttr(c)}">`).join("")}</datalist>
    <datalist id="sectList">${SECT_SUGGESTIONS.map(c => `<option value="${escapeAttr(c)}">`).join("")}</datalist>`;

  document.getElementById("fp_close").onclick = () => { closeFullProfile(); render(); };
  bindSwatches(document.getElementById("fp_color"), ch, () => { commit(); render(); });

  document.getElementById("fp_name").oninput = e => { ch.name = e.target.value; save(); refreshNodeLabel(ch); };
  document.getElementById("fp_name").onchange = () => commit();
  document.getElementById("fp_desc").oninput = e => { ch.description = e.target.value; save(); };
  document.getElementById("fp_desc").onchange = () => commit();
  for (const [id, field] of [["fp_clan","clan"],["fp_sect","sect"],["fp_coterie","coterie"],["fp_myrel","myRelationship"]]) {
    document.getElementById(id).oninput = e => { ch[field] = e.target.value; save(); };
    document.getElementById(id).onchange = () => commit();
  }
  document.getElementById("fp_features").oninput = e => { ch.notableFeatures = e.target.value; save(); };
  document.getElementById("fp_features").onchange = () => commit();

  bindTags(document.getElementById("fp_tags"), document.getElementById("fp_tagadd"), ch);

  const imgWrap = document.getElementById("fp_images");
  if (!ch.imageUrls.length) imgWrap.innerHTML = `<div class="hint">No images yet.</div>`;
  ch.imageUrls.forEach((url, i) => {
    const row = document.createElement("div");
    row.className = "fp-imgrow";
    row.innerHTML = `
      <img src="${escapeAttr(url)}" onerror="this.style.display='none'">
      <div class="fp-imginfo">
        <input type="text" value="${escapeAttr(url)}" data-idx="${i}" class="fp-imgurl">
        ${i === 0 ? `<span class="hint">Primary</span>` : ""}
      </div>
      <div class="fp-imgbtns">
        <button data-up="${i}" title="Move up">↑</button>
        <button data-down="${i}" title="Move down">↓</button>
        <button data-rm="${i}" title="Remove" class="danger">✕</button>
      </div>`;
    imgWrap.appendChild(row);
  });
  imgWrap.querySelectorAll(".fp-imgurl").forEach(inp => {
    inp.onchange = e => { ch.imageUrls[+e.target.dataset.idx] = e.target.value.trim(); commit(); render(); };
  });
  imgWrap.querySelectorAll("[data-up]").forEach(b => b.onclick = () => { moveImageUrl(ch, +b.dataset.up, -1); commit(); render(); });
  imgWrap.querySelectorAll("[data-down]").forEach(b => b.onclick = () => { moveImageUrl(ch, +b.dataset.down, 1); commit(); render(); });
  imgWrap.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { removeImageUrl(ch, +b.dataset.rm); commit(); render(); });
  document.getElementById("fp_imgaddbtn").onclick = () => {
    const inp = document.getElementById("fp_imgadd");
    if (inp.value.trim()) { addImageUrl(ch, inp.value); inp.value = ""; commit(); render(); }
  };
  document.getElementById("fp_imgadd").onkeydown = e => { if (e.key === "Enter") document.getElementById("fp_imgaddbtn").click(); };

  const relsWrap = document.getElementById("fp_rels");
  const rels = relationshipsFor(ch.id);
  if (!rels.length) relsWrap.innerHTML = `<div class="hint">No relationships yet.</div>`;
  else for (const rel of rels) {
    const other = S.map.characters[otherEnd(rel, ch.id)];
    if (!other) continue;
    const row = document.createElement("div");
    row.className = "exitrow";
    row.innerHTML = `
      <span class="tgt" data-goto="${other.id}">${escapeHtml(other.name)}</span>
      <input type="text" value="${escapeAttr(rel.label)}" data-rel="${rel.id}" placeholder="label…" style="width:110px;">
      <button data-delrel="${rel.id}">✕</button>`;
    relsWrap.appendChild(row);
  }
  relsWrap.querySelectorAll("[data-goto]").forEach(el => el.onclick = () => { closeFullProfile(); gotoCharacter(el.dataset.goto); });
  relsWrap.querySelectorAll("[data-rel]").forEach(inp => inp.onchange = e => { updateRelationshipLabel(e.target.dataset.rel, e.target.value); commit(); });
  relsWrap.querySelectorAll("[data-delrel]").forEach(b => b.onclick = () => { deleteRelationship(b.dataset.delrel); commit(); render(); });

  document.getElementById("fp_reladd").onclick = () => {
    const row = document.getElementById("fp_reladdrow");
    const others = Object.values(S.map.characters).filter(o => o.id !== ch.id);
    if (!others.length) { row.innerHTML = `<div class="hint">No other characters to relate to yet.</div>`; row.style.display = "block"; return; }
    row.style.display = "flex"; row.style.gap = "6px";
    row.innerHTML = `
      <select id="fp_relwho" style="flex:1;">${others.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("")}</select>
      <input type="text" id="fp_rellabel" placeholder="label…" style="width:100px;">
      <button id="fp_reladdok" class="primary">Add</button>`;
    document.getElementById("fp_reladdok").onclick = () => {
      const who = document.getElementById("fp_relwho").value;
      const label = document.getElementById("fp_rellabel").value.trim();
      createRelationship(ch.id, who, label);
      row.style.display = "none";
      commit(); render();
    };
  };

  document.getElementById("fp_del").onclick = () => {
    if (confirm(`Delete "${ch.name}"? Their relationships will be removed too.`)) {
      deleteCharacter(ch.id); clearSelection(); closeFullProfile(); commit(); render();
    }
  };
}
