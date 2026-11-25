/**
 * Picking: the ray through a pixel, and the nearest shown piece it meets (by the pieces' world boxes, through the
 * chunk grid: a chunk is opened only when the ray meets its box nearer than the best hit so far). Honours the same
 * filters as drawing (levels, classes, roles, roofs, the cut height).
 */
import { FOV_DEG } from "./camera";
import { pieceHidden, type FilterMasks } from "./filters";
import { rayBox } from "./math";
import type { SceneStore } from "./store";

export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

/**
 * The ray from the eye through a point of the picture: `nx`, `ny` in -1..1 (right and up), for a camera with basis
 * `b` (math.basisInto) and picture aspect width/height.
 */
export function rayThrough(
  b: Float64Array,
  eye: { x: number; y: number; z: number },
  aspect: number,
  nx: number,
  ny: number,
  out: Ray,
): Ray {
  const t = Math.tan((FOV_DEG * Math.PI) / 360);
  const sx = nx * t * aspect;
  const sy = ny * t;
  let dx = (b[6] ?? 0) + (b[0] ?? 0) * sx + (b[3] ?? 0) * sy;
  let dy = (b[7] ?? 0) + (b[1] ?? 0) * sx + (b[4] ?? 0) * sy;
  let dz = (b[8] ?? 0) + (b[2] ?? 0) * sx + (b[5] ?? 0) * sy;
  const n = Math.hypot(dx, dy, dz) || 1;
  dx /= n;
  dy /= n;
  dz /= n;
  out.ox = eye.x;
  out.oy = eye.y;
  out.oz = eye.z;
  out.dx = dx;
  out.dy = dy;
  out.dz = dz;
  return out;
}

export interface Hit {
  id: number;
  /** Distance along the ray. */
  t: number;
}

const inv = (d: number): number => (d === 0 ? Infinity : 1 / d);

/** The nearest shown instance the ray meets, or null. */
export function pickRay(store: SceneStore, masks: FilterMasks, r: Ray): Hit | null {
  const ix = inv(r.dx);
  const iy = inv(r.dy);
  const iz = inv(r.dz);
  let best = Infinity;
  let bestId = -1;
  for (const c of store.chunks) {
    const aabb = c.aabb;
    if (!aabb || c.count === 0 || masks.levelShown[c.level] !== 1) continue;
    const tc = rayBox(r.ox, r.oy, r.oz, ix, iy, iz, c.box, 0);
    if (tc < 0 || tc >= best) continue;
    for (let k = 0; k < c.count; k++) {
      let t = rayBox(r.ox, r.oy, r.oz, ix, iy, iz, aabb, k * 6);
      if (t < 0 || t >= best) continue;
      if (pieceHidden(store, c, k, masks)) continue;
      // a piece cut by the cut height is hit only below the cut
      if (r.oy + r.dy * t > masks.cutHeight) {
        if (r.dy >= 0) continue;
        t = (masks.cutHeight - r.oy) / r.dy;
        const a = k * 6;
        const x = r.ox + r.dx * t;
        const z = r.oz + r.dz * t;
        if (
          t >= best ||
          x < (aabb[a] ?? 0) ||
          x > (aabb[a + 3] ?? 0) ||
          z < (aabb[a + 2] ?? 0) ||
          z > (aabb[a + 5] ?? 0)
        )
          continue;
      }
      best = t;
      bestId = c.base + k;
    }
  }
  return bestId < 0 ? null : { id: bestId, t: best };
}

/** Where the ray meets the horizontal plane y = `h` in front of the eye, or null. */
export function rayPlaneY(r: Ray, h: number, out: { x: number; y: number; z: number }): boolean {
  if (Math.abs(r.dy) < 1e-6) return false;
  const t = (h - r.oy) / r.dy;
  if (t <= 0) return false;
  out.x = r.ox + r.dx * t;
  out.y = h;
  out.z = r.oz + r.dz * t;
  return true;
}
