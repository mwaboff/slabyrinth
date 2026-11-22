/**
 * Facts about how a plan's levels stack, shared by the resolver (what it may raise), realize (what it may build) and
 * verify (what it measures), so the three agree on what the level above leaves room for.
 */
import { BUILD_CONSTANTS } from "../contracts/plan";

/** Cell heights are stored in quarter tiles (ResolvedLevel.cells.height, plan heights snap to them). */
export const QUARTERS_PER_TILE = 4;

/** Clear height a creature needs above a floor top (a medium creature with margin), tiles. */
export const HEADROOM = 1.5;

/** Elevations closer than this count as the same (tiles). */
const SAME_ELEVATION = 1e-6;

/**
 * The ceiling over a level at `elevation`: the elevation of the lowest level stacked higher in the plan (whatever its
 * bounds: stacked levels share the plan grid), Infinity when none is. Nothing built on the level rises through it.
 */
export function levelCeiling(levels: readonly { elevation: number }[], elevation: number): number {
  let ceiling = Infinity;
  for (const o of levels)
    if (o.elevation > elevation + SAME_ELEVATION) ceiling = Math.min(ceiling, o.elevation);
  return ceiling;
}

/**
 * The highest floor top (absolute, tiles) a level at `elevation` may have and still leave HEADROOM under its ceiling;
 * Infinity with no level above. A floor top is the level's elevation plus the cell height plus the floor thickness.
 */
export function highestFloorTop(levels: readonly { elevation: number }[], elevation: number): number {
  return levelCeiling(levels, elevation) - HEADROOM;
}

/** The floor top of a cell `height` tiles above a level at `elevation` (the top of its floor tile). */
export function floorTopAt(elevation: number, height: number): number {
  return elevation + height + BUILD_CONSTANTS.floorThickness;
}
