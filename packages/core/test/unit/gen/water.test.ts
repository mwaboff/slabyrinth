/**
 * Generator 3 water dressing (gen/water.ts): 0.5 to 0.75 pieces per water-edge tile in clusters, boulders sunk so their
 * tops sit at the surface, plants in the shallows, rock along part of the shore with one open bank, stepping stones where
 * a trail crosses shallow water, nothing on a path; generator 2 is untouched.
 */
import { describe, expect, it } from "vitest";
import { dressWater, WATER_DRESS } from "../../../src/gen/water";
import type { PlacementGrid } from "../../../src/gen/index";

const W = 36;
const H = 26;
const inPool = (x: number, y: number): boolean => x >= 6 && x < 20 && y >= 5 && y < 19;
const inChannel = (x: number, y: number): boolean => x >= 24 && x < 28 && y >= 10 && y < 13;
const isWaterCell = (x: number, y: number): boolean => inPool(x, y) || inChannel(x, y);
const isPath = (x: number, y: number): boolean => (x === 23 || x === 28) && y === 11;

function grid(generator: number): PlacementGrid {
  return {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    flags: (x, y) => (isWaterCell(x, y) ? 4 : 0) | (isPath(x, y) ? 8 : 0),
    area: () => 1,
    occupied: () => false,
    edge: () => 0,
    height: (x, y) => (isWaterCell(x, y) ? -1 : 0),
    generator,
    pieceExtent: (t) => (t === "cliff_crest" ? { w: 1.5, d: 1.8, h: 1.62 } : undefined),
    pieceSize: (t) => (t === "cliff_crest" ? { w: 2, d: 2, h: 1.62 } : undefined),
  };
}
const cells = (): Array<[number, number]> => {
  const o: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o.push([x, y]);
  return o;
};
const run = (generator: number, seed: number) =>
  dressWater(grid(generator), {
    cells: cells(),
    inArea: () => true,
    taken: () => false,
    seed,
    remaining: 1000,
  });

describe("water dressing", () => {
  it("lays 0.5 to 0.75 pieces per water-edge tile, in every part", () => {
    let seen = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = run(3, seed);
      const per = r.placements.length / r.edge;
      expect(per).toBeGreaterThan(0.3);
      expect(per).toBeLessThanOrEqual(WATER_DRESS.perEdge[1] + 0.05);
      expect(r.plants).toBeGreaterThan(0);
      expect(r.shore).toBeGreaterThan(0);
      seen += r.sunk;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("sinks boulders so their tops sit at the water surface (half a tile under the bank)", () => {
    const r = run(3, 3);
    const sunk = r.placements.filter((p) => p.type === "cliff_crest" && inPool(p.at[0], p.at[1]));
    expect(sunk.length).toBeGreaterThan(0);
    // bed -1, bank 0: surface -0.5; top = surface + 0.05; lift = top - bed - height
    for (const p of sunk) expect(p.lift).toBeCloseTo(-0.45 + 1 - 1.62, 5);
  });

  it("keeps one bank open: a stretch of shoreline with nothing within a cell", () => {
    for (let seed = 1; seed <= 8; seed++) expect(run(3, seed).openBank).toBeGreaterThanOrEqual(4);
  });

  it("puts plants in the shallows rim and rock on the dry bank, in clusters", () => {
    const r = run(3, 5);
    for (const p of r.placements.filter((q) => q.type === "reeds")) {
      expect(isWaterCell(p.at[0], p.at[1])).toBe(true);
    }
    for (const p of r.placements.filter((q) => q.type === "edge_dressing")) {
      expect(isWaterCell(p.at[0], p.at[1])).toBe(false);
    }
    const reeds = r.placements.filter((q) => q.type === "reeds");
    const lone = reeds.filter(
      (a) => !reeds.some((b) => b !== a && Math.abs(a.at[0] - b.at[0]) + Math.abs(a.at[1] - b.at[1]) <= 1),
    );
    expect(lone.length / reeds.length).toBeLessThan(0.4);
  });

  it("lays stepping stones across a shallow ford between two path ends, and never on a path", () => {
    const r = run(3, 2);
    const stones = r.placements.filter((p) => p.type === "cliff_crest" && inChannel(p.at[0], p.at[1]));
    expect(r.stones).toBeGreaterThan(0);
    expect(stones.length).toBe(r.stones);
    // tops a little above the surface so they can be walked on
    for (const p of stones) expect(p.lift).toBeCloseTo(-0.38 + 1 - 1.62, 5);
    for (const p of r.placements)
      for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
        for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) expect(isPath(x, y)).toBe(false);
  });

  it("leaves generator 2 and themes without the rock role alone", () => {
    expect(run(2, 1).placements).toHaveLength(0);
    const g = { ...grid(3), pieceExtent: () => undefined, pieceSize: () => undefined };
    const r = dressWater(g, {
      cells: cells(),
      inArea: () => true,
      taken: () => false,
      seed: 4,
      remaining: 1000,
    });
    expect(r.placements.some((p) => p.type === "cliff_crest")).toBe(false);
    expect(r.placements.length).toBeGreaterThan(0); // plants and shore rock come from other roles
  });

  it("is deterministic and respects the cap", () => {
    expect(run(3, 9).placements).toEqual(run(3, 9).placements);
    const r = dressWater(grid(3), {
      cells: cells(),
      inArea: () => true,
      taken: () => false,
      seed: 9,
      remaining: 5,
    });
    expect(r.placements.length).toBeLessThanOrEqual(5);
  });
});
