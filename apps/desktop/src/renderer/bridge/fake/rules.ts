import { bundledPalettes, planRules, type PlanRules } from "@slabyrinth/core";
import type { SizeTierId } from "@slabyrinth/core/plan";

/** The fake main's map size tier: its settings' mapSize (createFakeBridge sets it). */
let sizeTier: () => SizeTierId = () => "standard";

export function setFakeSizeTier(tier: () => SizeTierId): void {
  sizeTier = tier;
}

/** The fake bridge builds with the bundled palettes: the plan rules (checks, materialize) for those, at its tier. */
export function fakeRules(): PlanRules {
  return planRules(bundledPalettes(), { sizeTier: sizeTier() });
}
