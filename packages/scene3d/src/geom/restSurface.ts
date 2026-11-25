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
import { fnv1a32Bytes } from "@slabyrinth/core";
import type { MeshData, PieceGeom } from "../types/index";

/**
 * A mesh's identity: FNV-1a 32 over its vertex and index data, 8 hex digits. The measured tables record it with each
 * reading, so a re-run after a game update shows which pieces' meshes changed.
 */
export function meshIdentity(mesh: MeshData): string {
  const p = new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  const ix = new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
  const all = new Uint8Array(p.length + ix.length);
  all.set(p, 0);
  all.set(ix, p.length);
  return fnv1a32Bytes(all).toString(16).padStart(8, "0");
}

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

/** The numbers the rest grid is read by (tiles, shares). */
export const REST_GRID = {
  /** A grid cell is about this wide (each side has 2 to `maxCells` cells). */
  cell: 0.15,
  maxCells: 12,
  /** Lines down per grid cell, each way. */
  lines: 4,
  /** Heights within this of each other are one surface (as REST_READING.band). */
  band: 0.04,
  /** A cell holds a thing when one surface covers at least this share of its lines (a rim, a slope or a gap does not). */
  holdShare: 0.75,
} as const;

/** Where things rest over a piece's top, cell by cell over its collider's outline (the piece's own frame, unturned). */
export interface RestGrid {
  /** Cells along x and along z. */
  nx: number;
  nz: number;
  /**
   * Row by row from the outline's min z, each from its min x: the height a thing set there rests at, above the
   * collider's bottom, or null where the top cannot hold one (a slope, a rim, a carving, nothing there).
   */
  heights: Array<number | null>;
}

/**
 * The rest height over each part of a piece's top: a chest's rounded lid holds things only along its crest, an anvil's
 * face is higher than its horn, a desk's top ends at its edge. Each cell of a grid over the collider's outline takes the
 * highest surface its lines down meet when that surface covers most of the cell (REST_GRID.holdShare), else none.
 */
export function readRestGrid(mesh: MeshData, geom: PieceGeom): RestGrid {
  const { cell, maxCells, lines, band, holdShare } = REST_GRID;
  const c = geom.boundsCenter;
  const s = geom.size;
  const bottom = c.y - s.y / 2;
  const nx = Math.max(2, Math.min(maxCells, Math.round(s.x / cell)));
  const nz = Math.max(2, Math.min(maxCells, Math.round(s.z / cell)));
  const tris = triangleCells(mesh, REST_READING.step);
  const heights: Array<number | null> = [];
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      const tops: number[] = [];
      for (let b = 0; b < lines; b++)
        for (let a = 0; a < lines; a++) {
          const x = c.x - s.x / 2 + ((i + (a + 0.5) / lines) * s.x) / nx;
          const z = c.z - s.z / 2 + ((k + (b + 0.5) / lines) * s.z) / nz;
          const y = highestAt(mesh, tris.get(cellKey(x, z, REST_READING.step)) ?? [], x, z);
          if (y !== null) tops.push(y - bottom);
        }
      heights.push(holdingTop(tops, lines * lines, band, holdShare));
    }
  return { nx, nz, heights };
}

/**
 * Where a thing hung under a cover piece meets it, cell by cell over its collider's outline (the piece's own frame,
 * unturned), the same grid as `readRestGrid` read from below: each cell the lowest point the lines up through it meet
 * (a sloping cloth's low side over that cell, a thick canopy's underside, not its top), above the collider's bottom, or
 * null where most lines up meet nothing (the cover does not reach over that cell).
 */
export function readHangGrid(mesh: MeshData, geom: PieceGeom): RestGrid {
  const { cell, maxCells, lines, holdShare } = REST_GRID;
  const c = geom.boundsCenter;
  const s = geom.size;
  const bottom = c.y - s.y / 2;
  const nx = Math.max(2, Math.min(maxCells, Math.round(s.x / cell)));
  const nz = Math.max(2, Math.min(maxCells, Math.round(s.z / cell)));
  const tris = triangleCells(mesh, REST_READING.step);
  const heights: Array<number | null> = [];
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      let lowest = Infinity;
      let met = 0;
      for (let b = 0; b < lines; b++)
        for (let a = 0; a < lines; a++) {
          const x = c.x - s.x / 2 + ((i + (a + 0.5) / lines) * s.x) / nx;
          const z = c.z - s.z / 2 + ((k + (b + 0.5) / lines) * s.z) / nz;
          const y = lowestAt(mesh, tris.get(cellKey(x, z, REST_READING.step)) ?? [], x, z);
          if (y === null) continue;
          met++;
          lowest = Math.min(lowest, y - bottom);
        }
      heights.push(met / (lines * lines) >= holdShare ? lowest : null);
    }
  return { nx, nz, heights };
}

/** The highest band of `tops` (within `band`) that holds `share` of `count` lines: its top, or null. */
function holdingTop(tops: number[], count: number, band: number, share: number): number | null {
  tops.sort((a, b) => a - b);
  for (let hi = tops.length - 1, lo = hi; hi >= 0; hi--) {
    while (lo > 0 && (tops[hi] ?? 0) - (tops[lo - 1] ?? 0) <= band) lo--;
    if (lo > hi) lo = hi;
    if ((hi - lo + 1) / count >= share) return tops[hi] ?? null;
  }
  return null;
}

/** The numbers a floor piece's cover is read by. */
export const TOP_COVER = {
  /** Spacing of the lines down, and how far they keep in from the collider's sides (tiles). */
  step: 0.05,
  inset: 0.03,
  /** A line meets the piece's body when the highest point there is at least this share of its height up. */
  solid: 0.5,
} as const;

/** How a piece covers its outline seen from above. */
export interface TopCover {
  /** Share of the lines down over the outline that meet its body (0..1). */
  share: number;
  /** The largest open patch (lines that miss it, side by side), in tiles²: a gap a foot or a thing falls into. */
  hole: number;
}

/**
 * How a piece covers its outline seen from above: lines down over the collider's outline meet its body where the
 * highest point is at least half its height up. A whole floor tile covers all of it; a rounded-corner or broken-ended
 * tile leaves a patch of its cell open, a hole where it is laid mid-floor (a grate's slots are open too, but each is
 * small). Null when no line meets the mesh.
 */
export function readTopCover(mesh: MeshData, geom: PieceGeom): TopCover | null {
  const { step, inset, solid } = TOP_COVER;
  const c = geom.boundsCenter;
  const s = geom.size;
  const bottom = c.y - s.y / 2;
  const nx = Math.max(1, Math.round((s.x - 2 * inset) / step) + 1);
  const nz = Math.max(1, Math.round((s.z - 2 * inset) / step) + 1);
  const tris = triangleCells(mesh, step);
  const open = new Uint8Array(nx * nz);
  let met = 0;
  let any = false;
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      const x = nx === 1 ? c.x : c.x - s.x / 2 + inset + ((s.x - 2 * inset) * i) / (nx - 1);
      const z = nz === 1 ? c.z : c.z - s.z / 2 + inset + ((s.z - 2 * inset) * k) / (nz - 1);
      const y = highestAt(mesh, tris.get(cellKey(x, z, step)) ?? [], x, z);
      if (y !== null) any = true;
      if (y !== null && y - bottom >= solid * s.y) met++;
      else open[k * nx + i] = 1;
    }
  if (!any) return null;
  // the largest patch of open lines side by side, each standing for a square of the line spacing
  let largest = 0;
  const seen = new Uint8Array(nx * nz);
  for (let start = 0; start < open.length; start++) {
    if (!open[start] || seen[start]) continue;
    let n = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const j = stack.pop() ?? 0;
      n++;
      const i = j % nx;
      const k = Math.floor(j / nx);
      for (const [di, dk] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const a = i + di;
        const b = k + dk;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const q = b * nx + a;
        if (open[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    largest = Math.max(largest, n);
  }
  return { share: met / (nx * nz), hole: largest * step * step };
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
  return extremeAt(mesh, tris, x, z, 1);
}

/** The lowest point of the triangles `tris` on the vertical line through (x, z), or null when the line misses them. */
function lowestAt(mesh: MeshData, tris: readonly number[], x: number, z: number): number | null {
  return extremeAt(mesh, tris, x, z, -1);
}

/** The highest (`sign` 1) or lowest (-1) point of the triangles `tris` on the vertical line through (x, z), or null. */
function extremeAt(
  mesh: MeshData,
  tris: readonly number[],
  x: number,
  z: number,
  sign: 1 | -1,
): number | null {
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
    if (top === null || sign * y > sign * top) top = y;
  }
  return top;
}
