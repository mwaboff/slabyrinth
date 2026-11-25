/**
 * The frame planner: which chunks to draw, at which level of detail, as which draw calls. Pure (no GL): it reads the
 * store, the camera's frustum and eye, the filters, which meshes are resident, and asks a `ChunkBuffers` for each
 * visible chunk's packed buffers. Its output is a DrawList the GL backend executes as it is.
 *
 * Levels of detail, by how many pixels one tile covers at the chunk's nearest point (so the same rule serves any
 * window size and zoom):
 *  0 meshes — one instanced draw per mesh per chunk (a mesh not resident yet draws as boxes in the same range);
 *  1 boxes  — every piece of the chunk as its box, one draw;
 *  2 summary — the chunk's coarse boxes (pack.ts), one draw.
 * Chunks are taken nearest first; when the triangle or draw-call budget would be passed, further chunks drop a level
 * ("detail limited") instead of the frame growing. Pieces smaller than a pixel are skipped in the vertex shader.
 */
import { MeshState, type MeshResidency } from "./residency";
import { boxInFrustum, distanceToBox } from "./math";
import type { FilterMasks } from "./filters";
import type { PackedGroups } from "./pack";
import { ChunkState, type Chunk, type Region, type SceneStore } from "./store";

export const DRAW_MESH = 0;
export const DRAW_BOXES = 1;
export const DRAW_SUMMARY = 2;
export const BOX_TRIANGLES = 12;

export interface PlanBudgets {
  maxTriangles: number;
  maxDrawCalls: number;
  /** A chunk whose tile covers at least this many pixels draws its meshes. */
  meshPx: number;
  /** ... at least this many: boxes; below: its summary. */
  boxPx: number;
  /** A chunk smaller than this on screen (pixels across its box) is not drawn. */
  cullPx: number;
}

export const DEFAULT_BUDGETS: PlanBudgets = {
  maxTriangles: 3_000_000,
  maxDrawCalls: 1_500,
  meshPx: 7,
  boxPx: 1.25,
  cullPx: 1,
};

/** The level of detail for a chunk whose nearest point is `dist` away (pxK: pixels per tile at distance 1). */
export function chooseLod(dist: number, pxK: number, b: PlanBudgets): 0 | 1 | 2 {
  const px = pxK / Math.max(dist, 1e-3);
  return px >= b.meshPx ? 0 : px >= b.boxPx ? 1 : 2;
}

/** A packed chunk's GPU state as the planner needs it. */
export interface ChunkGpuView {
  buffer: number;
  groups: PackedGroups;
  records: number;
}

/**
 * The chunks' buffers. Each answer is the buffer, "later" (not built yet: this frame's packing time is spent; draw
 * again next frame) or "budget" (it cannot fit the GPU budget: draw a lighter level of detail).
 */
export interface ChunkBuffers {
  instances(chunk: Chunk): ChunkGpuView | "later" | "budget";
  /** Summary boxes of a region (all its loaded chunks) or of one chunk, one buffer. */
  summary(target: Region | Chunk): { buffer: number; records: number } | "later" | "budget";
}

/** Draw calls of one frame, in typed arrays reused from frame to frame. */
export class DrawList {
  kind = new Uint8Array(256);
  buffer = new Int32Array(256);
  mesh = new Int32Array(256);
  first = new Uint32Array(256);
  count = new Uint32Array(256);
  n = 0;
  triangles = 0;
  instances = 0;
  boxes = 0;
  chunksVisible = 0;
  readonly lodChunks = new Uint32Array(3);
  /** A budget made chunks drop a level this frame. */
  limited = false;
  /** Some visible chunk had no buffer yet (draw again next frame). */
  incomplete = false;
  /** Visible chunks whose data has not arrived (marked wanted). */
  missing = 0;

  reset(): void {
    this.missing = 0;
    this.n = 0;
    this.triangles = 0;
    this.instances = 0;
    this.boxes = 0;
    this.chunksVisible = 0;
    this.lodChunks.fill(0);
    this.limited = false;
    this.incomplete = false;
  }

  push(kind: number, buffer: number, mesh: number, first: number, count: number): void {
    if (count === 0) return;
    if (this.n === this.kind.length) this.grow();
    const i = this.n++;
    this.kind[i] = kind;
    this.buffer[i] = buffer;
    this.mesh[i] = mesh;
    this.first[i] = first;
    this.count[i] = count;
  }

  private grow(): void {
    const cap = this.kind.length * 2;
    const g = <T extends Uint8Array | Int32Array | Uint32Array>(a: T, make: (n: number) => T): T => {
      const b = make(cap);
      b.set(a);
      return b;
    };
    this.kind = g(this.kind, (c) => new Uint8Array(c));
    this.buffer = g(this.buffer, (c) => new Int32Array(c));
    this.mesh = g(this.mesh, (c) => new Int32Array(c));
    this.first = g(this.first, (c) => new Uint32Array(c));
    this.count = g(this.count, (c) => new Uint32Array(c));
  }
}

export interface PlanInput {
  store: SceneStore;
  residency: MeshResidency;
  masks: FilterMasks;
  frame: number;
  eye: { x: number; y: number; z: number };
  /** Frustum planes (math.frustumInto). */
  planes: Float64Array;
  /** Pixels one tile covers at distance 1 (viewport height / (2 tan(fov/2))). */
  pxK: number;
  budgets: PlanBudgets;
  buffers: ChunkBuffers;
}

/** Scratch for the visible-chunk sort, reused. */
export class PlanScratch {
  keys = new Float64Array(0);
  lod = new Uint8Array(0);
  dist = new Float32Array(0);
  idx = new Int32Array(0);
  ensure(n: number): void {
    if (this.keys.length >= n) return;
    const c = Math.max(n, this.keys.length * 2, 64);
    this.keys = new Float64Array(c);
    this.lod = new Uint8Array(c);
    this.dist = new Float32Array(c);
    this.idx = new Int32Array(c);
  }
}

/** Plans one frame into `out`. */
export function planFrame(p: PlanInput, out: DrawList, s: PlanScratch): void {
  out.reset();
  const { store, residency, masks, eye, budgets } = p;
  const chunks = store.chunks;
  s.ensure(chunks.length);
  let v = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c || c.count === 0) continue;
    if (masks.levelShown[c.level] !== 1) continue;
    if ((c.box[1] ?? 0) > masks.cutHeight) continue;
    if (!boxInFrustum(p.planes, c.box, 0)) continue;
    const d = distanceToBox(c.box, 0, eye.x, eye.y, eye.z);
    const across = Math.hypot(
      (c.box[3] ?? 0) - (c.box[0] ?? 0),
      (c.box[4] ?? 0) - (c.box[1] ?? 0),
      (c.box[5] ?? 0) - (c.box[2] ?? 0),
    );
    if ((across * p.pxK) / Math.max(d, 1e-3) < budgets.cullPx) continue;
    s.dist[v] = d;
    const lod = chooseLod(d, p.pxK, budgets);
    s.lod[v] = lod;
    if (lod < 2) {
      const r = store.regions[c.region];
      if (r) r.mixedFrame = p.frame;
    }
    s.idx[v] = i;
    // sort key: distance (1/64 tile steps) then slot
    s.keys[v] = Math.floor(d * 64) * 1_048_576 + v;
    v++;
  }
  // sort the whole scratch (unused slots last) rather than a subarray view: no allocation per frame
  const keys = s.keys;
  keys.fill(Infinity, v);
  keys.sort();
  out.chunksVisible = v;
  for (let k = 0; k < v; k++) {
    const slot = (keys[k] ?? 0) % 1_048_576;
    const c = chunks[s.idx[slot] ?? 0];
    if (!c) continue;
    const d = s.dist[slot] ?? 0;
    let lod = s.lod[slot] ?? 2;
    if (c.state !== ChunkState.Loaded) {
      // not fetched yet: the engine asks for wanted chunks, nearest first, after the frame
      c.wantFrame = p.frame;
      c.wantDist = d;
      out.missing++;
      continue;
    }
    let gpu: ChunkGpuView | "later" | "budget" | null = null;
    if (lod < 2) {
      gpu = p.buffers.instances(c);
      if (gpu === "later") {
        out.incomplete = true;
        continue;
      }
      if (gpu === "budget") {
        out.limited = true;
        lod = 2;
      }
    }
    if (lod === 0 && gpu !== null && gpu !== "budget") {
      // estimate with the meshes resident now
      const g = gpu.groups;
      let tris = g.boxOnlyEnd * BOX_TRIANGLES;
      let calls = g.boxOnlyEnd > 0 ? 1 : 0;
      for (let j = 0; j < g.groups; j++) {
        const m = g.mesh[j] ?? 0;
        const cnt = g.count[j] ?? 0;
        const resident = residency.state[m] === MeshState.Resident;
        tris += cnt * (resident ? (store.header.meshes[m]?.triangles ?? BOX_TRIANGLES) : BOX_TRIANGLES);
        calls++;
      }
      if (out.triangles + tris > budgets.maxTriangles || out.n + calls > budgets.maxDrawCalls) {
        out.limited = true;
        lod = 1;
      } else {
        out.lodChunks[0] = (out.lodChunks[0] ?? 0) + 1;
        out.push(DRAW_BOXES, gpu.buffer, -1, 0, g.boxOnlyEnd);
        let boxStart = -1;
        let boxEnd = -1;
        for (let j = 0; j < g.groups; j++) {
          const m = g.mesh[j] ?? 0;
          const first = g.first[j] ?? 0;
          const cnt = g.count[j] ?? 0;
          if (residency.want(m, d, p.frame)) {
            if (boxStart >= 0) out.push(DRAW_BOXES, gpu.buffer, -1, boxStart, boxEnd - boxStart);
            boxStart = -1;
            out.push(DRAW_MESH, gpu.buffer, m, first, cnt);
            out.triangles += cnt * (store.header.meshes[m]?.triangles ?? BOX_TRIANGLES);
          } else {
            if (boxStart < 0) boxStart = first;
            boxEnd = first + cnt;
            out.triangles += cnt * BOX_TRIANGLES;
            out.boxes += cnt;
          }
        }
        if (boxStart >= 0) out.push(DRAW_BOXES, gpu.buffer, -1, boxStart, boxEnd - boxStart);
        out.triangles += g.boxOnlyEnd * BOX_TRIANGLES;
        out.boxes += g.boxOnlyEnd;
        out.instances += gpu.records;
        continue;
      }
    }
    if (lod === 1 && gpu !== null && gpu !== "budget") {
      const tris = c.count * BOX_TRIANGLES;
      if (out.triangles + tris > budgets.maxTriangles || out.n + 1 > budgets.maxDrawCalls) {
        // falls through to the summary
        out.limited = true;
      } else {
        out.lodChunks[1] = (out.lodChunks[1] ?? 0) + 1;
        out.push(DRAW_BOXES, gpu.buffer, -1, 0, gpu.records);
        out.triangles += gpu.records * BOX_TRIANGLES;
        out.instances += gpu.records;
        out.boxes += gpu.records;
        continue;
      }
    }
    // far: the chunk's region, drawn once this frame for all its chunks; a region that also has nearer chunks in
    // detail draws its far chunks one by one (its summary would cover the detail)
    out.lodChunks[2] = (out.lodChunks[2] ?? 0) + 1;
    out.instances += c.count;
    const region = store.regions[c.region];
    if (!region) continue;
    const whole = region.mixedFrame !== p.frame;
    if (whole && region.drawnFrame === p.frame) continue;
    if (whole) region.drawnFrame = p.frame;
    if (out.n + 1 > budgets.maxDrawCalls) {
      out.limited = true;
      continue;
    }
    const sum = p.buffers.summary(whole ? region : c);
    if (sum === "later") {
      out.incomplete = true;
      if (whole) region.drawnFrame = 0;
      continue;
    }
    if (sum === "budget") {
      out.limited = true;
      continue;
    }
    out.push(DRAW_SUMMARY, sum.buffer, -1, 0, sum.records);
    out.triangles += sum.records * BOX_TRIANGLES;
  }
}
