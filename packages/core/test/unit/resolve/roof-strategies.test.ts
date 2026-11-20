/**
 * Roof strategies beyond the gable (resolve/roof.ts, phase 2): hip, shed, the ring layer (skirt / stepped) and the
 * spire shell — each a pure function checked over many sizes: every outline cell roofed once, nothing outside, the
 * courses rise one tile per cell inward, the top is where the shape closes.
 */
import { describe, expect, it } from "vitest";
import { hipRoof, ringLayer, type RoofPiece, shedRoof, spireShell } from "../../../src/resolve/roof";

const cellsOf = (p: RoofPiece): string[] => {
  const out: string[] = [];
  for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) out.push(`${x},${y}`);
  return out;
};
const coverage = (pieces: RoofPiece[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of pieces) for (const c of cellsOf(p)) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};

describe("hipRoof", () => {
  for (let w = 1; w <= 9; w++)
    for (let h = 1; h <= 9; h++)
      it(`${w}x${h}: every outline cell roofed exactly once, rings rise inward, closed top`, () => {
        const g = hipRoof({ x: 4, y: 6, w, h });
        expect(g.outline).toEqual({ x: 3, y: 5, w: w + 2, h: h + 2 });
        const cov = coverage(g.pieces);
        for (let y = 5; y < 7 + h; y++)
          for (let x = 3; x < 5 + w; x++) expect(cov.get(`${x},${y}`), `cell ${x},${y}`).toBe(1);
        expect(cov.size).toBe((w + 2) * (h + 2));
        expect(g.inner).toBeNull();
        for (const p of g.pieces) {
          const ring = Math.min(p.x - 3, p.y - 5, 4 + w - p.x, 6 + h - p.y);
          expect(p.course === ring || (p.kind === "cap" && p.course === ring + 1)).toBe(true);
          if (p.kind === "corner") expect(p.corner).toMatch(/^[NS][EW]$/);
        }
        expect(g.top).toBe(Math.ceil(Math.min(w + 2, h + 2) / 2));
        // the gable-fill target outside the walls is 0 on every face (a hip has no gable ends)
        for (let x = 3; x < 5 + w; x++) expect(g.surface(x, 5)).toBe(0);
        expect(g.surface(0, 0)).toBe(-1);
        expect(g.ridges).toHaveLength(1);
      });
  it("leaves chimney holes open", () => {
    const g = hipRoof({ x: 0, y: 0, w: 6, h: 4 }, new Set(["-1,2"]));
    expect(coverage(g.pieces).has("-1,2")).toBe(false);
  });
});

describe("shedRoof", () => {
  for (const low of ["N", "S", "E", "W"] as const)
    for (let w = 1; w <= 8; w++)
      for (let h = 1; h <= 6; h++)
        it(`${w}x${h} falling ${low}: outline roofed, courses climb from the low side, gable fill on the sides`, () => {
          const g = shedRoof({ x: 2, y: 3, w, h }, low);
          const o = g.outline;
          const cov = coverage(g.pieces);
          for (let y = o.y; y < o.y + o.h; y++)
            for (let x = o.x; x < o.x + o.w; x++) expect(cov.has(`${x},${y}`), `cell ${x},${y}`).toBe(true);
          for (const c of cov.keys()) {
            const [x, y] = c.split(",").map(Number) as [number, number];
            expect(x >= o.x && y >= o.y && x < o.x + o.w && y < o.y + o.h).toBe(true);
          }
          const span = low === "N" || low === "S" ? o.h : o.w;
          expect(g.top).toBe(span);
          for (const p of g.pieces) {
            expect(p.eave).toBe(low);
            const fromLow =
              low === "N"
                ? p.y - o.y
                : low === "S"
                  ? o.y + o.h - (p.y + p.h)
                  : low === "W"
                    ? p.x - o.x
                    : o.x + o.w - (p.x + p.w);
            expect(p.course).toBe(fromLow);
          }
          // the surface rises one tile per cell away from the low side
          const lowCell =
            low === "N"
              ? [o.x, o.y]
              : low === "S"
                ? [o.x, o.y + o.h - 1]
                : low === "W"
                  ? [o.x, o.y]
                  : [o.x + o.w - 1, o.y];
          expect(g.surface(lowCell[0] as number, lowCell[1] as number)).toBe(0);
        });
});

describe("ringLayer (skirt, stepped)", () => {
  for (const kind of ["slope", "step"] as const)
    for (const overhang of [true, false])
      for (let w = 2; w <= 10; w++)
        for (let courses = 1; courses <= 3; courses++)
          it(`${kind} ${w}x${w + 1} ×${courses}${overhang ? " on walls" : " on a ledge"}: rings round a flat inner top`, () => {
            const r = { x: 10, y: 10, w, h: w + 1 };
            const g = ringLayer(r, courses, kind, overhang);
            const o = overhang ? { x: 9, y: 9, w: w + 2, h: w + 3 } : r;
            expect(g.outline).toEqual(o);
            const cov = coverage(g.pieces);
            for (const n of cov.values()) expect(n).toBe(1);
            const k = Math.min(courses, Math.ceil(Math.min(o.w, o.h) / 2));
            if (o.w - 2 * k > 0 && o.h - 2 * k > 0)
              expect(g.inner).toEqual({ x: o.x + k, y: o.y + k, w: o.w - 2 * k, h: o.h - 2 * k });
            else expect(g.inner).toBeNull();
            // the inner top is not roofed; every ring cell is
            for (let y = o.y; y < o.y + o.h; y++)
              for (let x = o.x; x < o.x + o.w; x++) {
                const ring = Math.min(x - o.x, y - o.y, o.x + o.w - 1 - x, o.y + o.h - 1 - y);
                expect(cov.has(`${x},${y}`), `cell ${x},${y}`).toBe(ring < k);
              }
            for (const p of g.pieces) {
              if (kind === "step") expect(["step"]).toContain(p.kind);
              else expect(["slope", "corner", "cap"]).toContain(p.kind);
            }
            expect(g.top).toBe(courses);
          });
});

describe("spireShell", () => {
  for (let w = 2; w <= 12; w++)
    for (const bands of [0, 1, 2, 3])
      it(`${w}x${w} with ${bands} band(s): courses taper half a cell per 2 tiles, finial on the tip`, () => {
        const s = spireShell({ x: 3.5, y: 4.5, w, h: w }, { bands });
        expect(s.courses.length).toBeGreaterThan(0);
        s.courses.forEach((c, k) => {
          expect(c.x0).toBeCloseTo(3.5 + k * 0.5);
          expect(c.x1).toBeCloseTo(3.5 + w - k * 0.5);
          expect(c.y).toBe(k * 2);
          expect(c.x1 - c.x0).toBeGreaterThanOrEqual(1.5);
        });
        expect(s.top).toBe(s.courses.length * 2);
        expect(s.finial).toEqual({ x: 3.5 + w / 2, y: 4.5 + w / 2, at: s.top });
        const nb = s.courses.filter((c) => c.band).length;
        expect(nb).toBe(Math.min(bands, s.courses.length - 1));
        expect(s.courses[0]?.band).toBe(false);
      });
  it("a custom taper and course height", () => {
    const s = spireShell({ x: 0, y: 0, w: 6, h: 6 }, { taper: 1, courseHeight: 3 });
    expect(s.courses.map((c) => c.x0)).toEqual([0, 1, 2]);
    expect(s.top).toBe(9);
  });
});
