/**
 * Map size tiers: how large a plan may be. The standard tier is PLAN_LIMITS (320 cells a side, the levels together
 * at most 8 × 160 × 160 cells). The larger tiers are an experimental, opt-in setting for big maps: slower edits are
 * the accepted cost (docs/decisions.md 2026-11-22, measured with test/sweep/sizes.ts).
 *
 * The tier is chosen by the caller and passed down (`ValidateContext.limits`, `planRules(palettes, { sizeTier })`,
 * the agent's `AgentToolContext.sizeTier`); it is not part of the plan. A saved plan re-derives the tier it needs with
 * `smallestTierFor`. Everything below the standard limits validates and builds the same whatever tier is active.
 */
import { PLAN_LIMITS, type MapPlan } from "../contracts/plan";
import { maxOf } from "../util/lists";

export type SizeTierId = "standard" | "large-512" | "large-768" | "large-1024";

export interface SizeLimits {
  readonly id: SizeTierId;
  /** Cells across one level, either way (Level.bounds w and h). */
  readonly levelSide: number;
  /** Cells of all levels together (sum of bounds w × h). */
  readonly totalCells: number;
  /** An opt-in test setting, not the default. */
  readonly experimental: boolean;
}

/**
 * The cells every experimental tier allows together: one 1024 × 1024 level, or 4 levels of 512 × 512, or one of 768 and
 * more. Time and memory grow with all cells of all levels, not with the side (test/sweep/sizes.ts, 2026-11-22): at
 * this many a dense build peaks near 2.5 GB, the last size that keeps clear of a 4 GB JavaScript heap.
 */
export const LARGE_MAP_CELLS = 1024 * 1024;

/** The tiers, smallest first. Each allows one full level at its side; the cell budget limits the levels together. */
export const SIZE_TIERS: Readonly<Record<SizeTierId, SizeLimits>> = {
  standard: {
    id: "standard",
    levelSide: PLAN_LIMITS.levelSide,
    totalCells: PLAN_LIMITS.totalCells,
    experimental: false,
  },
  "large-512": { id: "large-512", levelSide: 512, totalCells: LARGE_MAP_CELLS, experimental: true },
  "large-768": { id: "large-768", levelSide: 768, totalCells: LARGE_MAP_CELLS, experimental: true },
  "large-1024": { id: "large-1024", levelSide: 1024, totalCells: LARGE_MAP_CELLS, experimental: true },
};

export const SIZE_TIER_ORDER: readonly SizeTierId[] = ["standard", "large-512", "large-768", "large-1024"];

/** The largest side any tier allows: the schema's own bound and the size typed arrays are built for. */
export const MAX_LEVEL_SIDE = maxOf(SIZE_TIER_ORDER.map((id) => SIZE_TIERS[id].levelSide));

/** The limits of a tier (the standard one when none is named). */
export function sizeLimits(id: SizeTierId = "standard"): SizeLimits {
  return SIZE_TIERS[id];
}

/** The smallest tier a plan fits in (by its levels' bounds), or null when it is larger than every tier. */
export function smallestTierFor(plan: Pick<MapPlan, "levels">): SizeTierId | null {
  const side = Math.max(0, maxOf(plan.levels.map((l) => Math.max(l.bounds.w, l.bounds.h))));
  const cells = plan.levels.reduce((s, l) => s + l.bounds.w * l.bounds.h, 0);
  return (
    SIZE_TIER_ORDER.find((id) => side <= SIZE_TIERS[id].levelSide && cells <= SIZE_TIERS[id].totalCells) ??
    null
  );
}
