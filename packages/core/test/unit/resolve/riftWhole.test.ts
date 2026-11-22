/**
 * A rift is one crack for any seed (generator 4, switch `channelFloorWhole`): the chasm op's shelves (rim cells cut
 * only part-way down, keeping their ground) never break the floor it lays (lava here) into separate pits, so the review
 * never reports rift_broken on a plan nobody edited. Generator 3 is frozen: some of its seeds still pinch the lava to
 * a diagonal step across a shelf (about a quarter of them).
 */
import { describe, expect, it } from "vitest";
import type { GeneratorVersion, MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

/** A cave floor of rock with a 4-wide lava rift from the north edge to the south edge. */
const riftPlan = (generator: GeneratorVersion, seed: number): MapPlan => ({
  schema: "slabyrinth/plan@1",
  generator,
  id: "rift",
  title: "Rift",
  kind: "outdoor",
  theme: "cave",
  seed,
  links: [],
  levels: [
    {
      id: "l1",
      name: "l1",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 46, h: 34 },
      base: { type: "ground", material: "rock" },
      areas: [],
      openings: [],
      walls: [],
      features: [],
      labels: [],
      terrain: [
        {
          id: "rift",
          op: "chasm",
          points: [
            [20, 0],
            [21, 34],
          ],
          width: 4,
          depth: 3,
          floor: "lava",
        },
      ],
    },
  ],
});

const broken = (generator: GeneratorVersion, seed: number): boolean => {
  const plan = riftPlan(generator, seed);
  const pal = bundledPalettes();
  return reviewDesign(plan, resolvePlan(plan, pal), pal, { limit: 999 }).some(
    (n) => n.code === "rift_broken",
  );
};

describe("a rift is one crack for any seed (generator 4)", () => {
  it.each(SEEDS)("seed %i: no rift_broken", (seed) => {
    expect(broken(4, seed)).toBe(false);
  });

  it("generator 3 is frozen: some seeds still lay the rift as two pits", () => {
    expect(SEEDS.slice(0, 8).filter((s) => broken(3, s)).length).toBeGreaterThan(0);
  });
});
