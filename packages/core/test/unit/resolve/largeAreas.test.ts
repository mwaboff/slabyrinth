/**
 * Areas with more cells than a call may have arguments: at the large size tiers a cave or a platform has hundreds of
 * thousands of cells, and a spread argument over one entry per cell (`Math.max(...d.values())`) overflows the call
 * stack. util/lists.ts loops instead (the `slabyrinth/spread-args` lint keeps the spreads out).
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { planRules, resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures";

const cat = loadPalettes();

/** One generator-4 level `side` cells a side holding the one area, with the terrain ops given. */
function onePlan(side: number, area: Area, terrain: TerrainOp[] = []): MapPlan {
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

describe("large areas resolve at the 1024 tier", () => {
  it("a 370 x 370 cave", { timeout: 120_000 }, () => {
    const plan = onePlan(374, {
      id: "deep",
      kind: "cave",
      shape: { type: "rect", x: 2, y: 2, w: 370, h: 370 },
    });
    const rules = planRules(cat, { sizeTier: "large-1024" });
    expect(validatePlan(plan, rules).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(resolvePlan(plan, cat).levels[0]?.id).toBe(plan.levels[0]?.id);
  });

  it("a 498 x 498 platform in a courtyard", { timeout: 120_000 }, () => {
    const plan = onePlan(
      520,
      { id: "yard", kind: "courtyard", shape: { type: "rect", x: 10, y: 10, w: 500, h: 500 } },
      [
        {
          id: "dais",
          op: "platform",
          shape: { type: "rect", x: 11, y: 11, w: 498, h: 498 },
          tiers: 1,
        },
      ],
    );
    const rules = planRules(cat, { sizeTier: "large-1024" });
    expect(validatePlan(plan, rules).issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
