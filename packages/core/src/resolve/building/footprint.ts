/**
 * Footprint geometry of a building or enclosure: cells as "x,y" keys (string order is part of the output: rings and
 * cell lists are walked sorted), straight runs of a face, the ring around a footprint, and rect helpers.
 */
import type { OpeningKind, Side } from "../../contracts/plan";
import { SIDE_STEP as STEP } from "../../gen/gridGeometry";
import type { Prng } from "../../util/prng";

export const key = (x: number, y: number): string => `${x},${y}`;

/** The cell of an "x,y" key. */
export const cellOf = (k: string): [number, number] => k.split(",").map(Number) as [number, number];

/** A face cell's key with its side: "x,y,side". */
export const faceKey = (x: number, y: number, side: Side): string => `${x},${y},${side}`;

/** Opening kinds a person walks through (a building's door, which a default door is added for when it has none). */
export const DOOR_KINDS = new Set<OpeningKind>([
  "door",
  "double_door",
  "locked_door",
  "secret_door",
  "archway",
  "open",
  "portcullis",
]);

export type Rect = { x: number; y: number; w: number; h: number };

/** A straight run of outside edges of a footprint on one face: cells along it, in increasing x (N/S) or y (E/W). */
export interface FaceRun {
  side: Side;
  cells: Array<[number, number]>;
}

/** The k-th cell along a face from `at` (east along an N or S face, south along an E or W face). */
export function alongFace(at: readonly [number, number], side: Side, k: number): [number, number] {
  return side === "N" || side === "S" ? [at[0] + k, at[1]] : [at[0], at[1] + k];
}

/** The cells around a footprint (its eight neighbours that are not in it), sorted. */
export function ringOf(cells: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = cellOf(k);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const kk = key(x + dx, y + dy);
        if (!cells.has(kk)) out.add(kk);
      }
  }
  return [...out].sort();
}

/** Straight runs of outside edges on one face, longest first (ties: smallest start). */
export function faceRuns(cellSet: ReadonlySet<string>, side: Side): FaceRun[] {
  const [dx, dy] = STEP[side];
  const lines = new Map<number, number[]>();
  for (const k of cellSet) {
    const [x, y] = cellOf(k);
    if (cellSet.has(key(x + dx, y + dy))) continue;
    const line = side === "N" || side === "S" ? y : x;
    const along = side === "N" || side === "S" ? x : y;
    const arr = lines.get(line) ?? [];
    arr.push(along);
    lines.set(line, arr);
  }
  const runs: FaceRun[] = [];
  for (const [line, list] of [...lines].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || (list[i] as number) !== (list[i - 1] as number) + 1) {
        const cells: Array<[number, number]> = [];
        for (let j = start; j < i; j++) {
          const a = list[j] as number;
          cells.push(side === "N" || side === "S" ? [a, line] : [line, a]);
        }
        runs.push({ side, cells });
        start = i;
      }
    }
  }
  // the outermost line first on its face, then longest
  const outer = (r: FaceRun): number => {
    const c = r.cells[0] as [number, number];
    return side === "N" ? c[1] : side === "S" ? -c[1] : side === "W" ? c[0] : -c[0];
  };
  return runs.sort((a, b) => b.cells.length - a.cells.length || outer(a) - outer(b));
}

/** First cell of a `width`-long stretch at fraction `pos` along a run. */
export function along(run: FaceRun, pos: number, width: number): number {
  const n = run.cells.length;
  return Math.max(0, Math.min(n - width, Math.round(pos * (n - width))));
}

/** A value drawn in the range, to two decimals. */
export const pickRange = (prng: Prng, r: readonly [number, number]): number =>
  Math.round((r[0] + (r[1] - r[0]) * prng.next()) * 100) / 100;

export function rectCells(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

export const rectText = (r: Rect | undefined): string => (r ? `${r.x},${r.y} ${r.w}x${r.h}` : "?");

/** Chamfered corners: the four corner cells of a rect of at least 3×3 are cut off. */
export function chamfer(cells: Array<[number, number]>, r: Rect): Array<[number, number]> {
  if (r.w < 3 || r.h < 3) return cells;
  const x1 = r.x + r.w - 1;
  const y1 = r.y + r.h - 1;
  return cells.filter(([x, y]) => !((x === r.x || x === x1) && (y === r.y || y === y1)));
}

export function boundsOf(cells: ReadonlyArray<readonly [number, number]>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}
