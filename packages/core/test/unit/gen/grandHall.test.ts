/**
 * The grand hall (generator 5, switch grandHalls; techniques int-grand-hall, pier-grid-hall, pillars-at-thirds): a big
 * great hall, throne room or nave is laid out as one, from the room-kind table's hall plan (gen/roomTraits.ts): its
 * axis clear end to end, its columns mirrored about it at the third points across (piers, thirds or none, drawn per
 * room), its tables or benches in the side bays. A small one keeps its kind's ordinary layout.
 * Each hall is resolved once (HALLS, a cache the tests share), so a test pays only for what it alone asks.
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan } from "../../../src/contracts/plan";
import type { ResolvedFeature, ResolvedPlan } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { HALL_SIZE, hallPlanOf } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
/** Twelve seeds a kind: across the three kinds every column option is drawn (36 halls). */
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const KINDS = ["Great hall", "Throne room", "Temple nave"] as const;

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

/** Every hall the tests ask for, resolved once. */
const HALLS = new Map<string, { plan: MapPlan; resolved: ResolvedPlan }>();
function hall(
  name: string,
  generator: 4 | 5,
  seed: number,
  w = 13,
  h = 20,
): { plan: MapPlan; resolved: ResolvedPlan } {
  const key = `${name}|${generator}|${seed}|${w}|${h}`;
  let got = HALLS.get(key);
  if (got === undefined) {
    const plan = hallPlan(name, generator, seed, w, h);
    got = { plan, resolved: resolvePlan(plan, pal) };
    HALLS.set(key, got);
  }
  return got;
}
const inHall = (name: string, generator: 4 | 5, seed: number, w?: number, h?: number): ResolvedFeature[] =>
  (hall(name, generator, seed, w, h).resolved.levels[0]?.features ?? []).filter((f) => f.area === "hall");

/** The column option a hall drew, read from its pillars. */
const optionOf = (fs: readonly ResolvedFeature[]): "piers" | "thirds" | "plain" => {
  const n = fs.filter((f) => f.type === "pillar").length;
  return n === 0 ? "plain" : n === 4 ? "thirds" : "piers";
};

describe("grand hall (grandHalls)", () => {
  it("the kind table says which rooms are halls: big great halls, throne rooms and naves, not small ones", () => {
    expect(hallPlanOf("dining", 260, 13)).toBeDefined();
    expect(hallPlanOf("throne_room", 260, 13)).toBeDefined();
    expect(hallPlanOf("shrine", 260, 13)).toBeDefined();
    expect(hallPlanOf("dining", HALL_SIZE.minCells - 1, 13)).toBeUndefined();
    expect(hallPlanOf("dining", 260, HALL_SIZE.minWidth - 1)).toBeUndefined();
    expect(hallPlanOf("kitchen", 260, 13)).toBeUndefined();
  });

  for (const name of KINDS)
    it(`${name}: the axis stays clear and the columns stand mirrored at the third points`, () => {
      for (const seed of SEEDS) {
        const fs = inHall(name, 5, seed);
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
      }
    }, 30_000); // 12 halls resolved: about 1.2 s alone, 2 to 3 s under a parallel run, near the 5 s default on Windows CI

  it("the column options vary: piers, thirds and plain are all drawn", () => {
    const seen = new Set(KINDS.flatMap((name) => SEEDS.map((seed) => optionOf(inHall(name, 5, seed)))));
    expect([...seen].sort()).toEqual(["piers", "plain", "thirds"]);
  }, 30_000); // reads the halls above from the cache; resolves them itself only when run alone

  it("a great hall's long tables stand in the side bays", () => {
    let tables = 0;
    for (const seed of SEEDS.slice(0, 6))
      tables += inHall("Great hall", 5, seed).filter(
        (f) => f.type === "table" && (f.at[0] < 6 || f.at[0] > 10),
      ).length;
    expect(tables).toBeGreaterThanOrEqual(12);
  });

  it("without the switch (generator 4) the hall has no columns; a small hall keeps its ordinary layout", () => {
    expect(inHall("Great hall", 4, 1).some((f) => f.type === "pillar")).toBe(false);
    for (const seed of SEEDS.slice(0, 4))
      expect(inHall("Great hall", 5, seed, 8, 10).some((f) => f.type === "pillar")).toBe(false);
  });

  it("a hall the generator lays out is not faulted by hall_unbroken; a plain unpurposed hall is", () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const { plan, resolved } = hall("Great hall", 5, seed);
      expect(reviewDesign(plan, resolved, pal, { limit: 999 }).map((n) => n.code)).not.toContain(
        "hall_unbroken",
      );
    }
    const bare = hall("Vast chamber", 5, 1);
    expect(reviewDesign(bare.plan, bare.resolved, pal, { limit: 999 }).map((n) => n.code)).toContain(
      "hall_unbroken",
    );
  });
});
