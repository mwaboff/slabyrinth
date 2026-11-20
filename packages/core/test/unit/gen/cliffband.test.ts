/**
 * Cliffs as rock bands (docs/internal/cliffs-lessons-reference.md): coverage, overlap, no regular cadence, every
 * piece supported, a crest over the lip, stacked courses lifted by a face height, crest-only low rises, and a theme
 * without the formation roles realizing nothing (its cliff keeps the built face).
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { cliffBand, type PlacementGrid } from "../../../src/gen/index";
import { loadPalettes, resolveRole } from "../../../src/palette";

const W = 40;
const H = 24;
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
/** A terrace: rows 0–11 at `rise`, rows 12–23 at 0, the edge wandering by a cell. */
function terrace(rise: number): { grid: PlacementGrid; cells: Array<[number, number]> } {
  const top = (x: number): number => 11 + (Math.floor(x / 7) % 2);
  const height = (x: number, y: number): number => (y <= top(x) ? rise : 0);
  const grid: PlacementGrid = {
    inBounds: inB,
    isFloor: inB,
    flags: () => 0,
    area: (x, y) => (inB(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, s: Side) => {
      const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
      const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
      return inB(nx, ny) && height(nx, ny) !== height(x, y) ? 3 : 0;
    },
    height,
  };
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells.push([x, y]);
  return { grid, cells };
}

/** A piece's centre cell (pieces are odd boxes centred on it) and its base (absolute tiles). */
const centre = (q: { at: [number, number]; size: [number, number] }): [number, number] => [
  q.at[0] + Math.floor(q.size[0] / 2),
  q.at[1] + Math.floor(q.size[1] / 2),
];
const boxCells = (q: { at: [number, number]; size: [number, number] }): Array<[number, number]> => {
  const cs: Array<[number, number]> = [];
  for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
    for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) cs.push([x, y]);
  return cs;
};

describe("cliff rock band", () => {
  for (const rise of [2.5, 4])
    it(`rise ${String(rise)}: clad, overlapping, irregular, supported, crested`, () => {
      const { grid, cells } = terrace(rise);
      for (let seed = 1; seed <= 6; seed++) {
        const r = cliffBand(grid, { areaCells: cells, seed });
        expect(r.units).toBeGreaterThan(30);
        expect(r.clad / r.units, `seed ${String(seed)} coverage`).toBeGreaterThanOrEqual(0.9);

        const faces = r.placements.filter((q) => q.type === "cliff_face");
        const crests = r.placements.filter((q) => q.type === "cliff_crest");
        expect(faces.length).toBeGreaterThan(0);
        expect(crests.length).toBeGreaterThan(0);
        // about two face rocks to one crest boulder (a loose bound)
        expect(faces.length / Math.max(1, crests.length)).toBeGreaterThan(0.6);

        // overlap of the base course along the run: centres at most 3 cells apart (a 4.6-long rock overlaps its
        // neighbour by a third or more)
        const baseOf = (z: (typeof faces)[number]): number => (grid.height?.(z.at[0], z.at[1]) ?? 0) + z.lift;
        const base = faces.filter((q) => baseOf(q) <= 0.25).sort((a, b) => centre(a)[0] - centre(b)[0]);
        const steps = base.slice(1).map((q, i) => {
          const prev = base[i] as typeof q;
          return {
            gap: centre(q)[0] - centre(prev)[0],
            out: centre(q)[1] - centre(prev)[1],
            turn: q.rotFine,
          };
        });
        for (const s of steps) expect(s.gap, `seed ${String(seed)} base-course gap`).toBeLessThanOrEqual(3);
        // no regular cadence: no spacing makes up more than three quarters of the run, and no one step (spacing,
        // offset from the edge and turn together) more than a third of it
        const share = (k: (s: (typeof steps)[number]) => string): number => {
          const counts = new Map<string, number>();
          for (const s of steps) counts.set(k(s), (counts.get(k(s)) ?? 0) + 1);
          return Math.max(...counts.values()) / steps.length;
        };
        expect(
          share((s) => String(s.gap)),
          `seed ${String(seed)} spacing`,
        ).toBeLessThanOrEqual(0.75);
        expect(
          share((s) => `${String(s.gap)}|${String(s.out)}|${String(s.turn)}`),
          `seed ${String(seed)} cadence`,
        ).toBeLessThanOrEqual(1 / 3);

        // rotations: free 15° steps, at least three different turns
        expect(new Set(r.placements.map((q) => q.rotFine)).size).toBeGreaterThanOrEqual(3);

        // supported: a piece above the ground under its centre stands on a lower piece within two cells
        const groundAt = (z: (typeof faces)[number]): number => grid.height?.(...centre(z)) ?? 0;
        for (const q of r.placements.filter((z) => baseOf(z) > groundAt(z) + 0.01)) {
          const under = r.placements.some(
            (o) =>
              o !== q &&
              Math.max(Math.abs(centre(o)[0] - centre(q)[0]), Math.abs(centre(o)[1] - centre(q)[1])) <= 2 &&
              baseOf(o) < baseOf(q),
          );
          expect(under, `seed ${String(seed)} piece at ${q.at.join(",")} lift ${String(q.lift)}`).toBe(true);
        }

        // courses: a rise of 4 needs a second course lifted about one face height
        if (rise >= 4) expect(faces.some((q) => baseOf(q) >= 1.8)).toBe(true);
        // nothing sunk: every piece's base is at or above the ground under its centre
        for (const q of r.placements) expect(baseOf(q)).toBeGreaterThanOrEqual(groundAt(q) - 0.01);

        // crest over at least 80 % of the clad edge: a crest boulder within a cell of the upper cell
        let crested = 0;
        for (const u of r.rises) {
          const ux = u.low[0] + (u.side === "E" ? 1 : u.side === "W" ? -1 : 0);
          const uy = u.low[1] + (u.side === "S" ? 1 : u.side === "N" ? -1 : 0);
          if (crests.some((c) => Math.max(Math.abs(centre(c)[0] - ux), Math.abs(centre(c)[1] - uy)) <= 1))
            crested++;
        }
        expect(crested / r.rises.length, `seed ${String(seed)} crest`).toBeGreaterThanOrEqual(0.8);
      }
    });

  it("a rise of 1 to 1.5 gets crest boulders only, on part of the edge", () => {
    const { grid, cells } = terrace(1);
    const r = cliffBand(grid, { areaCells: cells, seed: 3 });
    expect(r.placements.some((q) => q.type === "cliff_face")).toBe(false);
    expect(r.placements.filter((q) => q.type === "cliff_crest").length).toBeGreaterThan(3);
  });

  it("routes keep their gap: no piece on a path cell", () => {
    const { grid, cells } = terrace(3);
    const withPath: PlacementGrid = { ...grid, flags: (x) => (x === 20 || x === 21 ? 8 : 0) };
    const r = cliffBand(withPath, { areaCells: cells, seed: 2 });
    expect(r.placements.some((q) => boxCells(q).some(([x]) => x === 20 || x === 21))).toBe(false);
  });

  it("a theme without the formation roles gets no band (its cliff keeps the built face)", () => {
    const { grid, cells } = terrace(3);
    const r = cliffBand({ ...grid, pieceSize: () => undefined }, { areaCells: cells, seed: 1 });
    expect(r.placements).toEqual([]);
    expect(r.rises.length).toBeGreaterThan(30);
  });

  it("a rock ramp keeps clear: no piece covers its cells", () => {
    const { grid, cells } = terrace(3);
    const ramp = (x: number, y: number): boolean => x >= 18 && x <= 21 && y >= 10;
    const r = cliffBand({ ...grid, ramp }, { areaCells: cells, seed: 4 });
    expect(r.placements.some((q) => boxCells(q).some(([x, y]) => ramp(x, y)))).toBe(false);
    expect(r.placements.length).toBeGreaterThan(10);
  });

  it("themes with natural rock fill the roles; a city or a dungeon realizes nothing and keeps its built face", () => {
    const cat = loadPalettes();
    for (const t of ["cave", "outdoor", "forest", "wood_town"]) {
      expect(resolveRole(cat, t, "feature.cliff_face").resolution, t).not.toBeNull();
      expect(resolveRole(cat, t, "feature.cliff_crest").resolution, t).not.toBeNull();
    }
    for (const t of ["city", "stone_dungeon"]) {
      expect(resolveRole(cat, t, "feature.cliff_face").resolution, t).toBeNull();
      expect(resolveRole(cat, t, "feature.cliff_crest").resolution, t).toBeNull();
    }
  });
});
