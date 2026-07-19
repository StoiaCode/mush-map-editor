import { S, groupsEl } from "./state.js";
import { colorOf, escapeHtml, initials } from "./utils.js";
import { groupCharacters, primaryImage } from "./model.js";

export function renderGroups() {
  const term = S.searchTerm.trim();
  let groups = groupCharacters(S.groupField);
  if (term) groups = groups.map(([k, list]) => [k, list.filter(ch => S.searchMatches.includes(ch.id))]).filter(([, list]) => list.length);

  if (!groups.length) {
    groupsEl.innerHTML = `<div class="empty-note">${term ? "No characters match your search." : "No characters yet."}</div>`;
    return;
  }

  groupsEl.innerHTML = "";
  for (const [key, list] of groups) {
    const section = document.createElement("div");
    section.className = "group-section";
    section.innerHTML = `<div class="group-hdr">${escapeHtml(key)} <span class="cnt">${list.length}</span></div>`;
    const grid = document.createElement("div");
    grid.className = "group-grid";
    for (const ch of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const img = primaryImage(ch);
      const mini = document.createElement("div");
      mini.className = "mini-card" + (ch.id === S.selectedId ? " selected" : "");
      mini.dataset.id = ch.id;
      mini.title = ch.name;
      mini.style.cssText = img ? `background-image:url('${img.replace(/'/g, "%27")}')` : `background-color:${colorOf(ch)}`;
      mini.innerHTML = `${img ? "" : `<span class="mc-init">${escapeHtml(initials(ch.name))}</span>`}<span class="mc-name">${escapeHtml(ch.name)}</span>`;
      grid.appendChild(mini);
    }
    section.appendChild(grid);
    groupsEl.appendChild(section);
  }
}
