/**
 * Areas with more cells than a call may have arguments: at the large size tiers a cave or a platform has hundreds of
 * thousands of cells, and a spread argument over one entry per cell (`Math.max(...d.values())`) overflows the call
 * stack. util/lists.ts loops instead (the `slabyrinth/spread-args` lint keeps the spreads out). The review's failing
 * inputs are largeCave.test.ts and largePlatform.test.ts (two files, so the two slow resolves run side by side).
 */
import type { Area, MapPlan, PlanIssue, TerrainOp } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { planRules } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures";

/** One generator-4 level `side` cells a side holding the one area, with the terrain ops given. */
export function oneAreaPlan(side: number, area: Area, terrain: TerrainOp[] = []): MapPlan {
  const plan = loadPlan("single-room");
  const base = plan.levels[0];
  if (!base) throw new Error("single-room has no level");
  plan.levels = [
    {
      ...base,
      bounds: { x: 0, y: 0, w: side, h: side },
      areas: [area],
      features: [],
      openings: [],
      walls: [],
      labels: [],
      terrain,
    },
  ];
  return { ...plan, generator: 4 };
}

/** The errors of validating `plan` at the 1024 tier (validation resolves it; a crash there is a schema error). */
export function errorsAt1024(plan: MapPlan): PlanIssue[] {
  return validatePlan(plan, planRules(loadPalettes(), { sizeTier: "large-1024" })).issues.filter(
    (i) => i.severity === "error",
  );
}
