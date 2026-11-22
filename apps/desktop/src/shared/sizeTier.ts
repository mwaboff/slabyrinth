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

/** "768 × 768" */
export function tierSize(id: SizeTierId): string {
  const side = sizeLimits(id).levelSide;
  return `${String(side)} × ${String(side)}`;
}
