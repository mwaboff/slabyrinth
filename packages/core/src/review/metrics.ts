/**
 * Shape metrics measured on resolved cells (design review and organic-terrain tests):
 * the longest straight outline segment, square corners, and how much of its bounding box a cell set fills.
 */
import { traceRings } from "../resolve/trace";

export type CellSet = ReadonlyArray<readonly [number, number]>;

/** Outline rings of a cell set as vertex lists with collinear points merged. */
export function outline(cells: CellSet): Array<Array<[number, number]>> {
  if (cells.length === 0) return [];
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 + 1;
  const h = Math.max(...ys) - y0 + 1;
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));
  const rings = traceRings(w, h, (ux, uy) => set.has(`${x0 + ux},${y0 + uy}`), x0, y0);
  return rings.map((r) => {
    const pts = r.map((p) => [p[0], p[1]] as [number, number]);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length] as [number, number];
      const b = pts[i] as [number, number];
      const c = pts[(i + 1) % pts.length] as [number, number];
      const collinear = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) === 0;
      if (!collinear) out.push(b);
    }
    return out;
  });
}

/** Segments of every ring as lengths, in order. */
function segments(cells: CellSet): number[][] {
  return outline(cells).map((r) =>
    r.map((p, i) => {
      const q = r[(i + 1) % r.length] as [number, number];
      return Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
    }),
  );
}

/** Longest straight piece of the outline, in cells. */
export function longestStraight(cells: CellSet): number {
  return Math.max(0, ...segments(cells).flat());
}

/** Square corners: outline vertices whose two segments are both at least `arm` cells long. */
export function squareCorners(cells: CellSet, arm = 3): number {
  let n = 0;
  for (const segs of segments(cells))
    for (let i = 0; i < segs.length; i++)
      if ((segs[i] as number) >= arm && (segs[(i + 1) % segs.length] as number) >= arm) n++;
  return n;
}

/** Fraction of the bounding box the cells fill (1 = a rectangle). */
export function boxFill(cells: CellSet): number {
  if (cells.length === 0) return 0;
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  return cells.length / ((Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1));
}

/**
 * Longest straight outline piece that does not lie on the board edge (`bounds` in cells), with its midpoint (lattice
 * coordinates). A shape running off the board is not judged by the board's own edge.
 */
export function longestInnerStraight(
  cells: CellSet,
  bounds: { x: number; y: number; w: number; h: number },
): { length: number; at: [number, number] } {
  let best = { length: 0, at: [0, 0] as [number, number] };
  const onEdge = (a: [number, number], b: [number, number]): boolean =>
    (a[0] === b[0] && (a[0] === bounds.x || a[0] === bounds.x + bounds.w)) ||
    (a[1] === b[1] && (a[1] === bounds.y || a[1] === bounds.y + bounds.h));
  for (const r of outline(cells))
    for (let i = 0; i < r.length; i++) {
      const p = r[i] as [number, number];
      const q = r[(i + 1) % r.length] as [number, number];
      if (onEdge(p, q)) continue;
      const len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
      if (len > best.length) best = { length: len, at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] };
    }
  return best;
}

/** Connected components (4-neighbour) of a cell set. */
export function components(cells: CellSet): Array<Array<[number, number]>> {
  const left = new Map(cells.map(([x, y]) => [`${x},${y}`, [x, y] as [number, number]]));
  const out: Array<Array<[number, number]>> = [];
  for (const [k, start] of left) {
    if (!left.has(k)) continue;
    left.delete(k);
    const comp: Array<[number, number]> = [start];
    for (let i = 0; i < comp.length; i++) {
      const [x, y] = comp[i] as [number, number];
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        const nk = `${nx},${ny}`;
        const c = left.get(nk);
        if (c) {
          left.delete(nk);
          comp.push(c);
        }
      }
    }
    out.push(comp);
  }
  return out;
}
