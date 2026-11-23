/**
 * Light levels (generator 5, switch `lightRegimes`): how many light accents a scene and each room in it carry, on one
 * scale, dark (0), dim (1), moderate (2), bright (3), flooded (4). The scene's brightness itself is the GM's board
 * setting (day, night); the level says how many visible fixtures mark the places people use: flooded is many regular
 * fixtures, the strongest pieces, every used spot marked (a modern clinic); dim is a few pools on the pieces in use with
 * dark between (an intimate taproom); dark is one or none.
 *
 * The plan has no field for it yet, so the level is read from the words a place already carries through one small
 * table (`lightNamedBy`); the character resolver (resolve/character.ts) is the one reader, and every consumer asks the
 * character it resolved. A future plan field (`lightLevel` on the plan or a level, and on an area) is stated there.
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
  moderate: ["moderate", "moderately"],
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
