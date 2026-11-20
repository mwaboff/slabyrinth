/**
 * Map themes as plain data (architecture §5.3). Every colour and font used by drawDisplayList comes from here,
 * never from a literal in drawing code. Skin A = UX §11.2 "Surveyor's desk"; skin B = docs/ux-theme-ohsheet-v2.md.
 * Tokens: see REQUIRED_TOKENS. Material tokens are "mat-<material>"; wall style tokens "wall-<style>" fall back to
 * "wall"; anything missing falls back through `tokenColor`.
 */
import type { MapTheme } from "@slabyrinth/core/contracts/resolved";
import { MATERIALS } from "@slabyrinth/core/contracts/plan";

export const REQUIRED_TOKENS = [
  "paper",
  "rock",
  "hatch",
  "void",
  "floor",
  "grid",
  "ink",
  "wall",
  "wall-exterior",
  "door",
  "secret",
  "water-shallow",
  "water-deep",
  "path",
  "forest",
  "light",
  "accent",
  "select",
  "label",
  "label-halo",
  // additions used by the painters
  "badge-ink",
  "badge-stroke",
  "trap",
  "chasm",
  "stairwell",
  "height-up",
  "height-down",
  "ledge",
  "zone",
  "texture",
  "wood",
  "stone",
  "fire",
  ...MATERIALS.map((m) => `mat-${m}`),
] as const;

type Palette = Record<string, string>;

function materials(base: Record<string, string>): Palette {
  const out: Palette = {};
  for (const m of MATERIALS) out[`mat-${m}`] = base[m] ?? base["flagstone"] ?? "#808080";
  return out;
}

const DARK_MATS = {
  flagstone: "#2B261F",
  stone_tile: "#2F2A23",
  marble: "#3A3631",
  brick: "#37271F",
  cobble: "#302A23",
  wood_plank: "#3A2D1F",
  carpet: "#43262A",
  rock: "#27231E",
  dirt: "#33291D",
  grass: "#262C1D",
  sand: "#3E3524",
  gravel: "#302E29",
  mud: "#2C2318",
  snow: "#3F4144",
  ice: "#2C3C42",
  swamp: "#252C20",
  water_shallow: "#22363A",
  water_deep: "#1A2C33",
  lava: "#6A2814",
  bridge_wood: "#45331F",
  asphalt: "#1E1E1E",
  concrete: "#35332F",
};

const LIGHT_MATS = {
  flagstone: "#FCF8EF",
  stone_tile: "#F6F1E6",
  marble: "#FFFEFB",
  brick: "#F2DED0",
  cobble: "#ECE5D8",
  wood_plank: "#F1E1C6",
  carpet: "#EFD3CF",
  rock: "#E7DFD0",
  dirt: "#EAD9BD",
  grass: "#E1EACB",
  sand: "#F4E8C4",
  gravel: "#E6E2DA",
  mud: "#DCCDB2",
  snow: "#FFFFFF",
  ice: "#DFEEF2",
  swamp: "#D9E1C8",
  water_shallow: "#D5E6E9",
  water_deep: "#BCD6DC",
  lava: "#EBA27A",
  bridge_wood: "#E5CBA0",
  asphalt: "#C9C6C0",
  concrete: "#EFEDE8",
};

/** Skin A dark — "night survey" (kept as an alternative; skin B v2 is the chosen look). */
export const parchmentDark: MapTheme = {
  id: "parchment-dark",
  fontFamily: 'Fraunces, Georgia, "DejaVu Serif", serif',
  lineScale: 1,
  colors: {
    paper: "#181511",
    rock: "#181511",
    hatch: "#3A332A",
    void: "#050403",
    floor: "#2B261F",
    grid: "#3A332B",
    ink: "#E6DCCB",
    wall: "#E6DCCB",
    "wall-exterior": "#E6DCCB",
    "wall-cave_rock": "#A99F8E",
    "wall-hedge": "#86A86A",
    "wall-wood": "#C9A77A",
    "wall-palisade": "#C9A77A",
    "wall-fence": "#C9A77A",
    "wall-railing": "#C9A77A",
    "wall-low_wall": "#B8AE9C",
    "wall-ruined": "#B8AE9C",
    door: "#2B261F",
    secret: "#E6DCCB",
    "water-shallow": "#5DA3B4",
    "water-deep": "#5DA3B4",
    path: "#3A3125",
    forest: "#86A86A",
    light: "#E5B54E",
    fire: "#E5B54E",
    accent: "#E2765C",
    select: "#E2765C",
    label: "#1C1915",
    "label-halo": "#2B261F",
    "badge-ink": "#EDE6D9",
    "badge-stroke": "#E6DCCB",
    trap: "#E2765C",
    chasm: "#050403",
    stairwell: "#0E0C0A",
    "height-up": "#F3E9D6",
    "height-down": "#000000",
    ledge: "#E6DCCB",
    zone: "#86A86A",
    texture: "#E6DCCB",
    wood: "#C9A77A",
    stone: "#A99F8E",
    ...materials(DARK_MATS),
  },
};

/** Skin A light — paper. */
export const parchmentLight: MapTheme = {
  id: "parchment-light",
  fontFamily: 'Fraunces, Georgia, "DejaVu Serif", serif',
  lineScale: 1,
  colors: {
    paper: "#E8DFCE",
    rock: "#E8DFCE",
    hatch: "#BCAE94",
    void: "#14110D",
    floor: "#FCF8EF",
    grid: "#E3D8C5",
    ink: "#2A231B",
    wall: "#2A231B",
    "wall-exterior": "#2A231B",
    "wall-cave_rock": "#5A5045",
    "wall-hedge": "#4D6B37",
    "wall-wood": "#7A5532",
    "wall-palisade": "#7A5532",
    "wall-fence": "#7A5532",
    "wall-railing": "#7A5532",
    "wall-low_wall": "#6E6457",
    "wall-ruined": "#5A5045",
    door: "#FCF8EF",
    secret: "#2A231B",
    "water-shallow": "#3F7F8F",
    "water-deep": "#3F7F8F",
    path: "#E2D3B8",
    forest: "#4D6B37",
    light: "#C08A1E",
    fire: "#C08A1E",
    accent: "#B4412C",
    select: "#B4412C",
    label: "#FBF8F2",
    "label-halo": "#FCF8EF",
    "badge-ink": "#1E1A15",
    "badge-stroke": "#2A231B",
    trap: "#B4412C",
    chasm: "#14110D",
    stairwell: "#3A332A",
    "height-up": "#FFFFFF",
    "height-down": "#5A4A30",
    ledge: "#2A231B",
    zone: "#4D6B37",
    texture: "#2A231B",
    wood: "#7A5532",
    stone: "#6E6457",
    ...materials(LIGHT_MATS),
  },
};

const B_DARK_MATS = {
  ...DARK_MATS,
  flagstone: "#241C16",
  stone_tile: "#271F18",
  rock: "#211A14",
  grass: "#22261A",
  dirt: "#2E2418",
};
const B_LIGHT_MATS = { ...LIGHT_MATS, flagstone: "#FBF6EC", rock: "#EDE2CC" };

/** Skin B v2 dark — Oh Sheet "warm tavern" (docs/ux-theme-ohsheet-v2.md map theme). THE DEFAULT map theme. */
export const ohSheetDark: MapTheme = {
  id: "ohsheet-dark",
  fontFamily: '"Source Sans 3", "Segoe UI", Ubuntu, system-ui, sans-serif',
  lineScale: 1,
  colors: {
    paper: "#120E0B",
    rock: "#120E0B",
    hatch: "#2E2316",
    void: "#050302",
    floor: "#241C16",
    grid: "#30261C",
    ink: "#EAD9BF",
    wall: "#EAD9BF",
    "wall-exterior": "#EAD9BF",
    "wall-cave_rock": "#A8977E",
    "wall-hedge": "#8DB87A",
    "wall-wood": "#C79C68",
    "wall-palisade": "#C79C68",
    "wall-fence": "#C79C68",
    "wall-railing": "#C79C68",
    "wall-low_wall": "#B5A58C",
    "wall-ruined": "#B5A58C",
    door: "#241C16",
    secret: "#EAD9BF",
    "water-shallow": "#6AA6B3",
    "water-deep": "#6AA6B3",
    path: "#33281C",
    forest: "#8DB87A",
    light: "#E8893A",
    fire: "#E8893A",
    accent: "#D4A056",
    select: "#D4A056",
    label: "#1A1412",
    "label-halo": "#241C16",
    "badge-ink": "#D4A056",
    "badge-stroke": "#D4A056",
    trap: "#F07A5E",
    chasm: "#050302",
    stairwell: "#0B0806",
    "height-up": "#F5E6D3",
    "height-down": "#000000",
    ledge: "#EAD9BF",
    zone: "#D4A056",
    texture: "#EAD9BF",
    wood: "#C79C68",
    stone: "#A8977E",
    ...materials(B_DARK_MATS),
  },
};

/** Skin B v2 light. */
export const ohSheetLight: MapTheme = {
  id: "ohsheet-light",
  fontFamily: '"Source Sans 3", "Segoe UI", Ubuntu, system-ui, sans-serif',
  lineScale: 1,
  colors: {
    paper: "#E4D5BB",
    rock: "#E4D5BB",
    hatch: "#C2AB86",
    void: "#1A1412",
    floor: "#FBF6EC",
    grid: "#EADFCB",
    ink: "#2D241F",
    wall: "#2D241F",
    "wall-exterior": "#2D241F",
    "wall-cave_rock": "#5E4F40",
    "wall-hedge": "#4F7A3A",
    "wall-wood": "#7A5230",
    "wall-palisade": "#7A5230",
    "wall-fence": "#7A5230",
    "wall-railing": "#7A5230",
    "wall-low_wall": "#6D5E4C",
    "wall-ruined": "#5E4F40",
    door: "#FBF6EC",
    secret: "#2D241F",
    "water-shallow": "#2F6F80",
    "water-deep": "#2F6F80",
    path: "#E6D6B8",
    forest: "#4F7A3A",
    light: "#B4561C",
    fire: "#B4561C",
    accent: "#86592F",
    select: "#86592F",
    label: "#FFFDF9",
    "label-halo": "#FBF6EC",
    "badge-ink": "#86592F",
    "badge-stroke": "#86592F",
    trap: "#B03A22",
    chasm: "#1A1412",
    stairwell: "#4A3C2E",
    "height-up": "#FFFFFF",
    "height-down": "#5A4530",
    ledge: "#2D241F",
    zone: "#86592F",
    texture: "#2D241F",
    wood: "#7A5230",
    stone: "#6D5E4C",
    ...materials(B_LIGHT_MATS),
  },
};

/** Print (light, high contrast) — the PNG export default (UX §6.10, decisions #9); skin B v2 light family. */
export const printTheme: MapTheme = {
  id: "print",
  fontFamily: ohSheetLight.fontFamily,
  lineScale: 1.15,
  colors: {
    ...ohSheetLight.colors,
    paper: "#E6DCCB",
    rock: "#E6DCCB",
    hatch: "#A8916C",
    floor: "#FFFFFF",
    grid: "#DDD3C2",
    ink: "#1E1813",
    wall: "#1E1813",
    "wall-exterior": "#1E1813",
    door: "#FFFFFF",
    secret: "#1E1813",
    label: "#FFFFFF",
    "label-halo": "#FFFFFF",
    ledge: "#1E1813",
    texture: "#1E1813",
    "mat-flagstone": "#FFFFFF",
  },
};

/** The default map theme (skin B v2 dark, decided 2026-11-18). */
export const DEFAULT_MAP_THEME_ID = "ohsheet-dark";

export const MAP_THEMES: Record<string, MapTheme> = {
  [ohSheetDark.id]: ohSheetDark,
  [ohSheetLight.id]: ohSheetLight,
  [printTheme.id]: printTheme,
  [parchmentDark.id]: parchmentDark,
  [parchmentLight.id]: parchmentLight,
};

export function getMapTheme(id: string): MapTheme {
  return MAP_THEMES[id] ?? ohSheetDark;
}

/** Colour of a token with sensible fallbacks: "wall-x" → "wall", "mat-x" → "floor", anything → "ink". */
export function tokenColor(theme: MapTheme, token: string): string {
  const c = theme.colors;
  const direct = c[token];
  if (direct !== undefined) return direct;
  if (token.startsWith("wall")) return c["wall"] ?? c["ink"] ?? "#000";
  if (token.startsWith("mat-")) return c["floor"] ?? "#fff";
  return c["ink"] ?? "#000";
}
