/**
 * Gable roof geometry (resolve/roof.ts): courses step one cell in and one tile up, run-2 courses overlap, the ridge
 * is continuous (an opposed one-cell pair on even spans, a cap row on odd spans), and every outline cell is roofed.
 */
import { describe, expect, it } from "vitest";
import { defaultRidge, gableRoof, type RoofPiece } from "../../../src/resolve/roof";

const cellsOf = (p: RoofPiece): string[] => {
  const out: string[] = [];
  for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) out.push(`${x},${y}`);
  return out;
};

describe("gableRoof", () => {
  for (const ridge of ["ew", "ns"] as const)
    for (let w = 2; w <= 9; w++)
      for (let h = 2; h <= 8; h++) {
        it(`${w}x${h} ridge ${ridge}: outline fully roofed, continuous ridge, 45° courses`, () => {
          const g = gableRoof({ x: 10, y: 20, w, h, ridge });
          expect(g.outline).toEqual({ x: 9, y: 19, w: w + 2, h: h + 2 });
          const covered = new Map<string, number>();
          for (const p of g.pieces) for (const c of cellsOf(p)) covered.set(c, (covered.get(c) ?? 0) + 1);
          for (let y = 19; y < 19 + h + 2; y++)
            for (let x = 9; x < 9 + w + 2; x++) expect(covered.has(`${x},${y}`), `cell ${x},${y}`).toBe(true);
          // nothing outside the outline
          for (const c of covered.keys()) {
            const [x, y] = c.split(",").map(Number) as [number, number];
            expect(x >= 9 && y >= 19 && x < 11 + w && y < 21 + h).toBe(true);
          }
          const span = ridge === "ew" ? h + 2 : w + 2;
          const len = ridge === "ew" ? w + 2 : h + 2;
          const half = Math.floor(span / 2);
          expect(g.ridgeTop).toBe(half);
          // course = distance from the eave: the piece's eave-side row
          for (const p of g.pieces) {
            if (p.kind === "cap") continue;
            const a0 = ridge === "ew" ? p.y - 19 : p.x - 9;
            const run = ridge === "ew" ? p.h : p.w;
            const eaveRow = p.eave === "N" || p.eave === "W" ? a0 : a0 + run - 1;
            expect(p.course).toBe(Math.min(eaveRow, span - 1 - eaveRow));
            // rise 1 per cell: a run-2 piece's top is two tiles above its course
            expect(["slope", "slope2", "slope2x2"]).toContain(p.kind);
          }
          // the ridge is continuous along its whole length
          const along = (p: RoofPiece): number[] => {
            const out: number[] = [];
            const [b0, n] = ridge === "ew" ? [p.x - 9, p.w] : [p.y - 19, p.h];
            for (let b = b0; b < b0 + n; b++) out.push(b);
            return out;
          };
          if (span % 2 === 1) {
            const caps = new Set(g.pieces.filter((p) => p.kind === "cap").flatMap(along));
            expect(caps.size).toBe(len);
          } else {
            for (const eave of ridge === "ew" ? (["N", "S"] as const) : (["W", "E"] as const)) {
              const top = g.pieces.filter(
                (p) => p.kind === "slope" && p.eave === eave && p.course === half - 1,
              );
              expect(new Set(top.flatMap(along)).size).toBe(len);
            }
          }
          // no broken or missing piece kinds; inside columns use the 2-wide run-2 piece where they fit
          if (half - 1 >= 2 || (span % 2 === 1 && half >= 2))
            expect(g.pieces.some((p) => p.kind === "slope2x2") || len <= 3).toBe(true);
        });
      }

  it("matches the in-game shack: 6x4 footprint, half-span 3 → one run-2 course and the ridge pair", () => {
    const g = gableRoof({ x: 18, y: 10, w: 6, h: 4, ridge: "ew" });
    const run2 = g.pieces.filter((p) => p.kind === "slope2" || p.kind === "slope2x2");
    expect(new Set(run2.map((p) => p.course))).toEqual(new Set([0]));
    expect(g.pieces.filter((p) => p.kind === "slope").every((p) => p.course === 2)).toBe(true);
    // gable columns take single-width run-2 pieces, the inside 2×2s
    expect(
      run2
        .filter((p) => p.kind === "slope2")
        .map((p) => p.x)
        .sort(),
    ).toEqual([17, 17, 24, 24]);
    expect(run2.filter((p) => p.kind === "slope2x2").length).toBe(6);
  });

  it("leaves a chimney cell open and roofs its neighbours", () => {
    const holes = new Set(["17,12"]);
    const g = gableRoof({ x: 18, y: 10, w: 6, h: 4, ridge: "ew" }, holes);
    const cells = new Set(g.pieces.flatMap(cellsOf));
    expect(cells.has("17,12")).toBe(false);
    for (const n of ["17,11", "17,13", "18,12"]) expect(cells.has(n)).toBe(true);
  });

  it("default ridge runs along the longer side", () => {
    expect(defaultRidge(6, 4)).toBe("ew");
    expect(defaultRidge(4, 6)).toBe("ns");
    expect(defaultRidge(5, 5)).toBe("ew");
  });
});
