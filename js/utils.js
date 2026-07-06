import { PALETTE } from "./constants.js";

export function uid() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
export function colorOf(room) { return (PALETTE.find(p => p.name === room.color) || PALETTE[0]).c; }
export function areaHex(ar) { return (PALETTE.find(p => p.name === ar.color) || PALETTE[5]).c; }
export function hexA(hex, a) { const n = parseInt(hex.replace("#",""), 16); return `rgba(${(n>>16)&255}, ${(n>>8)&255}, ${n&255}, ${a})`; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
export function escapeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
