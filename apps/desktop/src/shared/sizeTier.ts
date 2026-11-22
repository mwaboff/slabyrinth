/**
 * The map size tier a project works at (core plan/sizeTiers.ts): the "Maximum map size" setting, raised to what the
 * project's plan needs, so a saved map larger than the setting still opens, edits and builds (decisions.md
 * 2026-11-22). Main (validation, the agent, builds) and the renderer (the preview's plan check) ask this same function.
 */
import type { MapPlan } from "@slabyrinth/core";
import { SIZE_TIER_ORDER, sizeLimits, smallestTierFor, type SizeTierId } from "@slabyrinth/core/plan";

const rank = (id: SizeTierId): number => SIZE_TIER_ORDER.indexOf(id);

/** The tier the plan needs when that is above the setting, else null. */
export function tierAboveSetting(
  setting: SizeTierId | undefined,
  plan: Pick<MapPlan, "levels"> | null,
): SizeTierId | null {
  const needed = plan ? smallestTierFor(plan) : null;
  return needed !== null && rank(needed) > rank(setting ?? "standard") ? needed : null;
}

/** The setting, or the tier the plan needs when that is larger. */
export function activeSizeTier(
  setting: SizeTierId | undefined,
  plan: Pick<MapPlan, "levels"> | null,
): SizeTierId {
  return tierAboveSetting(setting, plan) ?? setting ?? "standard";
}

/**
 * What each size costs on the owner's machine class (±50%), measured with core's test/sweep/sizes.ts
 * (docs/internal/handoff-size-tiers.md): seconds to check one change (validate), extra seconds per build, seconds of
 * design review per change, and peak memory. The settings note and the chat's time estimate both read this one table.
 */
export const TIER_COSTS: Record<
  SizeTierId,
  { change: [number, number]; build: [number, number]; review: number; memoryGb: number }
> = {
  standard: { change: [0, 1], build: [0, 0], review: 0, memoryGb: 0.5 },
  "large-512": { change: [2, 5], build: [4, 4], review: 3, memoryGb: 1.2 },
  "large-768": { change: [4, 9], build: [8, 8], review: 4, memoryGb: 2 },
  "large-1024": { change: [6, 16], build: [12, 18], review: 8, memoryGb: 2.6 },
};

/**
 * Seconds main spends checking each step of the AI's turn at this size (the plan check and the design review, at the
 * slow end), on top of the model's own time. Standard: nothing worth adding.
 */
export function checkSecondsPerStep(id: SizeTierId): number {
  const c = TIER_COSTS[id];
  return id === "standard" ? 0 : c.change[1] + c.review;
}

/** "768 × 768" */
export function tierSize(id: SizeTierId): string {
  const side = sizeLimits(id).levelSide;
  return `${String(side)} × ${String(side)}`;
}
