/**
 * Ground cover never forms a lattice (owner's watchtower run, 2026-11-20: mushrooms and plants on every other cell
 * of a meadow read as a planted field). Small natural pieces come in clumps with gaps: measured by the Clark–Evans
 * ratio R (≈1 random, >1.3 even/lattice, <1 clustered) and the share of isolated single pieces.
 */
import { describe, expect, it } from "vitest";
import {
  dressArea,
  scatterFeatures,
  type GeneratedPlacement,
  type PlacementGrid,
} from "../../../src/gen/index";

const W = 40;
const H = 30;
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
const meadow: PlacementGrid = {
  inBounds: inB,
  isFloor: inB,
  flags: () => 0,
  area: (x, y) => (inB(x, y) ? 1 : 0),
  occupied: () => false,
  edge: () => 0,
  height: () => 0,
};
const cells: Array<[number, number]> = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells.push([x, y]);

function stats(ps: GeneratedPlacement[]): { n: number; R: number; singles: number } {
  const pts = ps.map((p) => p.at);
  const n = pts.length;
  if (n < 2) return { n, R: 0, singles: 0 };
  const nn = pts.map(([x, y], i) =>
    Math.min(...pts.filter((_, j) => j !== i).map(([a, b]) => Math.hypot(a - x, b - y))),
  );
  const mean = nn.reduce((s, d) => s + d, 0) / n;
  const R = mean / (0.5 / Math.sqrt(n / (W * H)));
  const singles = nn.filter((d) => d > 1.5).length / n;
  return { n, R, singles };
}

describe("ground cover comes in clumps, never a lattice", () => {
  for (const preset of ["woodland", "forest", "natural_clusters", "dense_forest"] as const)
    it(`${preset}: small pieces cluster`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const ps = dressArea(meadow, {
          preset,
          areaIndex: 1,
          areaCells: cells,
          density: 0.7,
          seed,
          remaining: 6000,
        }).placements.filter((p) => p.type === "ground_cover" || p.type === "small_detail");
        const s = stats(ps);
        if (s.n < 10) continue;
        expect(s.R, `seed ${String(seed)}`).toBeLessThan(1.2); // random or clustered; a lattice is 1.3+
        expect(s.singles, `seed ${String(seed)}`).toBeLessThanOrEqual(0.35);
      }
    });

  it("a dense generator-2 scatter of a natural piece drifts instead of packing into an even grid", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const base = {
        feature: "mushroom" as const,
        candidates: cells,
        density: 0.6,
        minSpacing: 2,
        avoid: new Set<"water" | "walls" | "features" | "links" | "paths" | "areas">(),
        randomRotation: true,
        seed,
        remaining: 6000,
      };
      const even = stats(scatterFeatures(meadow, base).placements);
      const drift = stats(scatterFeatures(meadow, { ...base, drift: true }).placements);
      expect(even.R).toBeGreaterThan(1.3); // the plain blue-noise spread is the lattice we avoid
      expect(drift.R, `seed ${String(seed)}`).toBeLessThan(1.1);
    }
  });
});

describe("scattered pieces stand on ground that carries them", () => {
  it("never at a cliff lip, beside a channel or a pit (generator 2)", () => {
    // high ground rows 0–9, a cliff down to rows 10–29; a water channel in rows 20–21; a pit at 30–33, 4–7
    const height = (x: number, y: number): number =>
      y < 10 ? 3 : x >= 30 && x <= 33 && y >= 4 && y <= 7 ? 1 : 0;
    const g: PlacementGrid = {
      ...meadow,
      height,
      flags: (_x, y) => (y === 20 || y === 21 ? 4 : 0),
    };
    for (let seed = 1; seed <= 6; seed++) {
      const ps = scatterFeatures(g, {
        feature: "boulder",
        candidates: cells,
        density: 0.5,
        minSpacing: 1,
        avoid: new Set(["water"]),
        randomRotation: true,
        seed,
        remaining: 6000,
        supported: true,
      }).placements;
      expect(ps.length).toBeGreaterThan(20);
      for (const p of ps)
        for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
          for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                expect(height(nx, ny), `${p.type} at ${p.at.join(",")}`).toBeGreaterThanOrEqual(
                  height(x, y) - 0.25,
                );
                expect(ny === 20 || ny === 21, `${p.type} at ${p.at.join(",")} beside water`).toBe(false);
              }
    }
  });
});
