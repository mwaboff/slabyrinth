/**
 * What each floor material IS, as data: one table of traits that the resolver (and the compiler) read instead of
 * keeping their own literal sets of material names. A new material gets one row
 * here, and every rule that asks "is it water", "is it natural ground" or "what bridge is it" answers for it. Wall
 * styles have the same kind of table (gen/wallStyles.ts).
 */
import type { BridgeSpan, Material } from "../contracts/plan";
import { MATERIALS } from "../contracts/plan";
import type { Tone } from "../palette/tones";

export interface MaterialInfo {
  /** Water: TaleSpire's board-wide water plane covers it, so the slab carries only the channel's bed. */
  water: boolean;
  /**
   * A liquid (water, lava): built with a floor piece it is only a picture of ordinary floor, so a theme without its own
   * tile for it is warned about (verify's material fidelity note).
   */
  liquid: boolean;
  /** Deadly to stand in (lava): no ground to stand on, and the floor of a rift it fills (the review). */
  hazard: boolean;
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
  /**
   * A built floor (generator 4, resolve/interiorFloors.ts): a room whose floor is the theme's default built floor takes
   * the floor its purpose asks for instead.
   */
  built: boolean;
  /**
   * How pale the material's floor usually is: the last answer of resolve/interiorFloors.ts floorTone, a guess from the
   * pieces, used only where the palette's floor variants carry no tone. Absent for a floor that is never toned.
   */
  tone?: Tone;
}

const row = (flags: Partial<MaterialInfo> = {}): MaterialInfo => ({
  water: false,
  liquid: false,
  hazard: false,
  natural: false,
  cliffGround: false,
  deckSpan: "arch",
  built: false,
  ...flags,
});
/** Natural ground: winds, cliffs as rock, a deck of it is a natural span. */
const ground = (flags: Partial<MaterialInfo> = {}): MaterialInfo =>
  row({ natural: true, cliffGround: true, deckSpan: "natural", ...flags });

export const MATERIAL_INFO: Record<Material, MaterialInfo> = {
  flagstone: row({ built: true, tone: "dark" }),
  stone_tile: row({ built: true, tone: "mid" }),
  marble: row({ built: true, tone: "light" }),
  brick: row({ built: true, tone: "dark" }),
  cobble: row({ built: true, tone: "dark" }),
  wood_plank: row({ deckSpan: "plank", built: true, tone: "mid" }),
  carpet: row({ built: true, tone: "mid" }),
  rock: ground({ tone: "dark" }),
  dirt: ground({ tone: "dark" }),
  grass: ground({ tone: "mid" }),
  sand: ground({ tone: "light" }),
  gravel: ground({ tone: "mid" }),
  mud: ground({ tone: "dark" }),
  snow: ground({ tone: "light" }),
  ice: ground({ tone: "light" }),
  // a swamp deck reads as built, not as a natural land bridge
  swamp: ground({ deckSpan: "arch", tone: "mid" }),
  water_shallow: row({ water: true, liquid: true }),
  water_deep: row({ water: true, liquid: true }),
  lava: row({ liquid: true, hazard: true, cliffGround: true, tone: "dark" }),
  bridge_wood: row({ deckSpan: "plank", tone: "mid" }),
  asphalt: row({ tone: "dark" }),
  concrete: row({ tone: "mid" }),
};

/** Is the material a built floor (MaterialInfo.built)? */
export function isBuiltFloor(m: Material): boolean {
  return MATERIAL_INFO[m].built;
}

/** The traits of a material. */
export function materialInfo(m: Material): MaterialInfo {
  return MATERIAL_INFO[m];
}

/** Water (the board's water plane covers it). */
export function isWater(m: Material): boolean {
  return MATERIAL_INFO[m].water;
}

/** A liquid (water, lava): a floor piece of another material only pictures it. */
export function isLiquid(m: Material): boolean {
  return MATERIAL_INFO[m].liquid;
}

/** Deadly to stand in (lava). */
export function isHazard(m: Material): boolean {
  return MATERIAL_INFO[m].hazard;
}

/**
 * Is the material name one of the table's, with the trait? For readers holding a level's material table as strings
 * (an unknown name has no trait).
 */
export function materialHas(name: string, trait: (info: MaterialInfo) => boolean): boolean {
  return Object.hasOwn(MATERIAL_INFO, name) && trait(MATERIAL_INFO[name as Material]);
}

/**
 * Bare rock (compile/realize/floors.ts): what natural low ground under a cliff's rock band is laid as, and the floor a
 * water bed falls back to last.
 */
export const BARE_ROCK: Material = "rock";

/** The floor a water bed is laid with when the theme has no `bed.*` role, before the bank's own floor. */
export const BED_FALLBACK_FLOOR: Material = "gravel";

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
