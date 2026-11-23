/**
 * A trade's props outside its door stand on one floor height (generator 5, switch tradePropsOnOneFloor). Measured on
 * market-street-v3's 150 sweep seeds: 6 raised `verify_prop_sunk`, each the tailor's bench laid along the front over a
 * lowered cell (floor 0) and the raised pavement beside it (floor 1), pushed 0.45 off a side wall toward the pavement:
 * it stood at the low cell's base, sunk a tile into the high one. resolve/level/grid.ts `oneFloorUnder` asks every cell
 * its pushed footprint reaches for its feature base.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** Sweep seeds of market-street-v3 whose tailor's bench was sunk. */
const SEEDS = [3154717994, 1514186459, 1035485675, 3450571044, 317434499, 2641096001];

const sunkTrade = (): string[] =>
  SEEDS.flatMap((seed) => {
    const plan = sweepPlan("market-street-v3", seed);
    return compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "t", plan })
      .diagnostics.filter((d) => d.code === "verify_prop_sunk" && (d.elementId ?? "").includes("~trade#"))
      .map((d) => `${String(seed)} ${d.elementId ?? ""}`);
  });

describe("tradePropsOnOneFloor", () => {
  it("sets no trade prop across a height step; without the switch the tailor's bench is sunk", () => {
    // (the seeds were found before the later street switches redrew the buildings: built as then)
    P5.roofFormsFit = false;
    expect(sunkTrade()).toEqual([]);
    P5.tradePropsOnOneFloor = false;
    expect(sunkTrade().length).toBe(SEEDS.length);
  }, 120_000);
});
