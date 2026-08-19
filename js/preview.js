import { S } from "./state.js";
import { escapeHtml } from "./utils.js";
import { clearSelection } from "./model.js";
import { normalize, resetHistory, save } from "./persistence.js";
import { render, fitInitial } from "./app.js";
import { mergeImport } from "./export-import.js";

// ---------- Shared map preview (file import, sync-code load, URL share) ----------
// Rather than inventing a separate storage/rendering path for "look before you touch",
// this borrows S.map itself as a disposable sandbox: every module reads S.map fresh on
// each access, so swapping it wholesale makes the *entire* app (canvas, inspector, 3D,
// layers) render the incoming map with zero new rendering code. save() is guarded by
// S.previewMode (persistence.js) so nothing sandboxed ever reaches localStorage; exiting
// restores the real map/history/viewport from S.previewBackup regardless of how the
// sandbox was interacted with while previewing.

function banner() { return document.getElementById("previewBanner"); }

function showBanner(data) {
  const m = data.meta || {};
  const roomCount = Object.keys(data.rooms).length;
  document.getElementById("previewSummary").innerHTML =
    (m.title ? `<b>${escapeHtml(m.title)}</b> ` : "") +
    (m.author ? `by ${escapeHtml(m.author)} ` : "") +
    `· ${roomCount} room${roomCount !== 1 ? "s" : ""}` + (m.date ? ` · ${escapeHtml(m.date)}` : "") +
    (data.partial ? ` · partial map` : "");
  banner().style.display = "flex";
}
function hideBanner() { banner().style.display = "none"; }

export function enterPreview(data) {
  if (!data || !data.rooms) throw new Error("Not a valid map (no rooms).");
  if (!S.previewMode) {
    S.previewBackup = {
      map: S.map, history: S.history, histIdx: S.histIdx,
      selectedId: S.selectedId, selection: S.selection, selectedAreaId: S.selectedAreaId,
      scale: S.scale, panX: S.panX, panY: S.panY, cam3d: { ...S.cam3d },
    };
  }
  S.pendingImport = data;
  S.map = JSON.parse(JSON.stringify(data));
  normalize();
  clearSelection();
  resetHistory();
  S.previewMode = true;
  render(); fitInitial();
  showBanner(data);
}

function restoreBackup() {
  const b = S.previewBackup;
  S.map = b.map; S.history = b.history; S.histIdx = b.histIdx;
  S.selectedId = b.selectedId; S.selection = b.selection; S.selectedAreaId = b.selectedAreaId;
  S.scale = b.scale; S.panX = b.panX; S.panY = b.panY; S.cam3d = b.cam3d;
  S.previewMode = false;
  S.pendingImport = null; S.previewBackup = null;
  hideBanner();
}

export function exitPreview(action) {
  const data = S.pendingImport;
  if (action === "replace" && !confirm("Replace the current map entirely?")) return;   // stay in preview
  restoreBackup();
  if (action === "replace") {
    S.map = data; normalize(); clearSelection(); resetHistory(); save();
  } else if (action === "merge") {
    mergeImport(data);
  }
  render();
}

document.getElementById("previewMerge").onclick = () => exitPreview("merge");
document.getElementById("previewReplace").onclick = () => exitPreview("replace");
document.getElementById("previewDiscard").onclick = () => exitPreview("discard");
