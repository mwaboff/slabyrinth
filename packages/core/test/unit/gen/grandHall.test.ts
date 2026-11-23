/**
 * The grand hall (generator 5, switch grandHalls; techniques int-grand-hall, pier-grid-hall, pillars-at-thirds): a big
 * great hall, throne room or nave is laid out as one, from the room-kind table's hall plan (gen/roomTraits.ts): its
 * axis clear end to end, its columns mirrored about it at the third points across (piers, thirds or none, drawn per
 * room), its tables or benches in the side bays. A small one keeps its kind's ordinary layout.
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan } from "../../../src/contracts/plan";
import type { ResolvedFeature } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { HALL_SIZE, hallPlanOf } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

/** A hall 13 wide and 20 long (north-south), entered at its south end from a gallery. */
const hallPlan = (name: string, generator: 4 | 5, seed: number, w = 13, h = 20): MapPlan =>
  dungeonPlan({
    generator,
    seed,
    w: w + 4,
    h: h + 6,
    areas: [
      { id: "hall", kind: "room", name, shape: { type: "rect", x: 2, y: 1, w, h } } satisfies Area,
      {
        id: "gallery",
        kind: "corridor",
        name: "Gallery",
        shape: { type: "rect", x: 1, y: h + 1, w: w + 2, h: 2 },
      },
    ],
    openings: [{ id: "door", kind: "double_door", between: ["hall", "gallery"] }],
  });

const inHall = (p: MapPlan): ResolvedFeature[] =>
  (resolvePlan(p, pal).levels[0]?.features ?? []).filter((f) => f.area === "hall");

describe("grand hall (grandHalls)", () => {
  it("the kind table says which rooms are halls: big great halls, throne rooms and naves, not small ones", () => {
    expect(hallPlanOf("dining", 260, 13)).toBeDefined();
    expect(hallPlanOf("throne_room", 260, 13)).toBeDefined();
    expect(hallPlanOf("shrine", 260, 13)).toBeDefined();
    expect(hallPlanOf("dining", HALL_SIZE.minCells - 1, 13)).toBeUndefined();
    expect(hallPlanOf("dining", 260, HALL_SIZE.minWidth - 1)).toBeUndefined();
    expect(hallPlanOf("kitchen", 260, 13)).toBeUndefined();
  });

  it("the axis stays clear, the columns stand mirrored at the third points, and the options vary", () => {
    const seen = { piers: 0, thirds: 0, plain: 0 };
    for (const name of ["Great hall", "Throne room", "Temple nave"])
      for (const seed of SEEDS) {
        const fs = inHall(hallPlan(name, 5, seed));
        // the hall spans x 2..14 (13 across): column lines at 2 + 4 and 2 + 8, the nave between them
        const pillars = fs.filter((f) => f.type === "pillar");
        for (const p of pillars) {
          expect([6, 10], `${name} seed ${seed}`).toContain(p.at[0]);
          const mirror = 16 - p.at[0];
          expect(pillars.some((q) => q.at[0] === mirror && q.at[1] === p.at[1])).toBe(true);
        }
        // nothing blocking stands in the nave, but at the far wall (the focal end) and the door's landing
        const inNave = fs.filter(
          (f) =>
            f.blocking &&
            !featureInfo(f.type).light &&
            f.at[0] + f.size[0] - 1 >= 7 &&
            f.at[0] <= 9 &&
            f.at[1] >= 4 &&
            f.at[1] <= 17,
        );
        expect(
          inNave.map((f) => `${f.type}@${f.at.join(",")}`),
          `${name} seed ${seed}`,
        ).toEqual([]);
        if (pillars.length === 0) seen.plain++;
        else if (pillars.length === 4) seen.thirds++;
        else seen.piers++;
      }
    expect(seen.piers).toBeGreaterThan(0);
    expect(seen.thirds).toBeGreaterThan(0);
    expect(seen.plain).toBeGreaterThan(0);
  });

  it("a great hall's long tables stand in the side bays", () => {
    let tables = 0;
    for (const seed of SEEDS.slice(0, 6))
      tables += inHall(hallPlan("Great hall", 5, seed)).filter(
        (f) => f.type === "table" && (f.at[0] < 6 || f.at[0] > 10),
      ).length;
    expect(tables).toBeGreaterThanOrEqual(12);
  });

  it("without the switch (generator 4) the hall has no columns; a small hall keeps its ordinary layout", () => {
    expect(inHall(hallPlan("Great hall", 4, 1)).some((f) => f.type === "pillar")).toBe(false);
    for (const seed of SEEDS.slice(0, 6))
      expect(inHall(hallPlan("Great hall", 5, seed, 8, 10)).some((f) => f.type === "pillar")).toBe(false);
  });

  it("a hall the generator lays out is not faulted by hall_unbroken; a plain unpurposed hall is", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const p = hallPlan("Great hall", 5, seed);
      expect(reviewDesign(p, resolvePlan(p, pal), pal, { limit: 999 }).map((n) => n.code)).not.toContain(
        "hall_unbroken",
      );
    }
    const bare = hallPlan("Vast chamber", 5, 1);
    expect(reviewDesign(bare, resolvePlan(bare, pal), pal, { limit: 999 }).map((n) => n.code)).toContain(
      "hall_unbroken",
    );
  });
});
