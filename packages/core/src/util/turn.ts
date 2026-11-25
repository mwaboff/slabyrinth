/**
 * Turning about the vertical axis, the only turn TaleSpire has: clockwise seen from above, in the world's axes (x east,
 * z north). Shared by the compiler's placement geometry (compile/geometry.ts), the arrangement operators (arrange/)
 * and the 3D scene (scene3d), so a piece's turned outline is computed one way everywhere.
 */

/**
 * The basis of a turn: sin and cos rounded to 12 places, so quarter turns are exact (cos 90° is 0, not 6e-17). A point
 * (x, z) turned clockwise is (x·c + z·s, −x·s + z·c); every turn of a piece's points goes through this rounding.
 */
export function turnBasis(cwDeg: number): { s: number; c: number } {
  const t = (cwDeg * Math.PI) / 180;
  return { c: Math.round(Math.cos(t) * 1e12) / 1e12, s: Math.round(Math.sin(t) * 1e12) / 1e12 };
}
const sinCos = turnBasis;

/** Rotates (x, z) clockwise (seen from above) by `cwDeg` degrees of game rotation (after rotSense). */
export function rotateXZ(x: number, z: number, cwDeg: number): { x: number; z: number } {
  const { s, c } = sinCos(cwDeg);
  return { x: x * c + z * s, z: -x * s + z * c };
}

/**
 * Half the sides of the axis-aligned box round a footprint of `sx` by `sz` (x by z) turned `cwDeg` about its centre:
 * the footprint itself at quarter turns (swapped at odd ones), larger in between.
 */
export function turnedHalfExtents(sx: number, sz: number, cwDeg: number): { x: number; z: number } {
  const { s, c } = sinCos(cwDeg);
  return {
    x: (Math.abs(c) * sx + Math.abs(s) * sz) / 2,
    z: (Math.abs(s) * sx + Math.abs(c) * sz) / 2,
  };
}

/** A point in plan (x, z). */
export type PlanPoint = readonly [x: number, z: number];

/**
 * The true footprint of a piece of `sx` by `sz` turned `cwDeg` about its centre (x, z): its four corners. The box of
 * `turnedHalfExtents` holds it; between the quarter turns the box also covers ground the piece does not.
 */
export function turnedFootprint(x: number, z: number, sx: number, sz: number, cwDeg: number): PlanPoint[] {
  return (
    [
      [-sx / 2, -sz / 2],
      [sx / 2, -sz / 2],
      [sx / 2, sz / 2],
      [-sx / 2, sz / 2],
    ] as const
  ).map(([px, pz]): PlanPoint => {
    const r = rotateXZ(px, pz, cwDeg);
    return [x + r.x, z + r.z];
  });
}

/** Signed area of a polygon in plan (positive: anticlockwise in x-z with z up the page). */
export function signedArea(poly: readonly PlanPoint[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i] as PlanPoint;
    const [x2, z2] = poly[(i + 1) % poly.length] as PlanPoint;
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/** The area two convex polygons share (Sutherland–Hodgman clip of one by the other): turned footprints' overlap. */
export function overlapArea(a: readonly PlanPoint[], b: readonly PlanPoint[]): number {
  const ccw = (p: readonly PlanPoint[]): readonly PlanPoint[] => (signedArea(p) >= 0 ? p : [...p].reverse());
  const clipBy = ccw(b);
  let out: PlanPoint[] = [...ccw(a)];
  for (let i = 0; i < clipBy.length && out.length > 0; i++) {
    const [ax, az] = clipBy[i] as PlanPoint;
    const [bx, bz] = clipBy[(i + 1) % clipBy.length] as PlanPoint;
    const side = (p: PlanPoint): number => (bx - ax) * (p[1] - az) - (bz - az) * (p[0] - ax);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j] as PlanPoint;
      const q = input[(j + 1) % input.length] as PlanPoint;
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
}
