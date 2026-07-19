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
// Suggestions only (free-text fields, not a hard enum — different chronicles use different lists)
export const CLAN_SUGGESTIONS = ["Brujah","Gangrel","Malkavian","Nosferatu","Toreador","Tremere","Ventrue","Banu Haqim","Hecata","Lasombra","Ministry","Ravnos","Salubri","Tzimisce","Caitiff","Thin-blood"];
export const SECT_SUGGESTIONS = ["Camarilla","Anarch","Sabbat","Independent"];
