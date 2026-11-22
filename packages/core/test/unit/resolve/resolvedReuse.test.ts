/**
 * planRules' `resolved`: a caller's own resolve of a plan is reused by the geometry check (core matches it to the
 * schema's parsed copy validatePlan checks, by content), and a resolve of anything else (other content, other
 * palettes, some levels only) is never taken. resolvePlan is wrapped to count how often the plan is resolved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { loadPlan } from "../../fixtures";

const counter = vi.hoisted(() => ({ resolves: 0 }));
vi.mock("../../../src/resolve/resolvePlan", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/resolve/resolvePlan")>();
  return {
    ...real,
    resolvePlan: (...args: Parameters<typeof real.resolvePlan>) => {
      counter.resolves++;
      return real.resolvePlan(...args);
    },
  };
});

const { planRules, resolvePlan } = await import("../../../src/resolve/index");

const cat = loadPalettes();

beforeEach(() => {
  counter.resolves = 0;
});

describe("reusing the caller's resolve", () => {
  it("validation reuses it: the same issues, and the plan is not resolved again", () => {
    for (const name of ["keep-dungeon-v8", "example-a", "market-street-v3"] as const) {
      const plan = loadPlan(name);
      const expected = validatePlan(plan, planRules(cat));
      const resolved = resolvePlan(plan, cat);
      counter.resolves = 0;
      const reused = validatePlan(plan, planRules(cat, { resolved: { plan, palettes: cat, resolved } }));
      expect(counter.resolves, name).toBe(0);
      expect(reused).toEqual(expected);
    }
  });

  it("matches by content: a copy with the keys in another order is reused", () => {
    const plan = loadPlan("example-a");
    const resolved = resolvePlan(plan, cat);
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as typeof plan;
    counter.resolves = 0;
    validatePlan(plan, planRules(cat, { resolved: { plan: reordered, palettes: cat, resolved } }));
    expect(counter.resolves).toBe(0);
  });

  it("never takes a stale resolve: other content, other palettes or some levels only resolve again", () => {
    const plan = loadPlan("keep-dungeon-v8");
    const resolved = resolvePlan(plan, cat);
    const reseeded = { ...plan, seed: plan.seed + 1 };
    const someLevels = resolvePlan(plan, cat, { levels: [plan.levels[0]?.id ?? ""] });
    const otherPalettes = loadPalettes();
    for (const [what, reuse, checked] of [
      ["another seed", { plan, palettes: cat, resolved }, reseeded],
      ["other palettes", { plan, palettes: otherPalettes, resolved }, plan],
      ["some levels", { plan, palettes: cat, resolved: someLevels }, plan],
    ] as const) {
      counter.resolves = 0;
      const issues = validatePlan(checked, planRules(cat, { resolved: reuse }));
      expect(counter.resolves, what).toBe(1);
      expect(issues, what).toEqual(validatePlan(checked, planRules(cat)));
    }
  });

  it("a caller's own resolvedFor still works, asked after core's match", () => {
    const plan = loadPlan("example-a");
    const resolved = resolvePlan(plan, cat);
    let asked = 0;
    counter.resolves = 0;
    validatePlan(
      plan,
      planRules(cat, {
        resolvedFor: () => {
          asked++;
          return resolved;
        },
      }),
    );
    expect([asked, counter.resolves]).toEqual([1, 0]);
  });
});
