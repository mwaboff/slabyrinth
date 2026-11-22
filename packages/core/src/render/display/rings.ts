/** Tracing cell masks into display rings (cell units, global coords). */
import type { ResolvedLevel } from "../../contracts/resolved";
import { traceRings } from "../../resolve/trace";

/** A ring of points as the flat [x0, y0, x1, y1, ...] list a display item carries. */
export const flat = (ring: ReadonlyArray<readonly [number, number]>): number[] => {
  const out: number[] = [];
  for (const [x, y] of ring) out.push(x, y);
  return out;
};

/** Closed outline of the rectangle (x, y, w, h). */
export const box = (x: number, y: number, w: number, h: number): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
  x,
  y,
];

/** Rings of the cells selected by `pred`, restricted to the bbox of those cells (cell units, global). */
export function cellRings(level: ResolvedLevel, pred: (i: number) => boolean): number[][] {
  const { x: bx, y: by, w, h } = level.bounds;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (!pred(i)) continue;
    const lx = i % w;
    const ly = (i - lx) / w;
    if (lx < x0) x0 = lx;
    if (lx > x1) x1 = lx;
    if (ly < y0) y0 = ly;
    if (ly > y1) y1 = ly;
  }
  if (x1 < 0) return [];
  return traceRings(
    x1 - x0 + 1,
    y1 - y0 + 1,
    (ux, uy) => pred((y0 + uy) * w + x0 + ux),
    bx + x0,
    by + y0,
  ).map(flat);
}

/** Groups cells by a string key (null = skip) and traces each group. Keys are returned in first-seen order. */
export function groupRings(
  level: ResolvedLevel,
  keyOf: (i: number) => string | null,
): Array<[string, number[][]]> {
  const n = level.bounds.w * level.bounds.h;
  const keys: string[] = [];
  const idx = new Int32Array(n).fill(-1);
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    if (k === null) continue;
    let j = map.get(k);
    if (j === undefined) {
      j = keys.length;
      keys.push(k);
      map.set(k, j);
    }
    idx[i] = j;
  }
  return keys.map((k, j) => [k, cellRings(level, (i) => idx[i] === j)]);
}
