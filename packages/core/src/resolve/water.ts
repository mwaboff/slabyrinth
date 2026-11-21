/**
 * Rivers and brooks (generator 2): a water course enters on one board edge and leaves on another, and its inner
 * points keep off the border so it runs through the play space instead of along it. Ponds, lakes and springs (by
 * the op's id) are left as drawn.
 */
import type { Side, Vec2 } from "../contracts/plan";
import { OPPOSITE } from "../gen/gridGeometry";

type P = [number, number];

/** Words in an op id that mark still water, which need not cross the map. */
export const STILL_WATER = /pond|lake|spring|pool|well|fountain|puddle|marsh|bog/;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const onEdge = (p: P, b: Box): Side | null =>
  p[1] <= b.y0 + 1 ? "N" : p[1] >= b.y1 - 1 ? "S" : p[0] <= b.x0 + 1 ? "W" : p[0] >= b.x1 - 1 ? "E" : null;

/** Where a ray from `p` along `d` leaves the box, and through which side. */
function exit(p: P, d: [number, number], b: Box): { at: P; side: Side } {
  let best = { t: Infinity, side: "N" as Side };
  const cand: Array<[number, Side]> = [];
  if (d[0] > 0) cand.push([(b.x1 - p[0]) / d[0], "E"]);
  if (d[0] < 0) cand.push([(b.x0 - p[0]) / d[0], "W"]);
  if (d[1] > 0) cand.push([(b.y1 - p[1]) / d[1], "S"]);
  if (d[1] < 0) cand.push([(b.y0 - p[1]) / d[1], "N"]);
  for (const [t, side] of cand) if (t >= 0 && t < best.t) best = { t, side };
  return { at: snap(p, best.side, b), side: best.side };
}

/** The point on `side` of the box level with `p`. */
function snap(p: P, side: Side, b: Box): P {
  const cx = Math.max(b.x0, Math.min(b.x1, Math.round(p[0])));
  const cy = Math.max(b.y0, Math.min(b.y1, Math.round(p[1])));
  return side === "N" ? [cx, b.y0] : side === "S" ? [cx, b.y1] : side === "W" ? [b.x0, cy] : [b.x1, cy];
}

/**
 * A river's course: ends extended to the board edges (two different edges), inner points held `margin` cells off
 * every edge. Returns the points unchanged when they already do both.
 */
export function riverCourse(points: readonly Vec2[], box: Box, width: number): Vec2[] {
  if (points.length < 2) return points.map((p) => [p[0], p[1]] as P);
  // a fifth of the map from each edge (at least the channel and a bank): a river crosses the play space
  const marginX = Math.max(Math.ceil(width) + 2, Math.round((box.x1 - box.x0 + 1) * 0.2));
  const marginY = Math.max(Math.ceil(width) + 2, Math.round((box.y1 - box.y0 + 1) * 0.2));
  const pts = points.map((p) => [p[0], p[1]] as P);
  const first = pts[0] as P;
  const last = pts[pts.length - 1] as P;
  let startSide = onEdge(first, box);
  if (startSide === null) {
    const next = pts[1] as P;
    const e = exit(first, [first[0] - next[0], first[1] - next[1]], box);
    pts.unshift(e.at);
    startSide = e.side;
  }
  let endSide = onEdge(last, box);
  if (endSide === null) {
    const prev = pts[pts.length - 2] as P;
    const e = exit(last, [last[0] - prev[0], last[1] - prev[1]], box);
    endSide = e.side === startSide ? OPPOSITE[startSide] : e.side;
    pts.push(e.side === startSide ? snap(last, endSide, box) : e.at);
  } else if (endSide === startSide) {
    // both ends on one edge: carry the water on across the map to the opposite edge
    const side = OPPOSITE[startSide];
    pts.push(snap(last, side, box));
  }
  // inner points keep off the border (the ends stay on it)
  const lo = (v: number, a: number, z: number, m: number): number => Math.max(a + m, Math.min(z - m, v));
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i] as P;
    if (box.x1 - box.x0 > 2 * marginX) p[0] = lo(p[0], box.x0, box.x1, marginX);
    if (box.y1 - box.y0 > 2 * marginY) p[1] = lo(p[1], box.y0, box.y1, marginY);
  }
  return pts;
}
