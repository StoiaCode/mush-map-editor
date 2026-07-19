import { PALETTE } from "./constants.js";

export function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export function colorOf(entity) { return (PALETTE.find(p => p.name === entity.color) || PALETTE[0]).c; }
export function hexA(hex, a) { const n = parseInt(hex.replace("#",""), 16); return `rgba(${(n>>16)&255}, ${(n>>8)&255}, ${n&255}, ${a})`; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
export function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
export function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}
