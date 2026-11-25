/**
 * Where a thing set on a piece rests: the height of the piece's real top surface, read from its mesh. A piece's
 * collider box reaches its highest point (a workbench's raised back, a chest's lid hinge), so a thing set at the box top
 * hovers over the surface it should stand on.
 *
 * Read in the piece's own frame (turns do not change heights): lines straight down over the inner part of the
 * collider's outline each meet the mesh's highest point there; the rest surface is the height most of them meet (the
 * work top, not the narrow back above it), at the top of that band. Heights are above the collider's bottom, the
 * frame the palette's `geom.size.y` is in, so core compares the two directly.
 */
import type { MeshData, PieceGeom } from "../types/index";

/** The numbers the reading decides by (tiles). */
export const REST_READING = {
  /** Spacing of the lines down. */
  step: 0.05,
  /** The lines keep this share of each side in from the collider's edge (things are set inside a top, not on its rim). */
  inset: 0.15,
  /** Heights within this of each other are one surface (a plank top's grain, a slight sag). */
  band: 0.04,
  /** A surface things are set on covers at least this share of the inner outline. */
  minShare: 0.3,
} as const;

export interface RestReading {
  /** Height of the rest surface above the collider's bottom. */
  rest: number;
  /** Share of the lines that meet the rest surface (0..1): how much of the top it is. */
  share: number;
  /** The collider's height (the box top a thing was set on before). */
  boxTop: number;
}

/**
 * The rest surface of a mesh with its collider, or null when no line down meets it (a mesh with nothing over its
 * inner outline).
 */
export function readRestSurface(mesh: MeshData, geom: PieceGeom): RestReading | null {
  const { step, inset, band, minShare } = REST_READING;
  const c = geom.boundsCenter;
  const s = geom.size;
  const bottom = c.y - s.y / 2;
  const hx = (s.x / 2) * (1 - 2 * inset);
  const hz = (s.z / 2) * (1 - 2 * inset);
  const nx = Math.max(1, Math.round((2 * hx) / step) + 1);
  const nz = Math.max(1, Math.round((2 * hz) / step) + 1);
  const tops: number[] = [];
  const cells = triangleCells(mesh, step);
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const x = nx === 1 ? c.x : c.x - hx + (2 * hx * i) / (nx - 1);
      const z = nz === 1 ? c.z : c.z - hz + (2 * hz * k) / (nz - 1);
      const y = highestAt(mesh, cells.get(cellKey(x, z, step)) ?? [], x, z);
      if (y !== null) tops.push(y - bottom);
    }
  if (tops.length === 0) return null;
  tops.sort((a, b) => a - b);
  // the highest band of heights that holds `minShare` of the lines: the top things are set on. Narrower bands above it
  // (a bench's raised back, a desk's hutch) are kept clear of by the placers; with no such band (a rounded top, a
  // barrel on its side: every height holds only a sliver) a thing rests at the box top, as before
  const lines = nx * nz;
  for (let hi = tops.length - 1, lo = hi; hi >= 0; hi--) {
    while (lo > 0 && (tops[hi] ?? 0) - (tops[lo - 1] ?? 0) <= band) lo--;
    if (lo > hi) lo = hi;
    const share = (hi - lo + 1) / lines;
    if (share >= minShare) return { rest: tops[hi] ?? 0, share, boxTop: s.y };
  }
  return { rest: s.y, share: 0, boxTop: s.y };
}

const cellKey = (x: number, z: number, size: number): string =>
  `${String(Math.floor(x / size))},${String(Math.floor(z / size))}`;

/** The triangles (first index of each) whose outline seen from above reaches each square of `size`. */
function triangleCells(mesh: MeshData, size: number): Map<string, number[]> {
  const p = mesh.positions;
  const ix = mesh.indices;
  const out = new Map<string, number[]>();
  for (let t = 0; t + 2 < ix.length; t += 3) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let j = 0; j < 3; j++) {
      const v = (ix[t + j] ?? 0) * 3;
      x0 = Math.min(x0, p[v] ?? 0);
      x1 = Math.max(x1, p[v] ?? 0);
      z0 = Math.min(z0, p[v + 2] ?? 0);
      z1 = Math.max(z1, p[v + 2] ?? 0);
    }
    for (let gx = Math.floor(x0 / size); gx <= Math.floor(x1 / size); gx++)
      for (let gz = Math.floor(z0 / size); gz <= Math.floor(z1 / size); gz++) {
        const k = `${String(gx)},${String(gz)}`;
        const l = out.get(k);
        if (l) l.push(t);
        else out.set(k, [t]);
      }
  }
  return out;
}

/** The highest point of the triangles `tris` on the vertical line through (x, z), or null when the line misses them. */
function highestAt(mesh: MeshData, tris: readonly number[], x: number, z: number): number | null {
  const p = mesh.positions;
  const ix = mesh.indices;
  let top: number | null = null;
  for (const t of tris) {
    const a = (ix[t] ?? 0) * 3;
    const b = (ix[t + 1] ?? 0) * 3;
    const d = (ix[t + 2] ?? 0) * 3;
    const ax = p[a] ?? 0;
    const az = p[a + 2] ?? 0;
    const bx = p[b] ?? 0;
    const bz = p[b + 2] ?? 0;
    const dx = p[d] ?? 0;
    const dz = p[d + 2] ?? 0;
    // barycentric weights of (x, z) in the triangle seen from above
    const det = (bz - dz) * (ax - dx) + (dx - bx) * (az - dz);
    if (Math.abs(det) < 1e-12) continue;
    const w1 = ((bz - dz) * (x - dx) + (dx - bx) * (z - dz)) / det;
    const w2 = ((dz - az) * (x - dx) + (ax - dx) * (z - dz)) / det;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
    const y = w1 * (p[a + 1] ?? 0) + w2 * (p[b + 1] ?? 0) + w3 * (p[d + 1] ?? 0);
    if (top === null || y > top) top = y;
  }
  return top;
}
