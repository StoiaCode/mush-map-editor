import { S, viewport } from "./state.js";
import { load, resetHistory } from "./persistence.js";
import { renderWeb, applyTransform, centerOnPoint, centerOnCharacter } from "./render-web.js";
import { renderGallery } from "./render-gallery.js";
import { renderGroups } from "./render-groups.js";
import { renderInspector, renderFullProfile } from "./inspector.js";
import { updateViewButtons } from "./toolbar.js";

// Side-effect-only imports: these modules wire up their own event listeners and
// nothing else imports named bindings from them, so without this line they'd
// never load and the app would have no pointer/keyboard/export/import behaviour.
import "./interactions.js";
import "./export-import.js";

// ---------- Render dispatcher ----------
// Central so every other module can trigger a redraw via one import, instead of
// each needing to know about renderWeb/renderGallery/renderGroups/renderInspector
// individually.
export function render() {
  if (S.view === "web") renderWeb();
  else if (S.view === "gallery") renderGallery();
  else if (S.view === "groups") renderGroups();
  renderInspector();
  renderFullProfile();
}

// ---------- Init ----------
export function fitInitial() {
  const chars = Object.values(S.map.characters);
  chars.length ? centerOnCharacter(chars[0]) : centerOnPoint(0, 0);
}
window.addEventListener("resize", () => { if (S.view === "web") applyTransform(); });

load();
resetHistory();
updateViewButtons();
applyTransform();
render();
fitInitial();
