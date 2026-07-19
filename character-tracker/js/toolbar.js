import { NODE_SIZE, GROUP_FIELDS } from "./constants.js";
import { S, viewport, galleryEl, groupsEl } from "./state.js";
import { clamp } from "./utils.js";
import { undo, redo, commit } from "./persistence.js";
import { createCharacter, selectCharacter, computeSearchMatches } from "./model.js";
import { render } from "./app.js";
import { zoomAt, screenToWorld, centerOnPoint } from "./render-web.js";
import { openFullProfile, closeFullProfile } from "./inspector.js";
import { setPendingLink } from "./interactions.js";

// ---------- View toggle ----------
export function updateViewButtons() {
  document.querySelectorAll("#viewseg button").forEach(b => b.classList.toggle("active", b.dataset.view === S.view));
  viewport.style.display = S.view === "web" ? "" : "none";
  galleryEl.style.display = S.view === "gallery" ? "" : "none";
  groupsEl.style.display = S.view === "groups" ? "" : "none";
  document.getElementById("groupFieldWrap").style.display = S.view === "groups" ? "" : "none";
}
document.querySelectorAll("#viewseg button").forEach(b => {
  b.onclick = () => { S.view = b.dataset.view; updateViewButtons(); render(); };
});

// ---------- Group-by field (Groups view) ----------
const groupFieldSel = document.getElementById("groupField");
groupFieldSel.innerHTML = GROUP_FIELDS.map(f => `<option value="${f.key}">${f.label}</option>`).join("");
groupFieldSel.onchange = e => { S.groupField = e.target.value; render(); };

// ---------- Modes: link (draw relationship) / circle (freeform group) ----------
export function setMode(mode) {
  S.linkMode = (mode === "link");
  S.circleMode = (mode === "circle");
  if (!S.linkMode) setPendingLink(null);
  if (!S.circleMode) S.circleDraft = null;
  document.getElementById("linkBtn").classList.toggle("active", S.linkMode);
  document.getElementById("circleBtn").classList.toggle("active", S.circleMode);
  viewport.classList.toggle("linkmode", S.linkMode);
  viewport.classList.toggle("circlemode", S.circleMode);
  render();
}
document.getElementById("linkBtn").onclick = () => setMode(S.linkMode ? "none" : "link");
document.getElementById("circleBtn").onclick = () => setMode(S.circleMode ? "none" : "circle");

// ---------- New character ----------
document.getElementById("newCharBtn").onclick = () => {
  const rect = viewport.getBoundingClientRect();
  const w = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const ch = createCharacter(w.x - NODE_SIZE / 2, w.y - NODE_SIZE / 2, "New Character");
  selectCharacter(ch.id);
  S.view = "web"; updateViewButtons();
  closeFullProfile();
  commit(); render();
  centerOnPoint(ch.x + NODE_SIZE / 2, ch.y + NODE_SIZE / 2);
};

// ---------- Search ----------
document.getElementById("searchBox").addEventListener("input", e => {
  S.searchTerm = e.target.value; computeSearchMatches();
  document.getElementById("searchInfo").textContent = S.searchTerm
    ? `${S.searchMatches.length} match${S.searchMatches.length !== 1 ? "es" : ""}` : "";
  render();
});
document.getElementById("undoBtn").onclick = undo;
document.getElementById("redoBtn").onclick = redo;

// ---------- Gallery / Groups card selection ----------
galleryEl.addEventListener("click", e => {
  const card = e.target.closest(".char-card");
  if (!card) return;
  selectCharacter(card.dataset.id);
  openFullProfile();
});
groupsEl.addEventListener("click", e => {
  const card = e.target.closest(".mini-card");
  if (!card) return;
  selectCharacter(card.dataset.id);
  render();
});

// ---------- Popovers ----------
export function positionPopover(panel, btn) {
  const r = btn.getBoundingClientRect();
  panel.style.display = "block";
  const w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + "px";
  panel.style.top = clamp(r.bottom + 6, 8, window.innerHeight - h - 8) + "px";
}
document.querySelectorAll(".popclose").forEach(b => {
  b.onclick = () => { document.getElementById(b.dataset.close).style.display = "none"; };
});
const POPS = { importPanel: "importBtn" };
document.addEventListener("mousedown", e => {
  for (const id of Object.keys(POPS)) {
    const panel = document.getElementById(id);
    const btn = document.getElementById(POPS[id]);
    if (panel.style.display === "block" && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target))
      panel.style.display = "none";
  }
});

// ---------- Zoom (Web view only) ----------
document.getElementById("zoomIn").onclick = () => {
  const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
};
document.getElementById("zoomOut").onclick = () => {
  const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
};
document.getElementById("zoomReset").onclick = () => {
  S.scale = 1;
  const sel = S.selectedId && S.map.characters[S.selectedId];
  if (sel) centerOnPoint(sel.x + NODE_SIZE / 2, sel.y + NODE_SIZE / 2);
  else centerOnPoint(0, 0);
};
