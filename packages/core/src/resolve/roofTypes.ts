/**
 * What each roof type IS, as data: one row per type of the plan's ROOF_TYPES, read through `roofInfo` by the building
 * planner (resolve/building/volumes.ts), the roof geometry (resolve/roof.ts), the condition step and the compiler, which
 * once kept their own lists of type names. A new roof type gets one row here; its geometry is still its own `case`.
 */
import type { RoofType } from "../contracts/plan";
import type { BuiltRoofType } from "../contracts/resolved";
import { own } from "../util/own";

export interface RoofTypeInfo {
  /** The compiler builds it. A type that is not built gets a flat roof and a warning, unless it is built `as` another. */
  built: boolean;
  /** Built as this type instead (a cone is built as a spire). */
  as?: BuiltRoofType;
  /** Closes the roof: no further layer stands on it (a skirt or stepped layer can carry one). */
  closing: boolean;
  /** A volume can stand on it (its deck): a flat roof, none, or the top of a skirt or stepped layer. */
  deck: boolean;
  /** Needs a rectangle (a wing or a rectangular volume) to be built; any other footprint gets a flat roof. */
  rect: boolean;
  /** Sloped (gable, hip, shed): hides the wall tops under it, sits half a tile up on a deck, can keep a gable wall. */
  pitched: boolean;
  /**
   * What closes the ends of its ridge: a gable wall at each end (a chimney stands on one; a ruin keeps one as a gable
   * wing), or slopes on every side (a hip: no wall to carry a stack); null for anything else.
   */
  ends: "gable" | "hip" | null;
  /** A level roof of its own (not "none", which is no roof): it can carry a parapet and a surface. */
  flat: boolean;
  /**
   * No roof at all ("none"): the top storey stays open, nothing is drawn on the map and no roof kit is used. Every
   * other type that is neither bare nor flat is built of the roof kit's pieces (slopes, ring courses, a spire).
   */
  bare: boolean;
  /**
   * Rises to a point in courses that step in (a spire): when the plan gives no course count, the building profile's
   * spire bands draw one.
   */
  tapers: boolean;
  /**
   * Generator 5 (`roofFormsFit`): the deepest span (cells across its slope) a drawn building takes it over as its main
   * roof. A shed rises a tile per cell, so over a house's depth its high side stands as a bare wall taller than the
   * house (it read as a tall box, or a lattice of gable fill); deeper, the draw takes a gable. Absent: no limit.
   */
  maxSpan?: number;
}

const row = (flags: Partial<RoofTypeInfo> = {}): RoofTypeInfo => ({
  built: true,
  closing: false,
  deck: false,
  rect: false,
  pitched: false,
  ends: null,
  flat: false,
  bare: false,
  tapers: false,
  ...flags,
});

export const ROOF_TYPE_INFO: Record<RoofType, RoofTypeInfo> = {
  gable: row({ closing: true, rect: true, pitched: true, ends: "gable" }),
  flat: row({ closing: true, deck: true, flat: true }),
  none: row({ closing: true, deck: true, bare: true }),
  hip: row({ closing: true, rect: true, pitched: true, ends: "hip" }),
  shed: row({ closing: true, rect: true, pitched: true, maxSpan: 3 }),
  cone: row({ built: false, as: "spire" }),
  dome: row({ built: false }),
  skirt: row({ deck: true, rect: true }),
  stepped: row({ deck: true, rect: true }),
  spire: row({ closing: true, rect: true, tapers: true }),
  vault: row({ built: false }),
};

/** The traits of a roof type; undefined for a name that is not one. */
export function roofInfo(type: string): RoofTypeInfo | undefined {
  return own(ROOF_TYPE_INFO, type);
}

/** What closes the ends of a roof type's ridge (RoofTypeInfo.ends); null for no type or a name that is not one. */
export function roofEnds(type: string | undefined): RoofTypeInfo["ends"] {
  return type === undefined ? null : (roofInfo(type)?.ends ?? null);
}

/** Is the roof type a level roof of its own (RoofTypeInfo.flat)? */
export function isFlatRoof(type: string | undefined): boolean {
  return type !== undefined && roofInfo(type)?.flat === true;
}

/** Is the roof type no roof at all (RoofTypeInfo.bare)? */
export function isBareRoof(type: string | undefined): boolean {
  return type !== undefined && roofInfo(type)?.bare === true;
}

/** Is the roof type built of the roof kit's pieces (neither bare nor a level top)? */
export function usesRoofKit(type: string): boolean {
  const info = roofInfo(type);
  return info !== undefined && !info.bare && !info.flat;
}

/** Is the roof type sloped (gable, hip, shed)? */
export function isPitchedRoof(type: string | undefined): boolean {
  return type !== undefined && roofInfo(type)?.pitched === true;
}
