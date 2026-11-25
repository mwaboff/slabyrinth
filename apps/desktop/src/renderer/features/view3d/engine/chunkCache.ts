/**
 * The chunks' GPU buffers: built lazily the first time a chunk is drawn (packing has a time allowance per frame, so a
 * huge map fills in over a few frames instead of freezing one), rebuilt when more instances stream into a chunk or the
 * filters change its summary, and evicted least recently drawn first when their bytes pass the budget. A chunk that
 * cannot fit is drawn as its (small) summary instead.
 */
import type { RenderBackend } from "./backend";
import type { FilterMasks } from "./filters";
import { INSTANCE_STRIDE, PackScratch, packChunk, packSummary, type PackedGroups } from "./pack";
import type { ChunkBuffers, ChunkGpuView } from "./plan";
import type { Chunk, Region, SceneStore } from "./store";

interface InstRec extends ChunkGpuView {
  version: number;
  bytes: number;
  lastUsed: number;
}

interface SumRec {
  buffer: number;
  records: number;
  version: number;
  filterVersion: number;
  bytes: number;
  lastUsed: number;
}

export type BufferAnswer<T> = T | "later" | "budget";

export class ChunkCache implements ChunkBuffers {
  private inst: (InstRec | undefined)[] = [];
  private sum: (SumRec | undefined)[] = [];
  private readonly scratch = new PackScratch();
  bytes = 0;
  private frame = 0;
  private deadline = Infinity;
  private masks: FilterMasks | null = null;
  private filterVersion = 0;
  /** Chunks packed this frame (stats). */
  packedThisFrame = 0;

  constructor(
    private readonly store: SceneStore,
    private readonly backend: RenderBackend,
    public budgetBytes: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Starts a frame: packing may run until `deadline` (a `now()` time). */
  beginFrame(frame: number, deadline: number, masks: FilterMasks, filterVersion: number): void {
    this.frame = frame;
    this.deadline = deadline;
    this.masks = masks;
    this.filterVersion = filterVersion;
    this.packedThisFrame = 0;
  }

  private outOfTime(): boolean {
    // the first chunk of a frame is always allowed, so progress never stalls
    return this.packedThisFrame > 0 && this.now() > this.deadline;
  }

  /** Frees least recently drawn buffers (not drawn this frame) until `need` more bytes fit. */
  private makeRoom(need: number): boolean {
    while (this.bytes + need > this.budgetBytes) {
      let victim = -1;
      let isSum = false;
      let oldest = Infinity;
      for (let i = 0; i < this.inst.length; i++) {
        const r = this.inst[i];
        if (r && r.lastUsed < this.frame && r.lastUsed < oldest) {
          oldest = r.lastUsed;
          victim = i;
          isSum = false;
        }
      }
      for (let i = 0; i < this.sum.length; i++) {
        const r = this.sum[i];
        if (r && r.lastUsed < this.frame && r.lastUsed < oldest) {
          oldest = r.lastUsed;
          victim = i;
          isSum = true;
        }
      }
      if (victim < 0) return false;
      if (isSum) this.dropSummary(victim);
      else this.dropInstances(victim);
    }
    return true;
  }

  private dropInstances(i: number): void {
    const r = this.inst[i];
    if (!r) return;
    this.backend.deleteInstanceBuffer(r.buffer);
    this.bytes -= r.bytes;
    this.inst[i] = undefined;
  }

  private dropSummary(i: number): void {
    const r = this.sum[i];
    if (!r) return;
    this.backend.deleteInstanceBuffer(r.buffer);
    this.bytes -= r.bytes;
    this.sum[i] = undefined;
  }

  instances(chunk: Chunk): BufferAnswer<ChunkGpuView> {
    const r = this.inst[chunk.index];
    if (r && (r.version === chunk.version || this.outOfTime())) {
      r.lastUsed = this.frame;
      return r;
    }
    if (this.outOfTime()) return "later";
    const need = chunk.count * INSTANCE_STRIDE;
    if (r) this.dropInstances(chunk.index);
    if (!this.makeRoom(need)) return "budget";
    const groups: PackedGroups = packChunk(this.store, chunk, this.scratch);
    const buffer = this.backend.createInstanceBuffer(this.scratch.bytes, need);
    const rec: InstRec = {
      buffer,
      groups,
      records: chunk.count,
      version: chunk.version,
      bytes: need,
      lastUsed: this.frame,
    };
    this.inst[chunk.index] = rec;
    this.bytes += need;
    this.packedThisFrame++;
    return rec;
  }

  /**
   * Summary boxes in one buffer: of every loaded chunk of a region (a region wholly far away), or of one chunk (a far
   * chunk in a region that also has nearer chunks drawn in detail).
   */
  summary(target: Region | Chunk): BufferAnswer<{ buffer: number; records: number }> {
    const list = "chunks" in target ? target.chunks : [target];
    // regions and chunks share one table: regions after the chunks
    const key = "chunks" in target ? this.store.chunks.length + target.index : target.index;
    let version = 0;
    for (const c of list) version += c.version;
    const r = this.sum[key];
    if (r && ((r.version === version && r.filterVersion === this.filterVersion) || this.outOfTime())) {
      r.lastUsed = this.frame;
      return r;
    }
    if (this.outOfTime() || !this.masks) return "later";
    if (r) this.dropSummary(key);
    let records = 0;
    for (const c of list) records += packSummary(this.store, c, this.masks, this.scratch, records);
    const need = Math.max(records, 1) * INSTANCE_STRIDE;
    if (!this.makeRoom(need)) return "budget";
    const buffer = this.backend.createInstanceBuffer(this.scratch.bytes, need);
    const rec: SumRec = {
      buffer,
      records,
      version,
      filterVersion: this.filterVersion,
      bytes: need,
      lastUsed: this.frame,
    };
    this.sum[key] = rec;
    this.bytes += need;
    this.packedThisFrame++;
    return rec;
  }

  /** The GPU lost every buffer: forget them without deleting. */
  forget(): void {
    this.inst = [];
    this.sum = [];
    this.bytes = 0;
  }

  dispose(): void {
    for (let i = 0; i < this.inst.length; i++) this.dropInstances(i);
    for (let i = 0; i < this.sum.length; i++) this.dropSummary(i);
    this.forget();
  }
}
