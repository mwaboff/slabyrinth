/**
 * Allocation-free camera maths for the viewer's hot path: the view basis (the same rule as scene3d's `viewBasis`, so
 * the viewer and the software pictures agree on which way is up), a GL view-projection matrix, the frustum planes of
 * that matrix and an AABB test against them. Every function writes into arrays the caller owns.
 *
 * World axes are TaleSpire's (x east, y up, z north: a left-handed frame). The view matrix maps right → +x, up → +y and
 * forward → -z of GL's eye space, so the picture is the scene3d picture (east to the right when looking north).
 */

/** Unit vectors right, up, forward (9 floats) of a camera at `eye` looking at `target`. */
export function basisInto(
  out: Float64Array,
  ex: number,
  ey: number,
  ez: number,
  tx: number,
  ty: number,
  tz: number,
): void {
  let fx = tx - ex;
  let fy = ty - ey;
  let fz = tz - ez;
  let n = Math.hypot(fx, fy, fz);
  if (n === 0) {
    fx = 0;
    fy = 0;
    fz = 1;
    n = 1;
  }
  fx /= n;
  fy /= n;
  fz /= n;
  // up hint: world up, or north when looking (almost) straight down or up
  const hx = 0;
  const hy = Math.abs(fy) > 0.999 ? 0 : 1;
  const hz = Math.abs(fy) > 0.999 ? 1 : 0;
  // right = hint × fwd
  let rx = hy * fz - hz * fy;
  let ry = hz * fx - hx * fz;
  let rz = hx * fy - hy * fx;
  const rn = Math.hypot(rx, ry, rz) || 1;
  rx /= rn;
  ry /= rn;
  rz /= rn;
  // up = fwd × right
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  out[3] = fy * rz - fz * ry;
  out[4] = fz * rx - fx * rz;
  out[5] = fx * ry - fy * rx;
  out[6] = fx;
  out[7] = fy;
  out[8] = fz;
}

/**
 * Column-major view-projection (GL clip space) of a perspective camera with basis `b` (from basisInto) at the eye.
 */
export function viewProjInto(
  out: Float32Array,
  b: Float64Array,
  ex: number,
  ey: number,
  ez: number,
  fovYDeg: number,
  aspect: number,
  near: number,
  far: number,
): void {
  const rx = b[0] ?? 0;
  const ry = b[1] ?? 0;
  const rz = b[2] ?? 0;
  const ux = b[3] ?? 0;
  const uy = b[4] ?? 0;
  const uz = b[5] ?? 0;
  const fx = b[6] ?? 0;
  const fy = b[7] ?? 0;
  const fz = b[8] ?? 0;
  // view rows: right, up, -forward; translation -R·eye
  const v0 = rx;
  const v4 = ry;
  const v8 = rz;
  const v12 = -(rx * ex + ry * ey + rz * ez);
  const v1 = ux;
  const v5 = uy;
  const v9 = uz;
  const v13 = -(ux * ex + uy * ey + uz * ez);
  const v2 = -fx;
  const v6 = -fy;
  const v10 = -fz;
  const v14 = fx * ex + fy * ey + fz * ez;
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const p0 = f / aspect;
  const p5 = f;
  const p10 = (far + near) / (near - far);
  const p14 = (2 * far * near) / (near - far);
  // P × V (P has p0, p5, p10, p11 = -1, p14)
  out[0] = p0 * v0;
  out[1] = p5 * v1;
  out[2] = p10 * v2;
  out[3] = -v2;
  out[4] = p0 * v4;
  out[5] = p5 * v5;
  out[6] = p10 * v6;
  out[7] = -v6;
  out[8] = p0 * v8;
  out[9] = p5 * v9;
  out[10] = p10 * v10;
  out[11] = -v10;
  out[12] = p0 * v12;
  out[13] = p5 * v13;
  out[14] = p10 * v14 + p14;
  out[15] = -v14;
}

/** The six frustum planes (a, b, c, d per plane; inside when a·x + b·y + c·z + d ≥ 0) of a column-major matrix. */
export function frustumInto(out: Float64Array, m: Float32Array): void {
  const m0 = m[0] ?? 0;
  const m1 = m[1] ?? 0;
  const m2 = m[2] ?? 0;
  const m3 = m[3] ?? 0;
  const m4 = m[4] ?? 0;
  const m5 = m[5] ?? 0;
  const m6 = m[6] ?? 0;
  const m7 = m[7] ?? 0;
  const m8 = m[8] ?? 0;
  const m9 = m[9] ?? 0;
  const m10 = m[10] ?? 0;
  const m11 = m[11] ?? 0;
  const m12 = m[12] ?? 0;
  const m13 = m[13] ?? 0;
  const m14 = m[14] ?? 0;
  const m15 = m[15] ?? 0;
  // rows of the matrix: r0 = (m0, m4, m8, m12) ... r3 = (m3, m7, m11, m15); planes r3 ± ri
  const set = (k: number, a: number, b: number, c: number, d: number): void => {
    out[k] = a;
    out[k + 1] = b;
    out[k + 2] = c;
    out[k + 3] = d;
  };
  set(0, m3 + m0, m7 + m4, m11 + m8, m15 + m12); // left
  set(4, m3 - m0, m7 - m4, m11 - m8, m15 - m12); // right
  set(8, m3 + m1, m7 + m5, m11 + m9, m15 + m13); // bottom
  set(12, m3 - m1, m7 - m5, m11 - m9, m15 - m13); // top
  set(16, m3 + m2, m7 + m6, m11 + m10, m15 + m14); // near
  set(20, m3 - m2, m7 - m6, m11 - m10, m15 - m14); // far
}

/** Does the box (min xyz, max xyz at `box[o..o+5]`) meet the frustum? Conservative (may say yes near corners). */
export function boxInFrustum(planes: Float64Array, box: Float32Array, o: number): boolean {
  const x0 = box[o] ?? 0;
  const y0 = box[o + 1] ?? 0;
  const z0 = box[o + 2] ?? 0;
  const x1 = box[o + 3] ?? 0;
  const y1 = box[o + 4] ?? 0;
  const z1 = box[o + 5] ?? 0;
  for (let p = 0; p < 24; p += 4) {
    const a = planes[p] ?? 0;
    const b = planes[p + 1] ?? 0;
    const c = planes[p + 2] ?? 0;
    const d = planes[p + 3] ?? 0;
    // the box corner furthest along the plane normal
    const px = a >= 0 ? x1 : x0;
    const py = b >= 0 ? y1 : y0;
    const pz = c >= 0 ? z1 : z0;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/** Distance from a point to a box (0 inside). */
export function distanceToBox(box: Float32Array, o: number, x: number, y: number, z: number): number {
  const dx = Math.max((box[o] ?? 0) - x, 0, x - (box[o + 3] ?? 0));
  const dy = Math.max((box[o + 1] ?? 0) - y, 0, y - (box[o + 4] ?? 0));
  const dz = Math.max((box[o + 2] ?? 0) - z, 0, z - (box[o + 5] ?? 0));
  return Math.hypot(dx, dy, dz);
}

/** Farthest distance from a point to any corner of a box. */
export function farthestToBox(box: Float32Array, o: number, x: number, y: number, z: number): number {
  const dx = Math.max(Math.abs((box[o] ?? 0) - x), Math.abs((box[o + 3] ?? 0) - x));
  const dy = Math.max(Math.abs((box[o + 1] ?? 0) - y), Math.abs((box[o + 4] ?? 0) - y));
  const dz = Math.max(Math.abs((box[o + 2] ?? 0) - z), Math.abs((box[o + 5] ?? 0) - z));
  return Math.hypot(dx, dy, dz);
}

/**
 * Ray-box slab test: the entry distance along the ray (0 when the origin is inside), or -1 when it misses. `inv` is
 * 1 / direction per axis (Infinity for a zero component).
 */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  ix: number,
  iy: number,
  iz: number,
  box: Float32Array,
  o: number,
): number {
  let t0 = 0;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const origin = k === 0 ? ox : k === 1 ? oy : oz;
    const inv = k === 0 ? ix : k === 1 ? iy : iz;
    const lo = box[o + k] ?? 0;
    const hi = box[o + 3 + k] ?? 0;
    let a = (lo - origin) * inv;
    let b = (hi - origin) * inv;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      // parallel to the slab (0 × Infinity): inside it or not
      if (origin < lo || origin > hi) return -1;
      continue;
    }
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}
