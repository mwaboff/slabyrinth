/**
 * Round 5 (owner's v5 cave, 2026-11-20): the ritual ring on the dais came out as four or five scattered pieces.
 * Ring membership is now strict: N stones (6–9) at equal angles round a lit centre, all of them or none, nothing
 * else within a cell of the centre, candles between the stones. Measured on the generated placements.
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { RING_TABLES, dressArea, type GeneratedPlacement, type PlacementGrid } from "../../../src/gen/index";

const STONES = new Set(["monolith", "standing_stone"]);

function scene(w: number, h: number, height: (x: number, y: number) => number): PlacementGrid {
  const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  return {
    inBounds: inB,
    isFloor: inB,
    flags: () => 0,
    area: (x, y) => (inB(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, s: Side) => {
      const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
      const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
      if (!inB(nx, ny)) return 1;
      return height(nx, ny) !== height(x, y) ? 3 : 0;
    },
    height,
  };
}

function ringOf(
  ps: GeneratedPlacement[],
): { centre: [number, number]; stones: Array<[number, number]> } | null {
  const fire = ps.find((p) => p.type === "magic_fire");
  if (!fire) return null;
  const cx = fire.at[0];
  const cy = fire.at[1];
  const stones = ps
    .filter((p) => STONES.has(p.type) && Math.max(Math.abs(p.at[0] - cx), Math.abs(p.at[1] - cy)) <= 6)
    .map((p) => [p.at[0] - cx, p.at[1] - cy] as [number, number]);
  return { centre: [cx, cy], stones };
}

function geometryFaults(stones: Array<[number, number]>): string[] {
  const out: string[] = [];
  const n = stones.length;
  if (n < 6 || n > 9) out.push(`${String(n)} stones`);
  const d = stones.map(([x, y]) => Math.hypot(x, y));
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / n) / mean;
  if (sd > 0.08) out.push(`radius spread ${sd.toFixed(3)}`);
  const ang = stones.map(([x, y]) => (Math.atan2(y, x) * 180) / Math.PI).sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    const gap = ((ang[(i + 1) % n] as number) - (ang[i] as number) + 360) % 360;
    if (Math.abs(gap - 360 / n) > 15) out.push(`gap ${gap.toFixed(1)}° (want ${(360 / n).toFixed(1)}°)`);
  }
  return out;
}

describe("ritual ring geometry", () => {
  for (const [r, table] of Object.entries(RING_TABLES))
    it(`the radius-${r} table is a ring`, () => {
      expect(geometryFaults(table.map(([x, y]) => [x, y]))).toEqual([]);
      for (let i = 0; i < table.length; i++)
        for (let j = i + 1; j < table.length; j++) {
          const [a, b] = [table[i] as readonly [number, number], table[j] as readonly [number, number]];
          expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeGreaterThan(1);
        }
    });

  const cases: Array<[string, PlacementGrid, Array<[number, number]>]> = [];
  {
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) cells.push([x, y]);
    cases.push(["open floor", scene(24, 20, () => 0), cells]);
  }
  {
    // a two-tier dais (as in the cave proof): a 9-wide top tier on a 13-wide base, in a 24×20 room
    const h = (x: number, y: number): number => {
      const d = Math.max(Math.abs(x - 12), Math.abs(y - 10));
      return d <= 4 ? 1 : d <= 6 ? 0.5 : 0;
    };
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) cells.push([x, y]);
    cases.push(["two-tier dais", scene(24, 20, h), cells]);
  }

  for (const [name, g, cells] of cases)
    it(`${name}: all stones at equal angles round a clear, lit centre`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const ps = dressArea(g, {
          preset: "ritual_circle",
          areaIndex: 1,
          areaCells: cells,
          density: 0.7,
          seed,
          remaining: 6000,
        }).placements;
        const ring = ringOf(ps);
        expect(ring, `seed ${String(seed)}: no ring`).not.toBeNull();
        if (!ring) continue;
        expect(geometryFaults(ring.stones), `seed ${String(seed)}`).toEqual([]);
        // the centre: nothing but the fire within a cell of it
        const near = ps.filter(
          (p) =>
            p.type !== "magic_fire" &&
            Math.max(Math.abs(p.at[0] - ring.centre[0]), Math.abs(p.at[1] - ring.centre[1])) <= 1,
        );
        expect(
          near.map((p) => p.type),
          `seed ${String(seed)}`,
        ).toEqual([]);
        // candles between the stones
        const candles = ps.filter(
          (p) =>
            p.type === "candles" &&
            Math.max(Math.abs(p.at[0] - ring.centre[0]), Math.abs(p.at[1] - ring.centre[1])) <= 4,
        );
        expect(candles.length, `seed ${String(seed)}`).toBeGreaterThanOrEqual(3);
      }
    });
});
