/**
 * Generator 2 varies the height of rock wall columns. Under a level stacked 2.5 tiles above, those columns stayed
 * below that level's floor only on generator 1: on generator 2 the 2-tile blocks (plus the extra height) rose
 * through the floor above, and the build check then found every room of the upper level unreachable (the e2e UI
 * plan, example A, made as a new generator-2 map in 0.1.2).
 */
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

describe("generator 2: rock walls under a stacked level", () => {
  it("example A as a generator-2 plan builds with no errors and nothing rising into the level above", () => {
    const plan = { ...loadPlan("example-a"), generator: 2 as const };
    const bundle = compileResolved(resolvePlan(plan), loadPalettes(), slabCodec, { createdAt: "t", plan });
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(bundle.diagnostics.filter((d) => d.code === "verify_pokes_into_level_above")).toEqual([]);
  });
});
