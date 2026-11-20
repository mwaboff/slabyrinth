/**
 * Round 5 (owner's v5 glade, 2026-11-20): a dead-straight, evenly spaced row of cypresses ran the whole width of
 * the map on the two-cell strip between the brook and the board edge. Every line-following situation — a cliff
 * lip and foot, a bank, a path verge, a narrow strip — is run through every composed preset over many seeds, and
 * the upright pieces (trees, rock masses, stones) along it must not form a fence:
 *  - no single-file run of more than three (four or more in a row, each within three cells of the next, with
 *    fewer than half as many beside them);
 *  - no run with more than two equal spacings (of two cells or more: touching pieces are a clump).
 * Which asset fills each piece is decided in realize; the variant mix along a run is tested there
 * (test/unit/compile/lineVariants.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import {
  COMPOSED_PRESETS,
  RUNNERS,
  dressArea,
  type GeneratedPlacement,
  type PlacementGrid,
} from "../../../src/gen/index";

interface Scene {
  name: string;
  w: number;
  h: number;
  height: (x: number, y: number) => number;
  flags: (x: number, y: number) => number;
}

const SCENES: Scene[] = [
  // dry ground, a brook three cells wide, then a strip of two rows against the board edge (the glade's south bank)
  { name: "brook strip", w: 40, h: 8, height: () => 0, flags: (_x, y) => (y >= 3 && y <= 5 ? 4 : 0) },
  // a cliff one tile high across the middle: a lip above, a foot below
  { name: "cliff", w: 40, h: 14, height: (_x, y) => (y < 6 ? 1 : 0), flags: () => 0 },
  // a dirt path two cells wide across the middle
  { name: "path", w: 40, h: 12, height: () => 0, flags: (_x, y) => (y === 6 || y === 7 ? 8 : 0) },
  // a long narrow strip of ground two cells wide (a ledge path, a shore)
  { name: "narrow strip", w: 40, h: 2, height: () => 0, flags: () => 0 },
];

function grid(s: Scene): PlacementGrid {
  const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < s.w && y < s.h;
  return {
    inBounds: inB,
    isFloor: inB,
    flags: (x, y) => (inB(x, y) ? s.flags(x, y) : 0),
    area: (x, y) => (inB(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, sd: Side) => {
      const nx = x + (sd === "E" ? 1 : sd === "W" ? -1 : 0);
      const ny = y + (sd === "S" ? 1 : sd === "N" ? -1 : 0);
      return inB(nx, ny) && s.height(nx, ny) !== s.height(x, y) ? 3 : 0;
    },
    height: s.height,
  };
}

/** Faults in the upright pieces of one dressing, as readable strings (empty = fine). */
function lineFaults(ps: GeneratedPlacement[]): string[] {
  const cells = new Set<string>();
  for (const p of ps) {
    if (!RUNNERS.has(p.type)) continue;
    for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
      for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) cells.add(`${String(x)},${String(y)}`);
  }
  const has = (x: number, y: number): boolean => cells.has(`${String(x)},${String(y)}`);
  const out: string[] = [];
  for (const horiz of [true, false]) {
    const lines = new Map<number, number[]>();
    for (const c of cells) {
      const [x, y] = c.split(",").map(Number) as [number, number];
      const [line, u] = horiz ? [y, x] : [x, y];
      lines.set(line, [...(lines.get(line) ?? []), u]);
    }
    for (const [line, us] of lines) {
      us.sort((a, b) => a - b);
      // runs: consecutive pieces within maxGap cells of each other
      const runs = (maxGap: number): number[][] => {
        const rs: number[][] = [];
        for (const u of us) {
          const r = rs[rs.length - 1];
          if (r && u - (r[r.length - 1] as number) <= maxGap) r.push(u);
          else rs.push([u]);
        }
        return rs;
      };
      const at = (u: number, d: number): boolean => (horiz ? has(u, line + d) : has(line + d, u));
      const besideOf = (r: number[]): number => {
        let n = 0;
        for (let u = r[0] as number; u <= (r[r.length - 1] as number); u++) if (at(u, -1) || at(u, 1)) n++;
        return n;
      };
      const where = (r: number[]): string =>
        `${horiz ? "row" : "column"} ${String(line)} at ${String(r[0])}..${String(r[r.length - 1])}`;
      for (const r of runs(3))
        if (r.length >= 4 && besideOf(r) * 2 < r.length)
          out.push(`single file of ${String(r.length)}: ${where(r)}`);
      for (const r of runs(6)) {
        if (r.length < 4 || besideOf(r) * 2 >= r.length) continue;
        const gaps = new Map<number, number>();
        for (let i = 1; i < r.length; i++) {
          const d = (r[i] as number) - (r[i - 1] as number);
          // touching pieces are a clump, not a spacing
          if (d < 2) continue;
          gaps.set(d, (gaps.get(d) ?? 0) + 1);
        }
        for (const [d, n] of gaps)
          if (n > 2) out.push(`${String(n)} equal spacings of ${String(d)}: ${where(r)}`);
      }
    }
  }
  return out;
}

describe("line-following dressing never makes a fence", () => {
  for (const scene of SCENES)
    for (const preset of COMPOSED_PRESETS)
      it(`${scene.name}: ${preset}`, () => {
        const g = grid(scene);
        const cells: Array<[number, number]> = [];
        for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) cells.push([x, y]);
        const faults: string[] = [];
        for (let seed = 1; seed <= 25; seed++) {
          const ps = dressArea(g, {
            preset,
            areaIndex: 1,
            areaCells: cells,
            density: 1,
            seed,
            remaining: 6000,
          }).placements;
          for (const f of lineFaults(ps)) faults.push(`seed ${String(seed)}: ${f}`);
        }
        expect(faults).toEqual([]);
      });
});

describe("cliff lips and feet are clad", () => {
  // the cliff scene: high ground rows 0–5, a 1-tile drop to rows 6–13; lip row 5, foot row 6. A rise of 1 gets a
  // broken single row of crest boulders over the lip (cliffband.ts), with growth following the rock
  const scene = SCENES.find((s) => s.name === "cliff") as Scene;
  for (const preset of ["natural_clusters", "woodland", "forest", "dense_forest"] as const)
    it(`${preset}: no stretch of lip longer than five cells stays bare`, () => {
      const g = grid(scene);
      const cells: Array<[number, number]> = [];
      for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) cells.push([x, y]);
      for (let seed = 1; seed <= 10; seed++) {
        const ps = dressArea(g, {
          preset,
          areaIndex: 1,
          areaCells: cells,
          density: 0.7,
          seed,
          remaining: 6000,
        }).placements;
        const occ = new Set<string>();
        // band rocks are emitted at their anchor cell; the rock itself spreads about two cells each way
        for (const p of ps) {
          const band = p.type === "cliff_face" || p.type === "cliff_crest";
          const [w, h] = band ? [2, 2] : p.size;
          for (let y = p.at[1] - (band ? 1 : 0); y < p.at[1] + h; y++)
            for (let x = p.at[0] - (band ? 1 : 0); x < p.at[0] + w; x++) occ.add(`${String(x)},${String(y)}`);
        }
        // the lip only: a rise of 1 has no face rocks on the low ground
        for (const [edge, inner] of [[5, 4]] as const) {
          let bare = 0;
          let worst = 0;
          for (let x = 0; x < scene.w; x++) {
            const covered =
              occ.has(`${String(x)},${String(edge)}`) || occ.has(`${String(x)},${String(inner)}`);
            bare = covered ? 0 : bare + 1;
            worst = Math.max(worst, bare);
          }
          expect(worst, `seed ${String(seed)} row ${String(edge)}`).toBeLessThanOrEqual(5);
        }
      }
    });
});
