/**
 * What each wall style IS, as data: one table of traits that every stage reads instead of keeping its own literal set
 * of style names. A new style gets one row here, and every rule that asks "is it
 * rock", "can you see over it" or "may it be weathered" answers for it.
 *
 * The table says nothing about themes. Whether a room is built rough (`ResolvedArea.finish`: the theme's interior
 * character) and whether it is kept up (`ResolvedArea.abandoned`, gen/roomPurpose.ts) are decided per theme and per
 * room; this table only says whether the STYLE can carry the weathering at all.
 */
import type { Material, WallStyle } from "../contracts/plan";
import { WALL_STYLES } from "../contracts/plan";

/** What a wall style is made of; a consumer that needs a material (a skirt, a cap, a floor to match) reads this. */
export type WallFamily =
  | "theme" // THEME_WALL_STYLE: whatever the theme's default wall is made of; the palette decides
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
  /**
   * The material a flat piece laid on top of this wall is made of (the cap that closes the gap between two tidy rooms,
   * compile/realize/solidShell.ts): the floor role of that material, resolved through the palette like any floor.
   * Null for the theme's own wall: the palette that supplies the wall decides (palette/wallTop.ts). Defaults to the
   * family's material (`FAMILY_SURFACE`).
   */
  surface: Material | null;
  /**
   * Built of planks (generator 3 ruins): what falls from it is its own material (beams and planks, its
   * `ruin_rubble.<style>` / `ruin_block.<style>` roles, never stone), and a ruined building of it keeps no lone gable
   * wall (a stepped gable standing alone is masonry logic). Log palisades and half-timbered panels are not.
   */
  planks: boolean;
}

/** The material of each wall family, as a flat surface (a wall's top). "theme" is the palette's to say. */
const FAMILY_SURFACE: Record<WallFamily, Material | null> = {
  theme: null,
  stone: "flagstone",
  brick: "brick",
  timber: "wood_plank",
  plaster: "stone_tile",
  concrete: "concrete",
  metal: "concrete",
  rock: "rock",
  plant: "grass",
};

/**
 * Trims (generator 5 detail recipes: bands, posts, plinths, pilasters, skins) in a second material: which families may
 * trim a wall of each family (stone bands and quoins on brick, a brick or stone plinth under timber, timber framing on
 * stone or plaster), in order of preference, and the style whose roles (`facade_post.<style>`, `wall_post.<style>`)
 * name a family's trim pieces. A family with none is trimmed only in its own material. "theme" is the palette's own
 * wall, whatever it is built of: masonry or timber trims it.
 */
export const FAMILY_TRIMS: Readonly<Record<WallFamily, readonly WallFamily[]>> = {
  theme: ["stone", "timber"],
  stone: ["timber", "brick"],
  brick: ["stone", "timber"],
  timber: ["stone", "brick"],
  plaster: ["timber", "stone", "brick"],
  concrete: ["metal", "stone"],
  metal: ["concrete"],
  rock: [],
  plant: [],
};

/** The style that names a family's trim roles (null: the family has none of its own). */
export const FAMILY_TRIM_STYLE: Readonly<Record<WallFamily, WallStyle | null>> = {
  theme: "wall",
  stone: "stone",
  brick: "brick",
  timber: "wood",
  plaster: "plaster",
  concrete: "concrete",
  metal: "metal",
  rock: null,
  plant: null,
};

const row = (family: WallFamily, flags: Partial<Omit<WallStyleInfo, "family">> = {}): WallStyleInfo => ({
  family,
  natural: false,
  low: false,
  uneven: false,
  planks: false,
  surface: FAMILY_SURFACE[family],
  ...flags,
});

export const WALL_STYLE_INFO: Record<WallStyle, WallStyleInfo> = {
  wall: row("theme", { uneven: true }),
  stone: row("stone", { uneven: true }),
  brick: row("brick", { uneven: true }),
  wood: row("timber", { planks: true }),
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
  marble: row("stone", { surface: "marble" }),
  dark_stone: row("stone", { uneven: true }),
  timber: row("timber"),
};

/**
 * The theme's own wall: whatever wall the theme's palette supplies (`wall.wall`). The style of an edge or a storey that
 * names none, and the default of an area that is not natural rock.
 */
export const THEME_WALL_STYLE: WallStyle = "wall";

/** The style an area with natural walls gets by default (a cave area, a theme whose walls are rock). */
export const NATURAL_WALL_STYLE: WallStyle = "cave_rock";

const KNOWN: ReadonlySet<string> = new Set(WALL_STYLES);

/** The traits of a style; undefined for a name that is not a wall style (such as the rim value "none"). */
export function wallStyleInfo(style: string | null | undefined): WallStyleInfo | undefined {
  return style !== null && style !== undefined && KNOWN.has(style)
    ? WALL_STYLE_INFO[style as WallStyle]
    : undefined;
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
  return wallStyleInfo(style ?? THEME_WALL_STYLE)?.uneven === true;
}

/** Built of planks (a ruin of it leaves its own beams and planks, no lone gable wall). */
export function isPlankWallStyle(style: string | null | undefined): boolean {
  return wallStyleInfo(style)?.planks === true;
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
