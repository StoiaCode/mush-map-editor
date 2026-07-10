import { S } from "./state.js";
import { escapeHtml } from "./utils.js";
import { positionPopover } from "./toolbar.js";
import { stageImport } from "./export-import.js";

// Relative by default (reverse-proxied alongside the frontend in production). Can be
// overridden (e.g. localStorage.setItem("mushSyncApiBase", "http://host:port/api")) for
// local testing against a standalone API instance.
const API_BASE = localStorage.getItem("mushSyncApiBase") || "/api";

// Not real auth - this ships readable in the JS bundle. It's a filter against generic
// spam bots that probe for open POST endpoints without knowing to send this header.
// The placeholder below is substituted at container start (docker-entrypoint.sh) from
// the CLIENT_KEY env var, which must match the API server's CLIENT_KEY (see compose.yaml).
const CLIENT_KEY = "__CLIENT_KEY__";

function setStatus(msg, kind) {
  const el = document.getElementById("syncStatus");
  el.textContent = msg;
  el.className = "hint" + (kind ? " " + kind : "");
}
function validCode(code) { return /^[A-Za-z0-9]{6}$/.test(code); }

async function apiCall(method, code, body) {
  const url = code ? `${API_BASE}/maps/${encodeURIComponent(code)}` : `${API_BASE}/maps`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "X-Client-Key": CLIENT_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("Could not reach the sync server.");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status}).`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

document.getElementById("syncBtn").onclick = () => {
  const panel = document.getElementById("syncPanel");
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  document.getElementById("syncUploadResult").innerHTML = "";
  setStatus("");
  positionPopover(panel, document.getElementById("syncBtn"));
};

document.getElementById("syncUploadBtn").onclick = async () => {
  const codeInput = document.getElementById("syncUploadCode");
  const code = codeInput.value.trim();
  if (code && !validCode(code)) { setStatus("Code must be 6 letters/digits.", "err"); return; }
  setStatus("Uploading…");
  document.getElementById("syncUploadResult").innerHTML = "";
  try {
    const result = await apiCall(code ? "PUT" : "POST", code || null, S.map);
    const id = result.id;
    setStatus("Uploaded.", "ok");
    document.getElementById("syncUploadResult").innerHTML =
      `<div class="synccode"><span class="code">${escapeHtml(id)}</span><button id="syncCopyBtn">📋 Copy</button></div>`;
    document.getElementById("syncCopyBtn").onclick = () => navigator.clipboard.writeText(id);
    codeInput.value = id;
  } catch (e) { setStatus(e.message, "err"); }
};

document.getElementById("syncLoadBtn").onclick = async () => {
  const code = document.getElementById("syncLoadCode").value.trim();
  if (!validCode(code)) { setStatus("Enter a 6-character code.", "err"); return; }
  setStatus("Loading…");
  try {
    const data = await apiCall("GET", code);
    stageImport(data, document.getElementById("syncBtn"));
    document.getElementById("syncPanel").style.display = "none";
    setStatus("");
  } catch (e) { setStatus(e.message, "err"); }
};

document.getElementById("syncDeleteBtn").onclick = async () => {
  const code = document.getElementById("syncDeleteCode").value.trim();
  if (!validCode(code)) { setStatus("Enter a 6-character code.", "err"); return; }
  if (!confirm(`Delete map ${code} from the server? This cannot be undone.`)) return;
  setStatus("Deleting…");
  try {
    await apiCall("DELETE", code);
    setStatus("Deleted.", "ok");
  } catch (e) { setStatus(e.message, "err"); }
};
