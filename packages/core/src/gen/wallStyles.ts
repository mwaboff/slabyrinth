/**
 * What each wall style IS, as data: one table of traits that every stage reads instead of keeping its own literal set
 * of style names (generator 4 code review, finding 5). A new style gets one row here, and every rule that asks "is it
 * rock", "can you see over it" or "may it be weathered" answers for it.
 *
 * The table says nothing about themes. Whether a room is kept up or abandoned is decided per theme and per room
 * (`ResolvedArea.finish`: the theme's interior character, rough when gen/roomPurpose.ts finds the room abandoned); this
 * table only says whether the STYLE can carry the weathering at all.
 */
import type { WallStyle } from "../contracts/plan";
import { WALL_STYLES } from "../contracts/plan";

/** What a wall style is made of; a consumer that needs a material (a skirt, a cap, a floor to match) reads this. */
export type WallFamily =
  | "theme" // "wall": whatever the theme's default wall is made of; the palette decides
  | "stone"
  | "brick"
  | "timber"
  | "plaster"
  | "concrete"
  | "metal"
  | "rock" // natural rock, built from whole-cell blocks
  | "plant";

export interface WallStyleInfo {
  family: WallFamily;
  /**
   * Natural rock: TaleSpire has no thin piece for it, so it is built from whole-cell blocks and the cells behind it
   * are solid mass (cave walls, rock cliffs). The cave work (outlines, relief, mass, review) runs on these styles.
   */
  natural: boolean;
  /** Low enough to see over (a kerb, parapet or rail): an opening it rims stays visible; any other style hides it. */
  low: boolean;
  /**
   * May stand uneven: old masonry or the theme's own wall can be shortened in runs, broken at the top and have rubble at
   * its foot. Dressed or kept-up styles (marble, plaster, timber, concrete ...) stay clean. The theme still decides
   * whether a given room is kept up (`ResolvedArea.finish`).
   */
  uneven: boolean;
}

const row = (family: WallFamily, flags: Partial<Omit<WallStyleInfo, "family">> = {}): WallStyleInfo => ({
  family,
  natural: false,
  low: false,
  uneven: false,
  ...flags,
});

export const WALL_STYLE_INFO: Record<WallStyle, WallStyleInfo> = {
  wall: row("theme", { uneven: true }),
  stone: row("stone", { uneven: true }),
  brick: row("brick", { uneven: true }),
  wood: row("timber"),
  cave_rock: row("rock", { natural: true }),
  plaster: row("plaster"),
  palisade: row("timber"),
  fence: row("timber", { low: true }),
  hedge: row("plant"),
  low_wall: row("stone", { low: true }),
  railing: row("metal", { low: true }),
  iron_bars: row("metal"),
  ruined: row("stone", { uneven: true }),
  railing_stone: row("stone", { low: true }),
  concrete: row("concrete"),
  metal: row("metal"),
  panel: row("plaster"),
  marble: row("stone"),
  dark_stone: row("stone", { uneven: true }),
  timber: row("timber"),
};

/** The style an area with natural walls gets by default (a cave area, a theme whose walls are rock). */
export const NATURAL_WALL_STYLE: WallStyle = "cave_rock";

const KNOWN: ReadonlySet<string> = new Set(WALL_STYLES);

/** The traits of a style; undefined for a name that is not a wall style (such as the rim value "none"). */
export function wallStyleInfo(style: string | null | undefined): WallStyleInfo | undefined {
  return style !== null && style !== undefined && KNOWN.has(style) ? WALL_STYLE_INFO[style as WallStyle] : undefined;
}

/** Natural rock walls (whole-cell blocks, solid mass behind them). */
export function isNaturalWallStyle(style: string | null | undefined): boolean {
  return wallStyleInfo(style)?.natural === true;
}

/** Can be seen over. "none" (no rim at all) counts: nothing hides the hole. */
export function isLowWallStyle(style: string | null | undefined): boolean {
  return style === "none" || wallStyleInfo(style)?.low === true;
}

/** May stand uneven (shortened runs, broken tops, rubble at the foot); a missing style is the theme's default wall. */
export function isUnevenWallStyle(style: string | null | undefined): boolean {
  return wallStyleInfo(style ?? "wall")?.uneven === true;
}

/** Does a level's style table (`ResolvedLevel.wallStyles`) hold natural rock? */
export function hasNaturalWallStyle(styles: readonly string[]): boolean {
  return styles.some((s) => isNaturalWallStyle(s));
}

/** Indices into a level's style table that are natural rock (edges refer to a style by index). */
export function naturalStyleRefs(styles: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  styles.forEach((s, i) => {
    if (isNaturalWallStyle(s)) out.add(i);
  });
  return out;
}
