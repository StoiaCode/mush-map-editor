// ---------- Constants ----------
export const CELL = 90;
export const GRID_N = 100;                 // 100 x 100 cells per layer
export const WORLD = CELL * GRID_N;
export const LAYER_GAP = 140;              // vertical spacing between layers in the 3D view
export const SIZE_PX = { small: 46, medium: 62, large: 82 };
export const DIRS = ["N","NE","E","SE","S","SW","W","NW","UP","DOWN"];
export const COMPASS = ["N","NE","E","SE","S","SW","W","NW"];
export const VEC = {
  N:[0,-1], NE:[1,-1], E:[1,0], SE:[1,1],
  S:[0,1], SW:[-1,1], W:[-1,0], NW:[-1,-1]
};
export const OPP = { N:"S", S:"N", E:"W", W:"E", NE:"SW", SW:"NE", NW:"SE", SE:"NW", UP:"DOWN", DOWN:"UP" };
export const PALETTE = [
  { name:"Slate",  c:"#9aa6b8" },
  { name:"Red",    c:"#e25555" },
  { name:"Orange", c:"#e8943a" },
  { name:"Yellow", c:"#e8c93a" },
  { name:"Green",  c:"#5ec46e" },
  { name:"Teal",   c:"#3cc4b8" },
  { name:"Blue",   c:"#5b9dff" },
  { name:"Purple", c:"#a87ce8" },
  { name:"Pink",   c:"#e87cc4" }
];
export const STORE_KEY = "mushMapEditor.v2";
export const PREFS_KEY = "mushMapEditor.prefs.v1";
export const HIST_MAX = 60;
export const CLICK_THRESH = 4;
export const DIRWORD = { N:"north", NE:"northeast", E:"east", SE:"southeast", S:"south",
                          SW:"southwest", W:"west", NW:"northwest", UP:"up", DOWN:"down" };
export const KEYCARVE = { q:"NW", w:"N", e:"NE", a:"W", d:"E", z:"SW", x:"S", c:"SE", r:"UP", f:"DOWN" };
export function emptyTagLabels() { const o = {}; for (const p of PALETTE) o[p.name] = ""; return o; }
