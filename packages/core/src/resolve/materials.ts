/**
 * What each floor material IS, as data: one table of traits that the resolver (and the compiler) read instead of
 * keeping their own literal sets of material names. A new material gets one row
 * here, and every rule that asks "is it water", "is it natural ground" or "what bridge is it" answers for it. Wall
 * styles have the same kind of table (gen/wallStyles.ts).
 */
import type { BridgeSpan, Material } from "../contracts/plan";
import { MATERIALS } from "../contracts/plan";

export interface MaterialInfo {
  /** Water: TaleSpire's board-wide water plane covers it, so the slab carries only the channel's bed. */
  water: boolean;
  /**
   * Natural ground (generator 2): a path of it winds, a platform of it gets ragged contours, a level based on it gets a
   * natural board outline and a rock band on its cliffs.
   */
  natural: boolean;
  /**
   * Natural ground whose drops of a tile or more the compiler builds as rock cliffs: the natural ground above, and lava.
   * Kept apart from `natural` because lava is not ground a path winds over.
   */
  cliffGround: boolean;
  /** The span a bridge deck of this material is built as when the plan does not say (resolve/level/bridges.ts). */
  deckSpan: BridgeSpan;
}

const row = (flags: Partial<MaterialInfo> = {}): MaterialInfo => ({
  water: false,
  natural: false,
  cliffGround: false,
  deckSpan: "arch",
  ...flags,
});
/** Natural ground: winds, cliffs as rock, a deck of it is a natural span. */
const ground = (flags: Partial<MaterialInfo> = {}): MaterialInfo =>
  row({ natural: true, cliffGround: true, deckSpan: "natural", ...flags });

export const MATERIAL_INFO: Record<Material, MaterialInfo> = {
  flagstone: row(),
  stone_tile: row(),
  marble: row(),
  brick: row(),
  cobble: row(),
  wood_plank: row({ deckSpan: "plank" }),
  carpet: row(),
  rock: ground(),
  dirt: ground(),
  grass: ground(),
  sand: ground(),
  gravel: ground(),
  mud: ground(),
  snow: ground(),
  ice: ground(),
  // a swamp deck reads as built, not as a natural land bridge
  swamp: ground({ deckSpan: "arch" }),
  water_shallow: row({ water: true }),
  water_deep: row({ water: true }),
  lava: row({ cliffGround: true }),
  bridge_wood: row({ deckSpan: "plank" }),
  asphalt: row(),
  concrete: row(),
};

/** The traits of a material. */
export function materialInfo(m: Material): MaterialInfo {
  return MATERIAL_INFO[m];
}

/** Water (the board's water plane covers it). */
export function isWater(m: Material): boolean {
  return MATERIAL_INFO[m].water;
}

/** Natural ground (paths wind, platforms are ragged, the board gets a natural outline). */
export function isNaturalGround(m: Material): boolean {
  return MATERIAL_INFO[m].natural;
}

/**
 * Ground whose drops of a tile or more are built as rock cliffs when the palette has no cliff.<material> role, whose
 * bare faces show rock and whose floors take floor families (the realize passes): natural ground and lava.
 */
export function isCliffGround(m: Material): boolean {
  return MATERIAL_INFO[m].cliffGround;
}

/** A material as the resolver's cell arrays store it: its index in MATERIALS plus one (0 = no floor). */
export function materialOrdinal(m: Material): number {
  return MATERIALS.indexOf(m) + 1;
}
