/**
 * The street and condition round (generator 5) on the varied-street-v1 and condition-street-v1 fixtures, each a fault
 * the owner's screenshots showed, held by the switch that fixes it (the switch off rebuilds the fault):
 *   twinnedPairs   a guardian pair is one piece twinned, both standing or neither (resolve/recipes/threshold.ts).
 */
import { describe, expect, it } from "vitest";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import type { MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import { generatorProfile, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { approachLights, guardianPair } from "../../../src/resolve/recipes/threshold";
import { loadPlan } from "../../fixtures";
import { forced } from "../../fixtures/treatments";

const pal = bundledPalettes();

/** A fixture's first level, resolved, without its arrangements (a recipe run's input). */
function bareLevel(plan: MapPlan): ResolvedLevel {
  const L = resolvePlan(plan, pal).levels[0] as ResolvedLevel;
  const bare: ResolvedLevel = { ...L };
  delete bare.arrangements;
  return bare;
}

describe("twinnedPairs: a guardian pair is one piece twinned", () => {
  const plan = loadPlan("varied-street-v1");
  const bare = bareLevel(plan);
  const run = (profile: GeneratorProfile) =>
    runRecipes(bare, new ArrangementRecords(), {
      planSeed: plan.seed,
      profile,
      palette: resolveView(plan, pal),
      budget: 1e6,
      families: forced({ threshold: { guardianPair: "pair", approachLights: "pair" } }),
      recipes: [guardianPair, approachLights],
    }).attached;

  it("stands both of a pair, the same piece, or neither (never one half where the other side is in the way)", () => {
    const on = run(generatorProfile(5));
    expect(on.length).toBeGreaterThan(0);
    for (const a of on) {
      expect(a.pieces).toHaveLength(2);
      expect(a.pieces[0]?.asset).toBe(a.pieces[1]?.asset);
      expect(a.pieces[0]?.yaw).toBe(a.pieces[1]?.yaw);
      // mirrored about the door's axis
      expect((a.pieces[0]?.x ?? 0) + (a.pieces[1]?.x ?? 0)).toBeCloseTo(0, 6);
      expect(a.pieces[0]?.z).toBeCloseTo(a.pieces[1]?.z ?? NaN, 6);
    }
    // without the switch the manor's door (its way to the lane runs past one side) keeps a lone guardian
    const off = run({ ...generatorProfile(5), twinnedPairs: false });
    expect(off.some((a) => a.pieces.length === 1)).toBe(true);
  });
});
