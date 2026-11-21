/**
 * Legal-but-large plans resolve (each case once took seconds to tens of seconds: an algorithmic blow-up). The guard is
 * the test's timeout, which such a blow-up runs far past; there is no elapsed-time assertion, which would measure the
 * machine rather than the code.
 */
import { describe, expect, it } from "vitest";
import type { Area, Level, MapPlan, Opening, TerrainOp } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
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

const room = (id: string, x: number, y: number, w: number, h: number): Area => ({
  id,
  kind: "room",
  key: id,
  shape: { type: "rect", x, y, w, h },
});

describe("large plans resolve", () => {
  it("dresses a 158×158 storeroom at density 1", () => {
    const terrain: TerrainOp[] = [{ id: "d", op: "dress", area: "a", preset: "storeroom", density: 1 }];
    const p = plan({ areas: [room("a", 1, 1, 158, 158)], terrain });
    expect(resolvePlan(p, bundledPalettes()).levels[0]?.features.length).toBeGreaterThan(3000);
  });

  it("scatters with minSpacing 32 on 160×160", () => {
    const terrain: TerrainOp[] = [{ id: "s", op: "scatter", feature: "rock", density: 1, minSpacing: 32 }];
    const p = plan({ base: { type: "ground", material: "grass" }, terrain });
    const feats = resolvePlan(p, bundledPalettes()).levels[0]?.features ?? [];
    for (const a of feats)
      for (const b of feats)
        if (a !== b)
          expect(Math.max(Math.abs(a.at[0] - b.at[0]), Math.abs(a.at[1] - b.at[1]))).toBeGreaterThanOrEqual(
            32,
          );
  });

  it("explains five impossible doors between two huge rooms", () => {
    const openings: Opening[] = Array.from({ length: 5 }, (_, k) => ({
      id: `o${k}`,
      kind: "door",
      between: ["a", "b"],
    }));
    const p = plan({ areas: [room("a", 0, 0, 79, 160), room("b", 81, 0, 79, 160)], openings });
    const r = resolvePlan(p, bundledPalettes());
    expect(r.issues.filter((i) => i.code === "opening_no_boundary")[0]?.hint).toMatch(
      /2 cells apart|1 cells apart/,
    );
  });

  it("rasterises a polygon with corners at ±4096 only inside the level", () => {
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
    const r = resolvePlan(p, bundledPalettes());
    expect(r.levels[0]?.areas[0]?.cellCount).toBe(1600);
    expect(r.issues.map((i) => i.code)).toEqual(["bounds_exceeded"]);
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
    const L = resolvePlan(p, bundledPalettes()).levels[0];
    expect(L?.cells.state).toHaveLength(1600);
  });
});
