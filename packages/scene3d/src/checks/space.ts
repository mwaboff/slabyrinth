/**
 * The scene's space, for measuring: which pieces stand where (a hash of plan squares, so no question loops over every
 * pair) and where a ray meets a piece's real mesh. Meshes are kept in their own frame; a ray is turned into the piece's
 * frame (pieces only turn about the vertical), so one mesh serves every piece that uses it.
 *
 * Vertical rays (the common question: what is above or below this point) read a per-mesh grid of triangles by plan
 * square, built once per mesh on first use; other rays test the triangles of the pieces whose box they cross.
 */
import { turnBasis } from "@slabyrinth/core";
import { PlanHash } from "../geom/planHash";
import type { Box3, MeshData, Scene, SceneInstance, Vec3 } from "../types/index";

/** Side of a mesh's own triangle grid square, tiles. */
const MESH_CELL = 0.25;

/** One place a ray met a piece: which piece (index into Scene.instances) and the height or distance. */
export interface Hit {
  index: number;
  /** World height of the hit (vertical rays) or distance along the ray (other rays). */
  at: number;
}

interface MeshGrid {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  /** Triangle indices (into the mesh's index list / 3) per square. */
  cells: Uint32Array[];
}

const EMPTY = new Uint32Array(0);

function meshGrid(m: MeshData): MeshGrid {
  const P = m.positions;
  const I = m.indices;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < P.length; i += 3) {
    const x = P[i] ?? 0;
    const z = P[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minZ: 0, nx: 0, nz: 0, cells: [] };
  const nx = Math.max(1, Math.ceil((maxX - minX) / MESH_CELL + 1e-9));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / MESH_CELL + 1e-9));
  const lists: number[][] = Array.from({ length: nx * nz }, () => []);
  for (let t = 0; t + 2 < I.length; t += 3) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = (I[t + k] ?? 0) * 3;
      const x = P[v] ?? 0;
      const z = P[v + 2] ?? 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx0 = Math.max(0, Math.floor((x0 - minX) / MESH_CELL));
    const cx1 = Math.min(nx - 1, Math.floor((x1 - minX) / MESH_CELL));
    const cz0 = Math.max(0, Math.floor((z0 - minZ) / MESH_CELL));
    const cz1 = Math.min(nz - 1, Math.floor((z1 - minZ) / MESH_CELL));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) lists[cz * nx + cx]?.push(t / 3);
  }
  return { minX, minZ, nx, nz, cells: lists.map((l) => (l.length ? Uint32Array.from(l) : EMPTY)) };
}

/** The turn of a piece as cosine and sine (core `turnBasis`: the rounding every turn uses, quarter turns exact). */
const turn = (inst: SceneInstance): { c: number; s: number } => turnBasis(inst.rotDeg);

/** A world point in a piece's own frame. */
export function toLocal(inst: SceneInstance, p: Vec3): Vec3 {
  const { c, s } = turn(inst);
  const dx = p.x - inst.at.x;
  const dz = p.z - inst.at.z;
  return { x: dx * c - dz * s, y: p.y - inst.at.y, z: dx * s + dz * c };
}

/** A direction in a piece's own frame. */
function dirToLocal(inst: SceneInstance, d: Vec3): Vec3 {
  const { c, s } = turn(inst);
  return { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
}

/** A point of a piece's own frame in the world. */
export function toWorld(inst: SceneInstance, p: Vec3): Vec3 {
  const { c, s } = turn(inst);
  return { x: p.x * c + p.z * s + inst.at.x, y: p.y + inst.at.y, z: -p.x * s + p.z * c + inst.at.z };
}

/** A direction of a piece's own frame in the world. */
export function dirToWorld(inst: SceneInstance, d: Vec3): Vec3 {
  const { c, s } = turn(inst);
  return { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
}

export class SceneSpace {
  private readonly hash: PlanHash;
  private readonly grids = new Map<string, MeshGrid>();
  /** Each piece's mesh box in world (the instance's aabb). */
  readonly boxes: readonly Box3[];

  constructor(
    readonly scene: Scene,
    /** Pieces left out of every question (markers). */
    keep: (inst: SceneInstance) => boolean = (i) => i.role !== "marker",
  ) {
    this.boxes = scene.instances.map((i) => i.aabb);
    this.hash = new PlanHash(this.boxes, (idx) => {
      const inst = scene.instances[idx];
      return inst !== undefined && keep(inst);
    });
  }

  /** Pieces whose box meets the plan rectangle (each once, in index order). */
  near(minX: number, maxX: number, minZ: number, maxZ: number): number[] {
    return this.hash.near(minX, maxX, minZ, maxZ);
  }

  /** Pieces whose box meets a world box. */
  overlapping(b: Box3): number[] {
    return this.near(b.min.x, b.max.x, b.min.z, b.max.z).filter((i) => {
      const o = this.boxes[i];
      return o !== undefined && o.max.y >= b.min.y && o.min.y <= b.max.y;
    });
  }

  private grid(inst: SceneInstance): { grid: MeshGrid; mesh: MeshData } | null {
    const mesh = this.scene.meshes.get(inst.meshKey);
    if (!mesh) return null;
    let g = this.grids.get(inst.meshKey);
    if (!g) this.grids.set(inst.meshKey, (g = meshGrid(mesh)));
    return { grid: g, mesh };
  }

  /** The heights at which a vertical line through world (x, z) meets piece `idx`'s mesh (unsorted). */
  heightsOf(idx: number, x: number, z: number): number[] {
    const inst = this.scene.instances[idx];
    if (!inst) return [];
    const gm = this.grid(inst);
    if (!gm) return [];
    const { grid, mesh } = gm;
    const p = toLocal(inst, { x, y: 0, z });
    const cx = Math.floor((p.x - grid.minX) / MESH_CELL);
    const cz = Math.floor((p.z - grid.minZ) / MESH_CELL);
    if (cx < 0 || cz < 0 || cx >= grid.nx || cz >= grid.nz) return [];
    const out: number[] = [];
    const P = mesh.positions;
    const I = mesh.indices;
    for (const t of grid.cells[cz * grid.nx + cx] ?? EMPTY) {
      const a = (I[t * 3] ?? 0) * 3;
      const b = (I[t * 3 + 1] ?? 0) * 3;
      const c = (I[t * 3 + 2] ?? 0) * 3;
      const ax = P[a] ?? 0;
      const az = P[a + 2] ?? 0;
      const bx = P[b] ?? 0;
      const bz = P[b + 2] ?? 0;
      const qx = P[c] ?? 0;
      const qz = P[c + 2] ?? 0;
      const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(d) < 1e-12) continue;
      const w0 = ((bz - qz) * (p.x - qx) + (qx - bx) * (p.z - qz)) / d;
      const w1 = ((qz - az) * (p.x - qx) + (ax - qx) * (p.z - qz)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      out.push(w0 * (P[a + 1] ?? 0) + w1 * (P[b + 1] ?? 0) + w2 * (P[c + 1] ?? 0) + inst.at.y);
    }
    return out;
  }

  /**
   * Every place a vertical line through (x, z) meets a piece between heights `lo` and `hi`, highest first; `skip`
   * leaves pieces out.
   */
  column(x: number, z: number, lo: number, hi: number, skip?: (idx: number) => boolean): Hit[] {
    const out: Hit[] = [];
    // (the hits are sorted below, so the order pieces are visited in does not matter)
    const cand: number[] = [];
    this.hash.each(x, x, z, z, (idx) => {
      const b = this.boxes[idx];
      if (b && b.max.y >= lo && b.min.y <= hi) cand.push(idx);
    });
    for (const idx of cand) {
      if (skip?.(idx)) continue;
      for (const y of this.heightsOf(idx, x, z)) if (y >= lo && y <= hi) out.push({ index: idx, at: y });
    }
    return out.sort((a, b) => b.at - a.at || a.index - b.index);
  }

  /**
   * The nearest place a ray from `o` along unit `d` meets a piece within `maxT`, or null. `skip` leaves pieces out.
   */
  ray(o: Vec3, d: Vec3, maxT: number, skip?: (idx: number) => boolean): Hit | null {
    const ex = { x: o.x + d.x * maxT, z: o.z + d.z * maxT };
    let best: Hit | null = null;
    const cand = this.near(
      Math.min(o.x, ex.x),
      Math.max(o.x, ex.x),
      Math.min(o.z, ex.z),
      Math.max(o.z, ex.z),
    );
    for (const idx of cand) {
      if (skip?.(idx)) continue;
      const b = this.boxes[idx];
      if (!b || !rayMeetsBox(o, d, best ? best.at : maxT, b)) continue;
      const t = this.rayPiece(idx, o, d, best ? best.at : maxT);
      if (t !== null && (!best || t < best.at)) best = { index: idx, at: t };
    }
    return best;
  }

  /** Where a ray meets one piece's mesh (nearest distance ≤ maxT), or null. */
  rayPiece(idx: number, o: Vec3, d: Vec3, maxT: number): number | null {
    const inst = this.scene.instances[idx];
    const mesh = inst ? this.scene.meshes.get(inst.meshKey) : undefined;
    if (!inst || !mesh) return null;
    const lo = toLocal(inst, o);
    const ld = dirToLocal(inst, d);
    const P = mesh.positions;
    const I = mesh.indices;
    let best: number | null = null;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = (I[t] ?? 0) * 3;
      const b = (I[t + 1] ?? 0) * 3;
      const c = (I[t + 2] ?? 0) * 3;
      const hit = rayTriangle(
        lo,
        ld,
        P[a] ?? 0,
        P[a + 1] ?? 0,
        P[a + 2] ?? 0,
        P[b] ?? 0,
        P[b + 1] ?? 0,
        P[b + 2] ?? 0,
        P[c] ?? 0,
        P[c + 1] ?? 0,
        P[c + 2] ?? 0,
      );
      if (hit !== null && hit >= 0 && hit <= (best ?? maxT)) best = hit;
    }
    return best;
  }

  /** The world positions of a piece's mesh vertices (x, y, z triples). */
  worldVertices(idx: number): Float64Array {
    const inst = this.scene.instances[idx];
    const mesh = inst ? this.scene.meshes.get(inst.meshKey) : undefined;
    if (!inst || !mesh) return new Float64Array(0);
    const { c, s } = turn(inst);
    const P = mesh.positions;
    const out = new Float64Array(P.length);
    for (let i = 0; i + 2 < P.length; i += 3) {
      const x = P[i] ?? 0;
      const z = P[i + 2] ?? 0;
      out[i] = x * c + z * s + inst.at.x;
      out[i + 1] = (P[i + 1] ?? 0) + inst.at.y;
      out[i + 2] = -x * s + z * c + inst.at.z;
    }
    return out;
  }
}

/** Does a ray (from o along d, up to maxT) meet a box? (slab test) */
export function rayMeetsBox(o: Vec3, d: Vec3, maxT: number, b: Box3): boolean {
  let t0 = 0;
  let t1 = maxT;
  for (const ax of ["x", "y", "z"] as const) {
    const od = o[ax];
    const dd = d[ax];
    const lo = b.min[ax];
    const hi = b.max[ax];
    if (Math.abs(dd) < 1e-12) {
      if (od < lo || od > hi) return false;
      continue;
    }
    let ta = (lo - od) / dd;
    let tb = (hi - od) / dd;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** Möller–Trumbore: the distance along the ray to the triangle, or null (both faces count). */
function rayTriangle(
  o: Vec3,
  d: Vec3,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number | null {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const px = d.y * e2z - d.z * e2y;
  const py = d.z * e2x - d.x * e2z;
  const pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = o.x - ax;
  const ty = o.y - ay;
  const tz = o.z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
