/**
 * Generator 3 cliffs: no rock hangs in the air (every piece rests on the ground or on rock under most of its
 * footprint), and a natural region is never left without a band, even where no dress op asked for one.
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { cliffBand, defaultCliffBands, type PlacementGrid } from "../../../src/gen/index";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures";

const W = 44;
const H = 30;
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

/**
 * A raised plateau (rise 3) with a ragged lip, a low strip behind it, a ditch one tile lower along the south foot
 * and a void notch: the places where a rock centred on good ground can overhang air.
 */
function terrain(generator: number): { grid: PlacementGrid; cells: Array<[number, number]> } {
  const void_ = (x: number, y: number): boolean => x >= 30 && x < 34 && y >= 8 && y < 12;
  const height = (x: number, y: number): number => {
    if (y >= 2 && y <= 14 && x >= 6 && x <= 38) return 3;
    if (y >= 21 && y <= 22) return -1;
    return 0;
  };
  const grid: PlacementGrid = {
    inBounds: inB,
    isFloor: (x, y) => inB(x, y) && !void_(x, y),
    flags: () => 0,
    area: (x, y) => (inB(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, s: Side) => {
      const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
      const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
      return inB(nx, ny) && height(nx, ny) !== height(x, y) ? 3 : 0;
    },
    height,
    generator,
  };
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid.isFloor(x, y)) cells.push([x, y]);
  return { grid, cells };
}

interface Rock {
  at: readonly [number, number];
  size: readonly [number, number];
  base: number;
  ground: number;
}

/** The design review's measure (review/review.ts cliff_hanging): above the anchor ground with nothing under it. */
function hanging(rocks: Rock[]): Rock[] {
  return rocks.filter(
    (f) =>
      f.base > f.ground + 0.6 &&
      !rocks.some(
        (o) =>
          o !== f &&
          o.base < f.base - 0.1 &&
          o.at[0] < f.at[0] + f.size[0] &&
          f.at[0] < o.at[0] + o.size[0] &&
          o.at[1] < f.at[1] + f.size[1] &&
          f.at[1] < o.at[1] + o.size[1],
      ),
  );
}

describe("generator 3 rock band: nothing hangs", () => {
  it("every piece rests on the ground or on rock, over ragged ground with a void and a ditch", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { grid, cells } = terrain(3);
      const r = cliffBand(grid, { areaCells: cells, seed });
      expect(r.placements.length).toBeGreaterThan(20);
      const rocks = r.placements.map((q) => {
        const ground = grid.height?.(q.at[0], q.at[1]) ?? 0;
        return { at: q.at, size: q.size, base: ground + q.lift, ground };
      });
      expect(hanging(rocks), `seed ${String(seed)}`).toEqual([]);
      // and most of every footprint is held: no more than a third stands over cells below the base or void
      for (const q of r.placements) {
        const ground = grid.height?.(q.at[0], q.at[1]) ?? 0;
        const base = ground + q.lift;
        let air = 0;
        let n = 0;
        for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
          for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) {
            n++;
            const held =
              grid.isFloor(x, y) && (grid.height?.(x, y) ?? 0) >= base - 0.5
                ? true
                : r.placements.some(
                    (o) =>
                      o !== q &&
                      x >= o.at[0] &&
                      x < o.at[0] + o.size[0] &&
                      y >= o.at[1] &&
                      y < o.at[1] + o.size[1] &&
                      (grid.height?.(o.at[0], o.at[1]) ?? 0) + o.lift <= base - 0.1,
                  );
            if (!held) air++;
          }
        expect(air / n, `seed ${String(seed)} piece ${q.at.join(",")}`).toBeLessThanOrEqual(0.35);
      }
    }
  }, 30_000); // twelve full cliff bands: 3 to 4 s under a parallel run; the Windows CI runner timed out at 5 s (0.2.0)

  it("generator 2 is untouched: the same grid without the version gives the old pieces", () => {
    const a = terrain(2);
    const b = { ...terrain(2).grid };
    delete (b as { generator?: number }).generator;
    const r2 = cliffBand(a.grid, { areaCells: a.cells, seed: 5 });
    const r0 = cliffBand(b, { areaCells: a.cells, seed: 5 });
    expect(r2.placements).toEqual(r0.placements);
  });
});

describe("generator 3 sub-cell offsets", () => {
  it("band pieces slide off the cell centres and stay held; generator 2 carries none", () => {
    const g3 = terrain(3);
    const r = cliffBand(g3.grid, { areaCells: g3.cells, seed: 7 });
    const off = r.placements.filter((q) => q.offset !== undefined);
    expect(off.length).toBe(r.placements.length);
    const moved = off.filter((q) => (q.offset?.[0] ?? 0) !== 0 || (q.offset?.[1] ?? 0) !== 0);
    expect(moved.length / off.length).toBeGreaterThan(0.9);
    for (const q of off) {
      expect(Math.abs(q.offset?.[0] ?? 0)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(q.offset?.[1] ?? 0)).toBeLessThanOrEqual(0.5);
    }
    // the offsets vary (no new grid): many distinct values
    expect(new Set(off.map((q) => (q.offset ?? []).join(","))).size).toBeGreaterThan(off.length / 2);
    const g2 = terrain(2);
    const r2 = cliffBand(g2.grid, { areaCells: g2.cells, seed: 7 });
    expect(r2.placements.some((q) => q.offset !== undefined)).toBe(false);
  });
});

describe("generator 3 default cliff bands", () => {
  it("a region with no dress op still gets its band; generator 2 gets none", () => {
    const g3 = terrain(3);
    const r3 = defaultCliffBands(g3.grid, { areaIndex: 1, areaCells: g3.cells, seed: 4, remaining: 4000 });
    expect(r3.placements.filter((q) => q.type === "cliff_face").length).toBeGreaterThan(5);
    expect(r3.placements.filter((q) => q.type === "cliff_crest").length).toBeGreaterThan(5);
    // only the band and the growth that follows the rock
    const allowed = new Set([
      "cliff_face",
      "cliff_crest",
      "root",
      "undergrowth",
      "cluster_tall",
      "dead_tree",
      "ground_cover",
    ]);
    expect(r3.placements.every((q) => allowed.has(q.type))).toBe(true);
    const g2 = terrain(2);
    expect(
      defaultCliffBands(g2.grid, { areaIndex: 1, areaCells: g2.cells, seed: 4, remaining: 4000 }).placements,
    ).toEqual([]);
  });

  it("a theme without the formation roles gets no band", () => {
    const g3 = terrain(3);
    const none: PlacementGrid = { ...g3.grid, pieceSize: () => undefined };
    const r = defaultCliffBands(none, { areaIndex: 1, areaCells: g3.cells, seed: 4, remaining: 4000 });
    expect(r.placements.filter((q) => q.type === "cliff_face" || q.type === "cliff_crest")).toEqual([]);
  });
});

describe("terraced hill at generator 3 (resolved plan)", () => {
  it("no hanging rock, and under 10% of the cliff edge bare", () => {
    const plan = loadPlan("terraced-hill");
    expect(plan.generator).toBe(3);
    {
      const resolved = resolvePlan(plan, bundledPalettes());
      const L = resolved.levels[0];
      expect(L).toBeDefined();
      if (!L) return;
      const rocks = L.features.filter((f) => f.type === "cliff_face" || f.type === "cliff_crest");
      expect(rocks.length).toBeGreaterThan(30);
      const flat = rocks.map((f) => {
        const i = (f.at[1] - L.bounds.y) * L.bounds.w + (f.at[0] - L.bounds.x);
        return {
          at: f.at,
          size: f.size,
          base: f.baseHeight,
          ground: L.elevation + 0.5 + (L.cells.height[i] ?? 0) / 4,
        };
      });
      expect(hanging(flat)).toEqual([]);
      const step: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
      let high = 0;
      let bare = 0;
      for (const run of L.cliffs ?? [])
        for (const e of run.edges) {
          if ((e.high - e.low) / 4 < 2) continue;
          const [dx, dy] = step[e.side] as [number, number];
          const mx = e.at[0] + 0.5 + dx * 0.5;
          const my = e.at[1] + 0.5 + dy * 0.5;
          high++;
          if (
            !rocks.some(
              (f) =>
                mx >= f.at[0] - 0.3 &&
                mx <= f.at[0] + f.size[0] + 0.3 &&
                my >= f.at[1] - 0.3 &&
                my <= f.at[1] + f.size[1] + 0.3,
            )
          )
            bare++;
        }
      expect(high).toBeGreaterThan(80);
      expect(bare / high).toBeLessThan(0.1);
    }
  });
});
