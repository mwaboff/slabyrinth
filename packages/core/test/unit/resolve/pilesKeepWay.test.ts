/**
 * A wall-foot pile never cuts the floor (generator 5, switch pilesKeepWay; found by the seed sweep once it read
 * playability). keep-dungeon-v8@4203543429: the cell room under the shrine's ladder had its ladder opening beside a
 * bunk; the room's furnisher kept the way round them, and the blocking rubble pile laid afterwards in the room's
 * corner closed the one strip past the bunk, so the ladder, and the antechamber and shrine below it, were cut off.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const unreachable = (seed: number): string[] => {
  const plan = sweepPlan("keep-dungeon-v8", seed);
  return checkPlayability(plan, resolvePlan(plan, pal))
    .filter((i) => i.code === "unreachable")
    .map((i) => `${i.levelId ?? ""}/${i.elementId ?? ""}`);
};

describe("a wall-foot pile never cuts the floor (pilesKeepWay)", () => {
  it("the shrine's ladder stays reached (keep-dungeon-v8@4203543429)", () => {
    expect(unreachable(4203543429)).toEqual([]);
  }, 30_000);

  it("without the switch the corner pile cuts off the ladder, the antechamber and the shrine", () => {
    P5.pilesKeepWay = false;
    expect(unreachable(4203543429)).toEqual(["l3/ante", "l3/shrine"]);
  }, 30_000);
});
