/**
 * Rivers (generator 2): a water course enters on one board edge and leaves on another, winds, and keeps off the
 * border in between; still water (pond, lake, spring) keeps its drawn course.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { CELL_FLAG } from "../../../src/contracts/resolved";
import { resolvePlan } from "../../../src/resolve";
import { riverCourse } from "../../../src/resolve/water";

const W = 40;
const H = 30;
function meadow(terrain: TerrainOp[], generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "w",
    title: "W",
    kind: "outdoor",
    theme: "outdoor",
    seed: 5,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: W, h: H },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
      },
    ],
  };
}
const waterEdges = (p: MapPlan): Set<string> => {
  const l = resolvePlan(p).levels[0];
  const out = new Set<string>();
  if (!l) return out;
  for (let i = 0; i < W * H; i++) {
    if (((l.cells.flags[i] as number) & CELL_FLAG.WATER) === 0) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    if (x === 0) out.add("W");
    if (x === W - 1) out.add("E");
    if (y === 0) out.add("N");
    if (y === H - 1) out.add("S");
  }
  return out;
};

describe("rivers cross the map", () => {
  const brook = (id: string): TerrainOp => ({
    id,
    op: "path",
    points: [
      [10, 12],
      [20, 16],
      [28, 13],
    ],
    width: 2,
    material: "water_shallow",
  });
  it("a brook drawn inside the map is carried to two different board edges", () => {
    expect(waterEdges(meadow([brook("brook")])).size).toBeGreaterThanOrEqual(2);
  });
  it("a pond keeps its drawn course, and generator 1 is unchanged", () => {
    expect(waterEdges(meadow([brook("pond")])).size).toBe(0);
    expect(waterEdges(meadow([brook("brook")], 1)).size).toBe(0);
  });
  it("inner points keep off the border; a channel drawn along one edge leaves by another", () => {
    const box = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
    const along = riverCourse(
      [
        [0, 28],
        [20, 29],
        [39, 28],
      ],
      box,
      3,
    );
    for (const p of along.slice(1, -1)) expect(p[1]).toBeLessThanOrEqual(H - 1 - 6);
    const sameEdge = riverCourse(
      [
        [5, 0],
        [20, 10],
        [30, 0],
      ],
      box,
      2,
    );
    const last = sameEdge[sameEdge.length - 1] as [number, number];
    expect(last[1] === 0).toBe(false);
  });
});
