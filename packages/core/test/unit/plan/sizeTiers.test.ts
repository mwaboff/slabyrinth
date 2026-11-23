/**
 * Map size tiers (plan/sizeTiers.ts): the standard limits and the experimental larger-map settings. The tier is passed
 * down by the caller; a plan within the standard limits validates and builds the same whatever tier is active. (The
 * heavy builds at each tier run in the sweep and test/sweep/sizes.ts.)
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan } from "../../../src/contracts/plan";
import { PLAN_LIMITS } from "../../../src/contracts/plan";
import { createToolExecutor, type AgentToolContext } from "../../../src/agent";
import { compileResolved } from "../../../src/compile";
import { applyChecked, applyOps } from "../../../src/ops";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import {
  MAX_LEVEL_SIDE,
  SIZE_TIER_ORDER,
  SIZE_TIERS,
  smallestTierFor,
  validatePlan,
  type SizeTierId,
} from "../../../src/plan";
import { planRules, resolvePlan } from "../../../src/resolve/index";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const cat = loadPalettes();

/** A sparse plan: one solid level `side` cells a side with one small room carved in its middle. */
function sparsePlan(side: number, levels = 1, high = side): MapPlan {
  const plan = loadPlan("single-room");
  const base = plan.levels[0];
  if (!base) throw new Error("single-room has no level");
  const mid = Math.floor(side / 2) - 5;
  const midY = Math.floor(high / 2) - 3;
  plan.levels = Array.from({ length: levels }, (_, k) => ({
    ...base,
    id: `s${k}`,
    name: `Level ${k + 1}`,
    elevation: 4 * k,
    bounds: { x: 0, y: 0, w: side, h: high },
    areas: base.areas.map(
      (a) =>
        ({
          ...Object.fromEntries(Object.entries(a).filter(([f]) => f !== "key")),
          id: `${a.id}${k}`,
          shape: { type: "rect", x: mid, y: midY, w: 8, h: 6 },
        }) as unknown as Area,
    ),
    features: [],
    openings: [],
    walls: [],
    labels: [],
    terrain: [],
  }));
  return { ...plan, generator: 4 };
}

const errors = (plan: MapPlan, sizeTier?: SizeTierId) =>
  validatePlan(plan, planRules(cat, sizeTier ? { sizeTier } : {})).issues.filter(
    (i) => i.severity === "error",
  );

describe("size tiers", () => {
  it("the table is pinned: standard 320 (8 x 160 x 160 cells), then 512, 768 and 1024, experimental", () => {
    expect(SIZE_TIER_ORDER).toEqual(["standard", "large-512", "large-768", "large-1024"]);
    expect(
      SIZE_TIER_ORDER.map((id) => [
        SIZE_TIERS[id].levelSide,
        SIZE_TIERS[id].totalCells,
        SIZE_TIERS[id].experimental,
      ]),
    ).toEqual([
      [320, 204_800, false],
      [512, 1_048_576, true],
      [768, 1_048_576, true],
      [1024, 1_048_576, true],
    ]);
    expect(SIZE_TIERS.standard.levelSide).toBe(PLAN_LIMITS.levelSide);
    expect(SIZE_TIERS.standard.totalCells).toBe(PLAN_LIMITS.totalCells);
    expect(MAX_LEVEL_SIDE).toBe(1024);
    // every tier allows one full level of its own side
    for (const id of SIZE_TIER_ORDER)
      expect(SIZE_TIERS[id].totalCells).toBeGreaterThanOrEqual(SIZE_TIERS[id].levelSide ** 2);
  });

  it("a plan valid in a larger tier is refused in the standard tier, naming the setting", () => {
    const plan = sparsePlan(400);
    expect(smallestTierFor(plan)).toBe("large-512");
    const refused = errors(plan);
    expect(refused.map((i) => [i.code, i.path])).toEqual([
      ["bounds_exceeded", "/levels/0/bounds/w"],
      ["bounds_exceeded", "/levels/0/bounds/h"],
    ]);
    expect(refused[0]?.hint).toMatch(
      /≤ 320 cells a side; or, to try it, the GM can turn on the experimental "larger maps" setting at 512/,
    );
    expect(errors(plan, "large-512")).toEqual([]);
    // more cells together than a tier allows: refused there, pointing at the next tier up
    const five = sparsePlan(512, 5);
    expect(smallestTierFor(five)).toBeNull();
    expect(errors(five, "large-512").map((i) => i.code)).toEqual(["limit_exceeded"]);
    expect(errors(five, "large-512")[0]?.message).toMatch(/1310720 cells together .*the limit is 1048576/);
    const two = sparsePlan(320, 3);
    expect(smallestTierFor(two)).toBe("large-512");
    expect(errors(two)[0]?.hint).toMatch(/"larger maps" setting at 512/);
    expect(smallestTierFor(sparsePlan(1025))).toBeNull();
    // beyond every tier the schema refuses it, as before
    expect(errors(sparsePlan(1025), "large-1024").map((i) => i.code)).toContain("bounds_exceeded");
  });

  it("applyOps and applyChecked validate at the rules' tier", () => {
    const plan = sparsePlan(400);
    const op = { op: "set_meta", title: "Wide" } as const;
    const large = planRules(cat, { sizeTier: "large-512" });
    const applied = applyOps(plan, [op], large);
    expect(applied.ok ? [] : applied.issues.map((i) => i.code)).toEqual([]);
    const checked = applyChecked(plan, [op], large);
    expect(checked.ok ? [] : checked.issues.map((i) => i.code)).toEqual([]);
    // the standard tier still refuses it
    const refused = applyOps(plan, [op], planRules(cat));
    expect(refused.ok ? [] : refused.issues.map((i) => i.code)).toEqual([
      "bounds_exceeded",
      "bounds_exceeded",
    ]);
  }, 30_000); // three applies of a 400-cell plan: about 2.5 s locally under a parallel run

  it("a plan within the standard limits validates the same whatever tier is active", () => {
    for (const name of ["keep-dungeon-v8", "market-street-v3", "example-a"] as const) {
      const plan = loadPlan(name);
      const standard = validatePlan(plan, planRules(cat));
      for (const id of SIZE_TIER_ORDER)
        expect(validatePlan(plan, planRules(cat, { sizeTier: id }))).toEqual(standard);
    }
  });

  it.each(SIZE_TIER_ORDER)(
    "%s: a strip as wide as the tier allows validates in it and builds (the full-area builds run in the sweep)",
    (id) => {
      const plan = sparsePlan(SIZE_TIERS[id].levelSide, 1, 12);
      expect(errors(plan, id)).toEqual([]);
      const b = compileResolved(resolvePlan(plan, cat), cat, slabCodec, { createdAt: "t", plan });
      expect(b.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(b.chunks.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it("the model's tools hold plans to the tier in their context", async () => {
    const exec = createToolExecutor();
    const plan = sparsePlan(400);
    const authored: Record<string, unknown> = { ...plan };
    delete authored["schema"];
    delete authored["generator"];
    delete authored["id"];
    const ctx = (sizeTier?: SizeTierId): AgentToolContext => ({
      plan: null,
      head: 0,
      brief: {},
      renderImage: null,
      estimate: () => null,
      catalog: { themes: [], featureCoverage: () => ({}) },
      newSeed: () => 1,
      newPlanId: () => "00000000-0000-4000-8000-000000000001",
      palettes: bundledPalettes(),
      nextVersion: 1,
      ...(sizeTier ? { sizeTier } : {}),
    });
    const input = { replace: false, summary: "big", plan: authored };
    expect((await exec(ctx(), "create_plan", input)).ok).toBe(false);
    expect((await exec(ctx("large-512"), "create_plan", input)).ok).toBe(true);
  }, 60_000);
});
