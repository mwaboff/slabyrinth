/**
 * Packing a chunk into the one GPU instance layout every draw reads (INSTANCE_STRIDE bytes each): place (x, y, z,
 * turnDeg), box (min xyz, max xyz in the mesh's own frame: a box stand-in is the unit cube stretched over it, then
 * turned and moved like the mesh), colour (rgba8), flags (u32), id (u32). A chunk's pieces are sorted by mesh so
 * each mesh is one contiguous range (one instanced draw per mesh per chunk), stand-ins first so all of a chunk's
 * box-only pieces are one draw.
 *
 * The far level of detail is a chunk summary: the chunk cut into SUMMARY_CELL-tile cells, each one world box round
 * the shown pieces in it, coloured as its tallest piece (what one sees from above); at most 64 boxes per chunk.
 */
import { pieceFlags, pieceHidden, type FilterMasks } from "./filters";
import type { Chunk, SceneStore } from "./store";

export const INSTANCE_STRIDE = 52;
export const OFF_PLACE = 0;
export const OFF_MIN = 16;
export const OFF_MAX = 28;
export const OFF_COLOUR = 40;
export const OFF_FLAGS = 44;
export const OFF_ID = 48;
export const SUMMARY_CELL = 4;
const CHUNK_TILES = 32;
const CELLS = CHUNK_TILES / SUMMARY_CELL;
/** Summary boxes carry ids from here up (never a piece id), so outlines still separate them. */
export const SUMMARY_ID_BASE = 0x80000000;

/** A growable byte buffer with float and int views, reused across packs. */
export class PackScratch {
  bytes = new Uint8Array(0);
  f32 = new Float32Array(0);
  u32 = new Uint32Array(0);
  ensure(records: number): void {
    const need = records * INSTANCE_STRIDE;
    if (this.bytes.byteLength >= need) return;
    const buf = new ArrayBuffer(Math.max(need, this.bytes.byteLength * 2, 4096));
    this.bytes = new Uint8Array(buf);
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
  }
}

/** The mesh ranges of a packed chunk. */
export interface PackedGroups {
  /** Records [0, boxOnlyEnd) use stand-in meshes (always boxes, one draw). */
  boxOnlyEnd: number;
  /** Per mesh group after the stand-ins: mesh index, first record, record count. */
  mesh: Uint32Array;
  first: Uint32Array;
  count: Uint32Array;
  groups: number;
}

/** Packs a loaded chunk's pieces into `s`, grouped by mesh. */
export function packChunk(store: SceneStore, chunk: Chunk, s: PackScratch): PackedGroups {
  const d = chunk.data;
  const n = d ? d.count : 0;
  s.ensure(n);
  const out: PackedGroups = {
    boxOnlyEnd: 0,
    mesh: new Uint32Array(0),
    first: new Uint32Array(0),
    count: new Uint32Array(0),
    groups: 0,
  };
  if (!d) return out;
  // counting sort by bucket: 0 = stand-ins, m + 1 = mesh m
  const buckets = new Map<number, number>();
  const bucketOf = (k: number): number => {
    const m = d.mesh[k] ?? 0;
    return store.boxOnly[m] === 1 ? 0 : m + 1;
  };
  for (let k = 0; k < n; k++) {
    const b = bucketOf(k);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const order = [...buckets.keys()].sort((a, b) => a - b);
  const start = new Map<number, number>();
  let acc = 0;
  for (const b of order) {
    start.set(b, acc);
    acc += buckets.get(b) ?? 0;
  }
  out.boxOnlyEnd = buckets.get(0) ?? 0;
  const meshBuckets = order.filter((b) => b > 0);
  out.groups = meshBuckets.length;
  out.mesh = Uint32Array.from(meshBuckets, (b) => b - 1);
  out.first = Uint32Array.from(meshBuckets, (b) => start.get(b) ?? 0);
  out.count = Uint32Array.from(meshBuckets, (b) => buckets.get(b) ?? 0);
  for (let k = 0; k < n; k++) {
    const b = bucketOf(k);
    const r = start.get(b) ?? 0;
    start.set(b, r + 1);
    const f = (r * INSTANCE_STRIDE) / 4;
    for (let j = 0; j < 4; j++) s.f32[f + j] = d.transform[k * 4 + j] ?? 0;
    const m = (d.mesh[k] ?? 0) * 6;
    for (let j = 0; j < 6; j++) s.f32[f + 4 + j] = store.meshBounds[m + j] ?? 0;
    const c = r * INSTANCE_STRIDE + OFF_COLOUR;
    s.bytes[c] = d.colour[k * 3] ?? 0;
    s.bytes[c + 1] = d.colour[k * 3 + 1] ?? 0;
    s.bytes[c + 2] = d.colour[k * 3 + 2] ?? 0;
    s.bytes[c + 3] = 255;
    s.u32[f + 11] = pieceFlags(store, chunk, k);
    s.u32[f + 12] = chunk.base + k;
  }
  return out;
}

/** Packs a loaded chunk's summary boxes into `s`; returns how many. Pieces hidden by the masks are left out. */
export function packSummary(
  store: SceneStore,
  chunk: Chunk,
  masks: FilterMasks,
  s: PackScratch,
  /** First record to write (summaries of a region's chunks go one after another). */
  at = 0,
): number {
  const d = chunk.data;
  const aabb = chunk.aabb;
  if (!d || !aabb) return 0;
  const cells = CELLS * CELLS;
  s.ensure(at + cells);
  const box = new Float32Array(cells * 6);
  const rep = new Int32Array(cells).fill(-1);
  const top = new Float32Array(cells).fill(-Infinity);
  const x0 = chunk.box[0] ?? 0;
  const z0 = chunk.box[2] ?? 0;
  for (let k = 0; k < d.count; k++) {
    if (pieceHidden(store, chunk, k, masks)) continue;
    const a = k * 6;
    const cx = ((aabb[a] ?? 0) + (aabb[a + 3] ?? 0)) / 2;
    const cz = ((aabb[a + 2] ?? 0) + (aabb[a + 5] ?? 0)) / 2;
    const gx = Math.min(CELLS - 1, Math.max(0, Math.floor((cx - x0) / SUMMARY_CELL)));
    const gz = Math.min(CELLS - 1, Math.max(0, Math.floor((cz - z0) / SUMMARY_CELL)));
    const c = gz * CELLS + gx;
    const b = c * 6;
    if ((rep[c] ?? -1) < 0) for (let j = 0; j < 6; j++) box[b + j] = aabb[a + j] ?? 0;
    else
      for (let j = 0; j < 3; j++) {
        box[b + j] = Math.min(box[b + j] ?? 0, aabb[a + j] ?? 0);
        box[b + 3 + j] = Math.max(box[b + 3 + j] ?? 0, aabb[a + 3 + j] ?? 0);
      }
    const t = aabb[a + 4] ?? 0;
    if (t > (top[c] ?? -Infinity)) {
      top[c] = t;
      rep[c] = k;
    }
  }
  let n = 0;
  for (let c = 0; c < cells; c++) {
    const k = rep[c] ?? -1;
    if (k < 0) continue;
    const f = ((at + n) * INSTANCE_STRIDE) / 4;
    // placed at the origin, unturned: the box is the world box
    s.f32[f] = 0;
    s.f32[f + 1] = 0;
    s.f32[f + 2] = 0;
    s.f32[f + 3] = 0;
    for (let j = 0; j < 6; j++) s.f32[f + 4 + j] = box[c * 6 + j] ?? 0;
    const o = (at + n) * INSTANCE_STRIDE + OFF_COLOUR;
    s.bytes[o] = d.colour[k * 3] ?? 0;
    s.bytes[o + 1] = d.colour[k * 3 + 1] ?? 0;
    s.bytes[o + 2] = d.colour[k * 3 + 2] ?? 0;
    s.bytes[o + 3] = 255;
    // hidden roofs were left out above, so the box itself never hides as a roof
    s.u32[f + 11] = pieceFlags(store, chunk, k) & ~(1 << 8);
    s.u32[f + 12] = (SUMMARY_ID_BASE + chunk.index * cells + c) >>> 0;
    n++;
  }
  return n;
}
