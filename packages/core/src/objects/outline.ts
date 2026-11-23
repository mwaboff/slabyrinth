/**
 * Plan outlines for objects, in the object's frame (x, z): curved sides as 15° facets (technique C6, the only turn a
 * piece has), tapers to a point or a narrower end, convex insets and outsets, clipping a side to an x range, and the
 * cells and tiles inside an outline. Pure geometry; arrange/path.ts lays pieces along what these return.
 */
import { inPolygon } from "../arrange/scatter";
import type { XZ } from "../arrange/piece";
import { signedArea } from "../util/turn";

const RAD = Math.PI / 180;
const FACET = 15;

/**
 * A taper as facets turning 15° at a time: from a side running along +x, reach `dx` further along and `dz` across (both
 * positive), ending at a heading of 15 × n degrees. Returns the corner points after the start (start at [0, 0]), the
 * last one [about dx, exactly dz]. `n` is chosen between `minFacets` and 6 so the end heading is steep enough; the facet
 * lengths grow or shrink geometrically so the taper is as long as asked (a fine bow: long shallow facets first).
 */
export function taperFacets(dx: number, dz: number, minFacets = 2): XZ[] {
  if (dz <= 1e-6) return [[dx, 0]];
  const ratio = dx / dz;
  let n = Math.max(1, minFacets);
  while (n < 6 && 1 / Math.tan(n * FACET * RAD) > ratio * 0.9) n++;
  const angles = Array.from({ length: n }, (_, k) => (k + 1) * FACET * RAD);
  const f = (r: number): number => {
    let c = 0;
    let s = 0;
    angles.forEach((a, k) => {
      c += r ** k * Math.cos(a);
      s += r ** k * Math.sin(a);
    });
    return c / s;
  };
  // f falls as r grows (the steep facets weigh more); bisect on log r
  let lo = Math.log(0.05);
  let hi = Math.log(20);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(Math.exp(mid)) > ratio) lo = mid;
    else hi = mid;
  }
  const r = Math.exp((lo + hi) / 2);
  const sinSum = angles.reduce((t, a, k) => t + r ** k * Math.sin(a), 0);
  const scale = dz / sinSum;
  const pts: XZ[] = [];
  let x = 0;
  let z = 0;
  angles.forEach((a, k) => {
    x += scale * r ** k * Math.cos(a);
    z += scale * r ** k * Math.sin(a);
    pts.push([x, z]);
  });
  // the headings stay on the 15° grid; a taper finer or blunter than n facets can reach ends short of or past dx
  return pts;
}

/** The shape of a two-ended hull or body in plan: length, half-width, the half-width of the square end, taper lengths. */
export interface BodyPlan {
  readonly length: number;
  readonly halfBeam: number;
  /** Half the width of the stern (back, −x) end: 0 for a point, `halfBeam` for a square end. */
  readonly sternHalf: number;
  /** How far the bow (+x) tapers from the full width to its point. */
  readonly bowTaper: number;
  /** How far the stern tapers from the full width to its end. */
  readonly sternTaper: number;
  /** Fewest facets in the bow taper (more: a rounder bow). */
  readonly bowFacets?: number;
  /** Fewest facets in the stern taper (1: a transom's short knuckle; 4 or more: a round stern). */
  readonly sternFacets?: number;
}

/**
 * The left (+z) side of a body in plan, from the stern corner [−L/2, sternHalf] to the bow point [L/2, 0]: stern
 * taper, the straight middle, the bow taper, every stretch on the 15° grid. Monotone in x.
 */
export function bodySide(b: BodyPlan): XZ[] {
  const half = b.length / 2;
  const bow = taperFacets(b.bowTaper, b.halfBeam, b.bowFacets ?? 2);
  const stern = taperFacets(b.sternTaper, Math.max(0, b.halfBeam - b.sternHalf), b.sternFacets ?? 2);
  const xs = -half + (stern[stern.length - 1]?.[0] ?? 0);
  const xb = half - (bow[bow.length - 1]?.[0] ?? 0);
  const pts: XZ[] = [[-half, b.sternHalf]];
  // the stern taper is a bow taper seen from the other end: walk it backwards from the full width
  const sternPts: XZ[] = [[0, 0], ...stern].map(([x, z]) => [xs - x, b.halfBeam - z]);
  for (let i = sternPts.length - 2; i >= 0; i--) {
    const p = sternPts[i];
    if (p) pts.push(p);
  }
  if (xb > xs + 1e-6) pts.push([xb, b.halfBeam]);
  for (const [x, z] of bow) pts.push([xb + x, b.halfBeam - z]);
  return dedupe(pts);
}

/** The closed outline of a side and its mirror (−z), anticlockwise seen from above (left side first). */
export function closedOutline(side: readonly XZ[]): XZ[] {
  const mirrored = [...side].reverse().map(([x, z]): XZ => [x, -z]);
  return dedupe([...side, ...mirrored]);
}

const same = (a: XZ, b: XZ): boolean => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

function dedupe(pts: readonly XZ[]): XZ[] {
  const out: XZ[] = [];
  for (const p of pts) if (out.length === 0 || !same(p, out[out.length - 1] as XZ)) out.push(p);
  if (out.length > 1 && same(out[0] as XZ, out[out.length - 1] as XZ)) out.pop();
  return out;
}

/**
 * A convex polygon moved in by `d` on every side (negative: out): each side shifted along its inward normal, corners
 * where neighbouring shifted sides meet. Sides shorter than 1e-6 are dropped first.
 */
export function insetConvex(poly: readonly XZ[], d: number): XZ[] {
  const p = dedupe(poly);
  const n = p.length;
  if (n < 3) return [...p];
  const ccw = signedArea(p) > 0 ? 1 : -1;
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % n] as XZ;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    // inward normal: left of travel for an anticlockwise polygon
    const nx = -uz * ccw;
    const nz = ux * ccw;
    return { px: a[0] + nx * d, pz: a[1] + nz * d, ux, uz };
  });
  return lines.map((l, i) => {
    const prev = lines[(i - 1 + n) % n] as (typeof lines)[number];
    const den = prev.ux * l.uz - prev.uz * l.ux;
    if (Math.abs(den) < 1e-9) return [l.px, l.pz] as XZ;
    const t = ((l.px - prev.px) * l.uz - (l.pz - prev.pz) * l.ux) / den;
    return [prev.px + prev.ux * t, prev.pz + prev.uz * t] as XZ;
  });
}

/** The part of a polyline monotone in x that lies in [a, b], with interpolated ends; empty when none does. */
export function clipX(pts: readonly XZ[], a: number, b: number): XZ[] {
  const out: XZ[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as XZ;
    const inside = p[0] >= a - 1e-9 && p[0] <= b + 1e-9;
    const prev = pts[i - 1];
    if (prev) {
      for (const cut of [a, b]) {
        const lo = Math.min(prev[0], p[0]);
        const hi = Math.max(prev[0], p[0]);
        if (cut > lo + 1e-9 && cut < hi - 1e-9) {
          const t = (cut - prev[0]) / (p[0] - prev[0]);
          out.push([cut, prev[1] + (p[1] - prev[1]) * t]);
        }
      }
    }
    if (inside) out.push(p);
  }
  return dedupe(out).sort((p, q) => p[0] - q[0]);
}

/** The x intervals in [lo, hi] where `keep` holds, sampled every `step` (ends where it changes, to the sample). */
export function intervals(
  keep: (x: number) => boolean,
  lo: number,
  hi: number,
  step = 0.05,
): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  const n = Math.ceil((hi - lo) / step);
  for (let i = 0; i <= n; i++) {
    const x = Math.min(hi, lo + i * step);
    if (keep(x)) {
      if (start === null) start = x;
    } else if (start !== null) {
      out.push([start, x - step]);
      start = null;
    }
  }
  if (start !== null) out.push([start, hi]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

/** The half-width of a closed symmetric outline at x (the largest |z| of its sides there), 0 outside it. */
export function halfWidthAt(poly: readonly XZ[], x: number): number {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as XZ;
    const q = poly[(i + 1) % poly.length] as XZ;
    const lo = Math.min(p[0], q[0]);
    const hi = Math.max(p[0], q[0]);
    if (x < lo - 1e-9 || x > hi + 1e-9) continue;
    const z =
      hi - lo < 1e-9
        ? Math.max(Math.abs(p[1]), Math.abs(q[1]))
        : p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0]);
    best = Math.max(best, Math.abs(z));
  }
  return best;
}

/** Whether a point lies inside a polygon or within `tol` of it. */
export function insideOrNear(poly: readonly XZ[], x: number, z: number, tol = 1e-6): boolean {
  if (inPolygon(poly, x, z)) return true;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i] as XZ;
    const [bx, bz] = poly[(i + 1) % poly.length] as XZ;
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
    if (Math.hypot(x - (ax + vx * t), z - (az + vz * t)) <= tol) return true;
  }
  return false;
}

/** The polygon cut to the x range [a, b] (a convex polygon stays convex). */
export function clipPolygonX(poly: readonly XZ[], a: number, b: number): XZ[] {
  const clipHalf = (pts: readonly XZ[], inside: (p: XZ) => boolean, at: number): XZ[] => {
    const out: XZ[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as XZ;
      const q = pts[(i + 1) % pts.length] as XZ;
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (at - p[0]) / (q[0] - p[0]);
        out.push([at, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  };
  return dedupe(
    clipHalf(
      clipHalf(poly, (p) => p[0] >= a, a),
      (p) => p[0] <= b,
      b,
    ),
  );
}
