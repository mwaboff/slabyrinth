import { bundledPalettes, planRules, type PlanRules } from "@slabyrinth/core";

/** The fake bridge builds with the bundled palettes: the plan rules (checks, materialize) for those. */
export function fakeRules(): PlanRules {
  return planRules(bundledPalettes());
}
