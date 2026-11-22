/**
 * Turning about the vertical axis, the only turn TaleSpire has: clockwise seen from above, in the world's axes (x east,
 * z north). Shared by the compiler's placement geometry (compile/geometry.ts) and the arrangement operators
 * (arrange/), so a piece's turned outline is computed one way everywhere.
 */

/** sin and cos rounded to 12 places, so quarter turns are exact (cos 90° is 0, not 6e-17). */
function sinCos(cwDeg: number): { s: number; c: number } {
  const t = (cwDeg * Math.PI) / 180;
  return { c: Math.round(Math.cos(t) * 1e12) / 1e12, s: Math.round(Math.sin(t) * 1e12) / 1e12 };
}

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
