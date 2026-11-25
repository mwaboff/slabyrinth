/**
 * The viewer's copy of a scene. The chunk table comes with the header (bounds and sizes, before any instance), so the
 * planner culls and chooses detail per chunk without data and asks only for the chunks it needs; a chunk's instances
 * are kept as they arrive (the wire's typed arrays, no copy) plus each piece's world box (for picking), about 57
 * bytes per piece in all. Pieces are named by a scene-wide id: the chunk's base (its place in the header's table)
 * plus the piece's index in the chunk.
 */
import type { InstanceChunk, SceneHeader } from "../sceneSource";
import { roleNumber } from "./roles";

const NO_ROLES = new Uint8Array(0);

/** Failed: the chunk's data was refused (it disagreed with the header); it is not asked for again. */
export const ChunkState = { Absent: 0, Requested: 1, Loaded: 2, Failed: 3 } as const;

export interface Chunk {
  /** Index in `SceneStore.chunks` (the header's order). */
  index: number;
  id: string;
  level: number;
  /** min xyz, max xyz. */
  box: Float32Array;
  count: number;
  /** Scene-wide id of the chunk's first piece. */
  base: number;
  state: number;
  data: InstanceChunk | null;
  /** World box per piece (6n), once loaded. */
  aabb: Float32Array | null;
  /** Index of "roof" in the chunk's layer table (-1 none). */
  roofLayer: number;
  /** Per entry of the chunk's role table: the role's scene-wide number (filters.roleNumber), once loaded. */
  roleNumbers: Uint8Array;
  /** Bumped when data arrives: GPU buffers built from an older version are stale. */
  version: number;
  /** Frame the chunk was last wanted at, and how near (fetch order). */
  wantFrame: number;
  wantDist: number;
  /** Index of its summary region in `SceneStore.regions`. */
  region: number;
}

/** Far chunks are drawn by region: REGION_TILES square per level, one buffer and one draw for all its summaries. */
export const REGION_TILES = 128;

export interface Region {
  index: number;
  chunks: Chunk[];
  /** Frame it was last drawn (the planner draws a region once per frame). */
  drawnFrame: number;
  /** Frame in which some of its chunks were nearer (drawn in detail). */
  mixedFrame: number;
}

export class SceneStore {
  readonly header: SceneHeader;
  readonly chunks: Chunk[];
  readonly regions: Region[] = [];
  readonly n: number;
  private readonly byId = new Map<string, Chunk>();
  readonly roofClass: number;
  readonly waterClass: number;
  /** The mesh table's own-frame bounds (6 per mesh), its triangles, and which meshes are stand-ins. */
  readonly meshBounds: Float32Array;
  readonly meshTriangles: Uint32Array;
  readonly boxOnly: Uint8Array;
  loadedInstances = 0;
  loadedChunks = 0;
  /** Bytes of the loaded pieces' arrays: the viewer's share of the JS heap for the scene (~58 per piece). */
  loadedBytes = 0;
  /** Bit i: some loaded piece is of header class i (the colour key lists only the kinds the map has). */
  classesSeen = 0;

  constructor(header: SceneHeader) {
    this.header = header;
    let base = 0;
    this.chunks = header.chunks.map((c, index) => {
      const ch: Chunk = {
        index,
        id: c.id,
        level: c.levelIndex,
        box: new Float32Array([...c.bounds.min, ...c.bounds.max]),
        count: c.instances,
        base,
        state: ChunkState.Absent,
        data: null,
        aabb: null,
        roofLayer: -1,
        roleNumbers: NO_ROLES,
        version: 0,
        wantFrame: 0,
        wantDist: Infinity,
        region: 0,
      };
      base += c.instances;
      this.byId.set(c.id, ch);
      return ch;
    });
    this.n = base;
    const regionKey = new Map<string, Region>();
    for (const c of this.chunks) {
      const rx = Math.floor(((c.box[0] ?? 0) + (c.box[3] ?? 0)) / 2 / REGION_TILES);
      const rz = Math.floor(((c.box[2] ?? 0) + (c.box[5] ?? 0)) / 2 / REGION_TILES);
      const key = `${c.level}:${rx}:${rz}`;
      let r = regionKey.get(key);
      if (!r) {
        r = { index: this.regions.length, chunks: [], drawnFrame: 0, mixedFrame: 0 };
        regionKey.set(key, r);
        this.regions.push(r);
      }
      r.chunks.push(c);
      c.region = r.index;
    }
    this.roofClass = header.classes.findIndex((c) => c.id === "roof");
    this.waterClass = header.classes.findIndex((c) => c.id === "water");
    const m = header.meshes.length;
    this.meshBounds = new Float32Array(m * 6);
    this.meshTriangles = new Uint32Array(m);
    this.boxOnly = new Uint8Array(m);
    header.meshes.forEach((mesh, i) => {
      this.meshBounds.set([...mesh.bounds.min, ...mesh.bounds.max], i * 6);
      this.meshTriangles[i] = mesh.triangles;
      this.boxOnly[i] = mesh.box ? 1 : 0;
    });
  }

  chunkById(id: string): Chunk | undefined {
    return this.byId.get(id);
  }

  /** The chunk holding a scene-wide piece id (binary search over the bases). */
  chunkOf(id: number): Chunk | undefined {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.chunks[mid];
      if (!c) return undefined;
      if (id < c.base) hi = mid - 1;
      else if (id >= c.base + c.count) lo = mid + 1;
      else return c;
    }
    return undefined;
  }

  /**
   * Takes a chunk's data in; returns the chunk (undefined for an unknown id). A chunk that disagrees with the header
   * (another count: every later piece id would name the wrong piece) or with itself (arrays shorter than its count,
   * indices past the header's tables) is refused: it becomes Failed (drawn as nothing, never asked for again).
   */
  load(data: InstanceChunk): Chunk | undefined {
    const c = this.byId.get(data.id);
    if (!c) return undefined;
    if (!this.fits(c, data)) {
      this.unload(c);
      c.state = ChunkState.Failed;
      return undefined;
    }
    if (c.state === ChunkState.Loaded) this.unload(c);
    this.loadedInstances += data.count;
    this.loadedChunks++;
    c.count = data.count;
    c.data = data;
    c.state = ChunkState.Loaded;
    c.roofLayer = data.layers.indexOf("roof");
    c.roleNumbers = Uint8Array.from(data.roles, roleNumber);
    c.version++;
    for (let k = 0; k < data.count; k++) this.classesSeen |= 1 << ((data.colourClass[k] ?? 0) & 31);
    this.classesSeen >>>= 0;
    const aabb = new Float32Array(data.count * 6);
    for (let k = 0; k < data.count; k++) worldBox(this.meshBounds, data, k, aabb, k * 6);
    c.aabb = aabb;
    // the header's bounds are the truth for culling; grow them if a piece reaches beyond (never shrink)
    for (let k = 0; k < data.count; k++)
      for (let j = 0; j < 3; j++) {
        const lo = aabb[k * 6 + j] ?? 0;
        const hi = aabb[k * 6 + 3 + j] ?? 0;
        if (lo < (c.box[j] ?? 0)) c.box[j] = lo;
        if (hi > (c.box[3 + j] ?? 0)) c.box[3 + j] = hi;
      }
    this.loadedBytes += SceneStore.chunkBytes(c);
    return c;
  }

  /** Does a chunk's data agree with its row in the header and with itself? */
  private fits(c: Chunk, d: InstanceChunk): boolean {
    const n = d.count;
    const row = this.header.chunks[c.index];
    if (!Number.isInteger(n) || n < 0 || n !== row?.instances) return false;
    const perPiece: ReadonlyArray<[ArrayLike<number>, number]> = [
      [d.mesh, 1],
      [d.transform, 4],
      [d.colour, 3],
      [d.colourClass, 1],
      [d.level, 1],
      [d.layer, 1],
      [d.name, 1],
      [d.element, 1],
      [d.role, 1],
      [d.cell, 2],
    ];
    if (perPiece.some(([a, k]) => a.length !== n * k)) return false;
    const meshes = this.header.meshes.length;
    const levels = this.header.levels.length;
    const classes = this.header.classes.length;
    for (let k = 0; k < n; k++)
      if (
        (d.mesh[k] ?? 0) >= meshes ||
        (d.level[k] ?? 0) >= levels ||
        (d.colourClass[k] ?? 0) >= classes ||
        (d.layer[k] ?? 0) >= d.layers.length ||
        (d.name[k] ?? 0) >= d.names.length ||
        (d.element[k] ?? -1) >= d.elements.length ||
        (d.role[k] ?? -1) >= d.roles.length
      )
        return false;
    return true;
  }

  /** Bytes of a loaded chunk's arrays. */
  private static chunkBytes(c: Chunk): number {
    const d = c.data;
    if (!d) return 0;
    return (
      d.mesh.byteLength +
      d.transform.byteLength +
      d.colour.byteLength +
      d.colourClass.byteLength +
      d.level.byteLength +
      d.layer.byteLength +
      d.name.byteLength +
      d.element.byteLength +
      (c.aabb?.byteLength ?? 0)
    );
  }

  /** Forgets a chunk's data (it can be fetched again). */
  unload(c: Chunk): void {
    if (c.state === ChunkState.Loaded) {
      this.loadedInstances -= c.count;
      this.loadedChunks--;
      this.loadedBytes -= SceneStore.chunkBytes(c);
    }
    c.state = ChunkState.Absent;
    c.data = null;
    c.aabb = null;
    c.version++;
  }

  /** The world box of every loaded piece of a plan element, into `out`; false when none is loaded. */
  elementBox(elementId: string, out: Float32Array): boolean {
    out.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    let found = false;
    for (const c of this.chunks) {
      const d = c.data;
      const aabb = c.aabb;
      if (!d || !aabb) continue;
      const e = d.elements.indexOf(elementId);
      if (e < 0) continue;
      for (let k = 0; k < d.count; k++) {
        if (d.element[k] !== e) continue;
        found = true;
        for (let j = 0; j < 3; j++) {
          out[j] = Math.min(out[j] ?? Infinity, aabb[k * 6 + j] ?? 0);
          out[3 + j] = Math.max(out[3 + j] ?? -Infinity, aabb[k * 6 + 3 + j] ?? 0);
        }
      }
    }
    return found;
  }
}

/**
 * The world box of piece k: its mesh's own-frame bounds turned (scene3d: x' = x cos + z sin, z' = -x sin + z cos)
 * and moved.
 */
export function worldBox(
  meshBounds: Float32Array,
  data: InstanceChunk,
  k: number,
  out: Float32Array,
  o: number,
): void {
  const m = (data.mesh[k] ?? 0) * 6;
  const x0 = meshBounds[m] ?? 0;
  const y0 = meshBounds[m + 1] ?? 0;
  const z0 = meshBounds[m + 2] ?? 0;
  const x1 = meshBounds[m + 3] ?? 0;
  const y1 = meshBounds[m + 4] ?? 0;
  const z1 = meshBounds[m + 5] ?? 0;
  const tx = data.transform[k * 4] ?? 0;
  const ty = data.transform[k * 4 + 1] ?? 0;
  const tz = data.transform[k * 4 + 2] ?? 0;
  const t = ((data.transform[k * 4 + 3] ?? 0) * Math.PI) / 180;
  const cs = Math.round(Math.cos(t) * 1e12) / 1e12;
  const sn = Math.round(Math.sin(t) * 1e12) / 1e12;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let c = 0; c < 4; c++) {
    const lx = c & 1 ? x1 : x0;
    const lz = c & 2 ? z1 : z0;
    const wx = lx * cs + lz * sn;
    const wz = -lx * sn + lz * cs;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wz < minZ) minZ = wz;
    if (wz > maxZ) maxZ = wz;
  }
  out[o] = minX + tx;
  out[o + 1] = y0 + ty;
  out[o + 2] = minZ + tz;
  out[o + 3] = maxX + tx;
  out[o + 4] = y1 + ty;
  out[o + 5] = maxZ + tz;
}
