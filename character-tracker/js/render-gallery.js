import { S, galleryEl } from "./state.js";
import { colorOf, escapeHtml, initials } from "./utils.js";
import { primaryImage, catalogName } from "./model.js";

export function renderGallery() {
  const chars = Object.values(S.map.characters);
  const term = S.searchTerm.trim();
  const shown = term ? chars.filter(ch => S.searchMatches.includes(ch.id)) : chars;
  shown.sort((a, b) => a.name.localeCompare(b.name));

  if (!shown.length) {
    galleryEl.innerHTML = `<div class="empty-note">${term
      ? "No characters match your search."
      : "No characters yet. Switch to the Web view and double-click empty space to add one."}</div>`;
    return;
  }

  galleryEl.innerHTML = "";
  for (const ch of shown) {
    const card = document.createElement("div");
    card.className = "char-card" + (ch.id === S.selectedId ? " selected" : "");
    card.dataset.id = ch.id;
    const img = primaryImage(ch);
    const badges = [catalogName("clan", ch.clanId), catalogName("sect", ch.sectId), catalogName("coterie", ch.coterieId)].filter(Boolean);
    card.innerHTML = `
      <div class="cc-img" style="${img ? `background-image:url('${img.replace(/'/g, "%27")}')` : `background-color:${colorOf(ch)}`}">
        ${img ? "" : `<span class="cc-init">${escapeHtml(initials(ch.name))}</span>`}
      </div>
      <div class="cc-body">
        <div class="cc-name">${escapeHtml(ch.name)}</div>
        ${badges.length ? `<div class="cc-badges">${badges.map(b => `<span class="cc-badge">${escapeHtml(b)}</span>`).join("")}</div>` : ""}
        ${ch.tags.length ? `<div class="cc-tags">${ch.tags.slice(0, 4).map(t => `<span class="cc-tag">${escapeHtml(t)}</span>`).join("")}${ch.tags.length > 4 ? `<span class="cc-tag">+${ch.tags.length - 4}</span>` : ""}</div>` : ""}
      </div>`;
    galleryEl.appendChild(card);
  }
}
