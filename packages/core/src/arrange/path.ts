/**
 * Paths in an arrangement's frame (x east, z north, tiles) for `run` and `station`: a polyline, or an arc laid as the
 * polygon of its 15° facets. Headings are clockwise from east seen from above, the same sense as a piece's yaw, so a
 * piece turned by a segment's heading lies along it with its local x.
 */
import { rotateXZ } from "../util/turn";
import { snapYaw, type XZ } from "./piece";

export interface Path {
  /** The corners in order. */
  readonly points: readonly XZ[];
  /** The last corner joins the first. */
  readonly closed?: boolean;
}

/** One straight stretch of a path, from `a` to `b`. */
export interface Segment {
  readonly a: XZ;
  readonly b: XZ;
  readonly length: number;
  /** Clockwise from east seen from above (degrees, not snapped). */
  readonly heading: number;
}

const DEG = 180 / Math.PI;

/** The heading of a direction (dx, dz): the yaw that turns local +x onto it. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx) * DEG;
}

export function polyline(points: readonly XZ[], closed = false): Path {
  return closed ? { points, closed } : { points };
}

/** The path's straight stretches in order (a zero-length one is left out). */
export function segments(path: Path): Segment[] {
  const pts = path.points;
  const out: Segment[] = [];
  const n = path.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a === undefined || b === undefined) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) continue;
    out.push({ a, b, length, heading: headingOf(b[0] - a[0], b[1] - a[1]) });
  }
  return out;
}

export interface ArcSpec {
  readonly centre?: XZ;
  /** Distance from the centre to the middle of every facet (the facets are tangent to this circle). */
  readonly radius: number;
  /** Angle of the first facet's middle, clockwise from east (degrees). */
  readonly from: number;
  /** Turn from the first facet's middle to the last one's: positive clockwise. */
  readonly sweep: number;
  /** The turn between facets (a multiple of 15; default 15). */
  readonly facet?: number;
}

/**
 * An arc as the polygon of its facets: one facet centred at every `facet` degrees from `from` through `from + sweep`,
 * each tangent to the circle of `radius`, so each facet's heading is its angle plus 90° (clockwise) and lies on the
 * 15° grid when `from` does. The polygon reaches half a facet past either end.
 */
export function arcPath(spec: ArcSpec): Path {
  const facet = Math.max(15, Math.abs(snapYaw(spec.facet ?? 15)) || 15);
  const dir = spec.sweep < 0 ? -1 : 1;
  const step = dir * facet;
  const n = Math.max(0, Math.round(Math.abs(spec.sweep) / facet));
  const [cx, cz] = spec.centre ?? [0, 0];
  const corner = spec.radius / Math.cos((facet / 2 / 180) * Math.PI);
  const points: XZ[] = [];
  for (let j = 0; j <= n + 1; j++) {
    const p = rotateXZ(corner, 0, spec.from - step / 2 + j * step);
    points.push([cx + p.x, cz + p.z]);
  }
  return { points };
}

/** The total length of a path. */
export function pathLength(path: Path): number {
  return segments(path).reduce((n, s) => n + s.length, 0);
}

/** The point `d` along the path and the heading there (the last point past the end), or null for an empty path. */
export function pointAlong(path: Path, d: number): { at: XZ; heading: number } | null {
  const segs = segments(path);
  let rest = d;
  for (const [i, s] of segs.entries()) {
    if (rest <= s.length || i === segs.length - 1) {
      const t = Math.min(1, Math.max(0, rest / s.length));
      return { at: [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t], heading: s.heading };
    }
    rest -= s.length;
  }
  return null;
}
