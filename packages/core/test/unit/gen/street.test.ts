/**
 * Built places follow order (city street, 2026-11-20): the street preset puts lamps in a regular row along each
 * kerb facing the road, bins between them, vehicles parked in the lane next to the kerb with varied gaps, and
 * nothing else in the carriageway; doors stay clear. The forest rules (no single file, no repeated gaps) are a
 * preset property, off here, still on for natural presets (lines.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { FEATURE_INFO, dressArea, type GeneratedPlacement, type PlacementGrid } from "../../../src/gen/index";

// 40 × 16: building fronts at the top and bottom (walls on the outer edge of rows 2 and 13), pavements rows 2–4
// and 11–13, a 6-wide road rows 5–10 (a path op). A door in the north frontage at x 12.
const W = 40;
const H = 16;
const ROAD = (y: number): boolean => y >= 5 && y <= 10;
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
const inStreet = (x: number, y: number): boolean => inB(x, y) && y >= 2 && y <= 13;

function street(): PlacementGrid {
  return {
    inBounds: inB,
    isFloor: inStreet,
    flags: (x, y) => (inStreet(x, y) && ROAD(y) ? 8 : 0),
    area: (x, y) => (inStreet(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, s: Side) => {
      if (y === 2 && s === "N") return x === 12 ? 2 : 1; // the north frontage, a door at x 12
      if (y === 13 && s === "S") return 1;
      return 0;
    },
    height: (_x, y) => (ROAD(y) ? 0 : 0.25),
  };
}

const cells: Array<[number, number]> = [];
for (let y = 2; y <= 13; y++) for (let x = 0; x < W; x++) cells.push([x, y]);

const dress = (seed: number): GeneratedPlacement[] =>
  dressArea(street(), {
    preset: "street",
    areaIndex: 1,
    areaCells: cells,
    density: 0.7,
    seed,
    remaining: 6000,
  }).placements;

describe("street preset", () => {
  it("lamps stand in a regular row along each kerb, at the kerb", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const ps = dress(seed);
      for (const kerbRow of [4, 11]) {
        const xs = ps
          .filter((p) => p.type === "lantern" && p.at[1] === kerbRow)
          .map((p) => p.at[0])
          .sort((a, b) => a - b);
        expect(xs.length, `seed ${String(seed)} row ${String(kerbRow)}`).toBeGreaterThanOrEqual(4);
        const gaps = xs.slice(1).map((x, i) => x - (xs[i] as number));
        // the rhythm: most gaps are the spacing; a lamp shifted off a door moves it by up to three
        const even = gaps.filter((g) => g === 7).length;
        expect(even, `seed ${String(seed)} gaps ${gaps.join(",")}`).toBeGreaterThanOrEqual(gaps.length - 2);
        for (const g of gaps) expect(Math.abs(g - 7)).toBeLessThanOrEqual(3);
      }
      // no lamp stands back from the kerb (a cell off the wall line)
      expect(ps.filter((p) => p.type === "lantern" && p.at[1] !== 4 && p.at[1] !== 11)).toEqual([]);
    }
  });

  it("only vehicles stand in the carriageway, in the lane next to the kerb", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const ps = dress(seed);
      for (const p of ps) {
        const cellsOf: Array<[number, number]> = [];
        for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
          for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) cellsOf.push([x, y]);
        const inRoad = cellsOf.filter(([, y]) => ROAD(y));
        if (p.type === "vehicle") {
          // parked in the lane against the kerb (one cell deep), three long along it: the lanes between stay open
          expect(cellsOf.every(([, y]) => y === 5 || y === 10)).toBe(true);
          expect(p.size[0]).toBeGreaterThan(p.size[1]);
        } else expect(inRoad, `${p.type} at ${p.at.join(",")}`).toEqual([]);
      }
      expect(ps.some((p) => p.type === "vehicle")).toBe(true);
    }
  });

  it("the door stays clear and blocking pieces keep off its approach", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const ps = dress(seed);
      const near = ps.filter(
        (p) =>
          FEATURE_INFO[p.type].blocking &&
          !FEATURE_INFO[p.type].wallMounted &&
          Math.abs(p.at[0] - 12) <= 1 &&
          p.at[1] <= 3,
      );
      expect(near.map((p) => p.type)).toEqual([]);
    }
  });
});

describe("street trees", () => {
  it("stand between the lamps at the kerb where the pavement is two or more cells deep", () => {
    let trees = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const ps = dress(seed);
      const t = ps.filter((p) => p.type === "cluster_tall");
      for (const p of t) expect([4, 11]).toContain(p.at[1]); // on the kerb line
      trees += t.length;
    }
    expect(trees).toBeGreaterThan(0);
  });
});
