/**
 * Light levels (generator 5, switch `lightRegimes`): how many light accents a scene and each room in it carry, on one
 * scale, dark (0), dim (1), moderate (2), bright (3), flooded (4). The scene's brightness itself is the GM's board
 * setting (day, night); the level says how many visible fixtures mark the places people use: flooded is many regular
 * fixtures, the strongest pieces, every used spot marked (a modern clinic); dim is a few pools on the pieces in use with
 * dark between (an intimate taproom); dark is one or none.
 *
 * The plan has no field for it yet, so the scene's level is read from the words it already carries (the title, summary
 * and kind, the level's name, the theme) through one small table, and a room's words nudge its own level a step. A
 * future plan field (`lightLevel` on the plan or a level, and on an area) feeds the same `SceneLight` and nudge.
 */
import type { LightLevel } from "./roomTraits";

export const LIGHT_LEVEL_NAMES = ["dark", "dim", "moderate", "bright", "flooded"] as const;
export type LightLevelName = (typeof LIGHT_LEVEL_NAMES)[number];

/** What the room furnisher and the passage lights read of the scene. */
export interface SceneLight {
  readonly level: LightLevel;
  /** Coloured light belongs here (a dungeon, a cave): a red flame or a crystal may be a room's focal light. */
  readonly colour: boolean;
}

/** Words that name a light level, by level (whole words, lower case). */
const LEVEL_WORDS: Readonly<Record<LightLevelName, readonly string[]>> = {
  dark: ["dark", "lightless", "unlit", "pitch", "blackened", "abandoned", "derelict", "forgotten", "lost"],
  dim: [
    "dim",
    "dimly",
    "intimate",
    "cosy",
    "cozy",
    "quiet",
    "candlelit",
    "smoky",
    "shadowy",
    "shadowed",
    "gloomy",
    "murky",
    "seedy",
    "haunted",
    "secret",
    "hidden",
    "night",
    "midnight",
    "dungeon",
    "crypt",
    "catacomb",
    "catacombs",
    "cellar",
    "lair",
  ],
  moderate: [],
  // (mood and setting words only: a room's kind already sets its own level, so "office" or "school" is no scene word)
  bright: [
    "bright",
    "lit",
    "well-lit",
    "lively",
    "festive",
    "festival",
    "feast",
    "celebration",
    "grand",
    "gleaming",
  ],
  flooded: ["flooded", "brilliant", "blazing", "floodlit", "hospital", "clinic", "neon", "modern"],
};

/** A theme's level when the words name none: dungeons and caves dim, towns moderate, the modern city bright. */
const THEME_LEVEL: Readonly<Record<string, LightLevel>> = {
  stone_dungeon: 1,
  cave: 1,
  city: 3,
};
/** Themes whose rooms may take coloured light. */
const COLOUR_THEMES: ReadonlySet<string> = new Set(["stone_dungeon", "cave"]);

const WORD_LEVEL: ReadonlyMap<string, LightLevel> = new Map(
  LIGHT_LEVEL_NAMES.flatMap((name, i) => LEVEL_WORDS[name].map((w) => [w, i as LightLevel] as const)),
);

/**
 * Words above that name a setting rather than a mood (generator 5, the character resolver): they set a scene's, a
 * district's or a building's level, never a room's, whose kind already says it (a room named "Cellar" is a cellar).
 */
const SETTING_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "hidden",
  "night",
  "midnight",
  "dungeon",
  "crypt",
  "catacomb",
  "catacombs",
  "cellar",
  "lair",
  "hospital",
  "clinic",
  "neon",
  "modern",
]);

/**
 * The level words name (the middle one when they name several), undefined when they name none. `settings: false`
 * reads mood words only (a room). The character resolver's light words (resolve/character.ts).
 */
export function lightNamedBy(
  texts: ReadonlyArray<string | undefined>,
  opts: { readonly settings: boolean },
): LightLevel | undefined {
  const named = wordsOf(texts)
    .filter((w) => opts.settings || !SETTING_WORDS.has(w))
    .map((w) => WORD_LEVEL.get(w))
    .filter((l): l is LightLevel => l !== undefined)
    .sort((a, b) => a - b);
  return named[Math.floor((named.length - 1) / 2)];
}

/** A theme's level when nothing names one (dungeons and caves dim, towns moderate, the modern city bright). */
export const themeLight = (theme: string): LightLevel => THEME_LEVEL[theme] ?? 2;
/** Whether a theme's places may take coloured light (a dungeon, a cave). */
export const colourTheme = (theme: string): boolean => COLOUR_THEMES.has(theme);

const wordsOf = (texts: ReadonlyArray<string | undefined>): string[] =>
  texts.flatMap((t) => (t ?? "").toLowerCase().split(/[^a-z-]+/)).filter((w) => w.length > 0);

/** The levels the words name, in order. */
function levelsIn(texts: ReadonlyArray<string | undefined>): LightLevel[] {
  return wordsOf(texts)
    .map((w) => WORD_LEVEL.get(w))
    .filter((l): l is LightLevel => l !== undefined);
}

const clampLevel = (n: number): LightLevel => Math.max(0, Math.min(4, Math.round(n))) as LightLevel;

/**
 * The scene's light: the level its words name (the middle one when they name several), else its theme's, else
 * moderate. `stated` (a future plan field) wins over the words.
 */
export function sceneLight(p: {
  readonly theme: string;
  readonly texts: ReadonlyArray<string | undefined>;
  readonly stated?: LightLevel;
}): SceneLight {
  const named = levelsIn(p.texts).sort((a, b) => a - b);
  const middle: LightLevel | undefined = named[Math.floor((named.length - 1) / 2)];
  const level = p.stated ?? middle ?? THEME_LEVEL[p.theme] ?? 2;
  return { level, colour: COLOUR_THEMES.has(p.theme) };
}

/**
 * A room's own words move its level one step toward the level they name ("Cosy snug" one step dimmer than its kind in
 * the scene, "Bright gallery" one step brighter); 0 when they name none. `stated` (a future area field): the step that
 * reaches it from `base`, unbounded.
 */
export function roomNudge(
  texts: ReadonlyArray<string | undefined>,
  base: LightLevel,
  stated?: LightLevel,
): number {
  if (stated !== undefined) return stated - base;
  const named = levelsIn(texts);
  if (named.length === 0) return 0;
  const mean = named.reduce((a: number, b) => a + b, 0) / named.length;
  return Math.sign(clampLevel(mean) - base);
}
