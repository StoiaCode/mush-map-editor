// ---------- Constants ----------
export const NODE_SIZE = 64;                // px diameter of a character node on the web canvas
export const WORLD_SIZE = 12000;            // fluid canvas is a big free-form square, no cells
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
export const STORE_KEY = "characterTracker.v1";
export const PREFS_KEY = "characterTracker.prefs.v1";
export const HIST_MAX = 60;
export const CLICK_THRESH = 4;
export const GROUP_FIELDS = [
  { key:"coterie", label:"Coterie" },
  { key:"clan",    label:"Clan" },
  { key:"sect",    label:"Sect" }
];
// Catalog kinds: each is a user-built list of {id, name} entries (S.map.clans/
// sects/coteries), referenced from characters by id (clanId/sectId/coterieId)
// instead of free text — see model.js's catalog* helpers.
export const CATALOG_KINDS = [
  { kind:"clan",    catalog:"clans",    label:"Clan" },
  { kind:"sect",    catalog:"sects",    label:"Sect" },
  { kind:"coterie", catalog:"coteries", label:"Coterie" },
];
