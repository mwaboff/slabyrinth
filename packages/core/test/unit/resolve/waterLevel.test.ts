/** Generator 3: a river's bed follows its channel's low side, so a clipped terrace bank does not raise the surface. */
import { describe, expect, it } from "vitest";
import type { GeneratorVersion, MapPlan } from "../../../src/contracts/plan";
import { resolvePlan } from "../../../src/resolve";

function plan(generator: GeneratorVersion): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "wl",
    title: "WL",
    kind: "outdoor",
    theme: "outdoor",
    seed: 5,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 40, h: 34 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        // a terrace whose foot is at y 20; the brook's first leg runs along that foot and clips the terrace rim
        terrain: [
          {
            id: "terrace",
            op: "platform",
            shape: { type: "rect", x: 0, y: 0, w: 40, h: 21 },
            tiers: 1,
            rise: 2,
            material: "grass",
            edge: "clean",
          },
          {
            id: "brook",
            op: "chasm",
            points: [
              [0, 20],
              [20, 25],
              [39, 28],
            ],
            width: 2,
            depth: 1,
            floor: "water_shallow",
            meander: 0,
          },
        ],
        labels: [],
      },
    ],
  };
}

const warns = (p: MapPlan): number => resolvePlan(p).issues.filter((i) => i.code === "water_level").length;
const surface = (p: MapPlan): number => resolvePlan(p).levels[0]?.waterLevel ?? NaN;

describe("river surface follows the low bank (generator 3)", () => {
  it("generator 2 is unchanged: the clipped terrace raises the surface", () => {
    expect(surface(plan(2))).toBeGreaterThan(1);
  });
  it("generator 3 sets the surface from the channel's low side, with no water_level warning", () => {
    const p = plan(3);
    expect(surface(p)).toBeLessThanOrEqual(0.5);
    expect(warns(p)).toBe(0);
  });
});
