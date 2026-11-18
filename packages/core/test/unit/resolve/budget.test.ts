/**
 * Resolve-time budgets for legal-but-large plans (review items 1, 4, 5, 6). Each case was seconds before the fix;
 * bounds are generous (best of three) so they only catch algorithmic regressions, not a busy machine.
 */
import { describe, expect, it } from "vitest";
import type { Area, Level, MapPlan, Opening, TerrainOp } from "../../../src/contracts/plan";
import { resolvePlan } from "../../../src/resolve/index";

function plan(level: Partial<Level>): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "budget",
    title: "budget",
    kind: "dungeon",
    seed: 1,
    theme: "stone_dungeon",
    links: [],
    levels: [
      {
        id: "l",
        name: "l",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 160, h: 160 },
        base: { type: "solid" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        ...level,
      },
    ],
  };
}

function bestOf3(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const room = (id: string, x: number, y: number, w: number, h: number): Area => ({
  id,
  kind: "room",
  key: id,
  shape: { type: "rect", x, y, w, h },
});

describe("resolve budgets", () => {
  it("dresses a 158×158 storeroom at density 1 in well under 1 s (was ~29 s)", () => {
    const terrain: TerrainOp[] = [{ id: "d", op: "dress", area: "a", preset: "storeroom", density: 1 }];
    const p = plan({ areas: [room("a", 1, 1, 158, 158)], terrain });
    expect(resolvePlan(p).levels[0]?.features.length).toBeGreaterThan(3000);
    expect(bestOf3(() => resolvePlan(p))).toBeLessThan(1000);
  });

  it("scatters with minSpacing 32 on 160×160 quickly (was ~1.8 s)", () => {
    const terrain: TerrainOp[] = [{ id: "s", op: "scatter", feature: "rock", density: 1, minSpacing: 32 }];
    const p = plan({ base: { type: "ground", material: "grass" }, terrain });
    const feats = resolvePlan(p).levels[0]?.features ?? [];
    for (const a of feats)
      for (const b of feats)
        if (a !== b)
          expect(Math.max(Math.abs(a.at[0] - b.at[0]), Math.abs(a.at[1] - b.at[1]))).toBeGreaterThanOrEqual(
            32,
          );
    expect(bestOf3(() => resolvePlan(p))).toBeLessThan(500);
  });

  it("explains five impossible doors between two huge rooms quickly (was ~3.7 s)", () => {
    const openings: Opening[] = Array.from({ length: 5 }, (_, k) => ({
      id: `o${k}`,
      kind: "door",
      between: ["a", "b"],
    }));
    const p = plan({ areas: [room("a", 0, 0, 79, 160), room("b", 81, 0, 79, 160)], openings });
    const r = resolvePlan(p);
    expect(r.issues.filter((i) => i.code === "opening_no_boundary")[0]?.hint).toMatch(
      /2 cells apart|1 cells apart/,
    );
    expect(bestOf3(() => resolvePlan(p))).toBeLessThan(500);
  });

  it("rasterises a polygon with corners at ±4096 only inside the level (was tens of seconds)", () => {
    const n = 4096;
    const p = plan({
      bounds: { x: 0, y: 0, w: 40, h: 40 },
      areas: [
        {
          id: "a",
          kind: "room",
          key: "1",
          shape: {
            type: "polygon",
            points: [
              [-n, -n],
              [n, -n],
              [n, n],
              [-n, n],
            ],
          },
        },
      ],
    });
    const r = resolvePlan(p);
    expect(r.levels[0]?.areas[0]?.cellCount).toBe(1600);
    expect(r.issues.map((i) => i.code)).toEqual(["bounds_exceeded"]);
    expect(bestOf3(() => resolvePlan(p))).toBeLessThan(200);
  });

  it("huge circles, blobs and paths are clipped too", () => {
    const p = plan({
      bounds: { x: 0, y: 0, w: 40, h: 40 },
      base: { type: "ground", material: "grass" },
      terrain: [
        { id: "c", op: "paint", shape: { type: "circle", cx: 20, cy: 20, r: 4000 }, material: "dirt" },
        { id: "b", op: "paint", shape: { type: "blob", cx: 20, cy: 20, r: 4000 }, material: "mud" },
        {
          id: "pa",
          op: "path",
          points: [
            [-4000, 5],
            [4000, 5],
          ],
          width: 3,
          material: "gravel",
        },
      ],
    });
    expect(bestOf3(() => resolvePlan(p))).toBeLessThan(500);
  });
});
