/**
 * Which meshes live on the GPU. Meshes are asked for lazily (only when a chunk near enough to show detail uses them),
 * nearest first, a few at a time; each arrival is admitted under a byte budget by evicting the least recently drawn
 * meshes that this frame does not need. A mesh that cannot fit stays a box ("detail limited") until room frees up. The
 * decoded geometry is never kept on the JS side after upload, so the JS heap does not grow with detail.
 */

export const MeshState = {
  /** Not on the GPU, not asked for. */
  Absent: 0,
  Requested: 1,
  Resident: 2,
  /** The source could not give it: drawn as boxes for the rest of the session. */
  Failed: 3,
  /** A stand-in in the scene ("box" in the mesh table): never asked for. */
  BoxOnly: 4,
  /** Arrived but did not fit the budget: a box until room frees up. */
  OverBudget: 5,
} as const;

export interface ResidencyOptions {
  budgetBytes: number;
  /** Requests in flight at once (default 6). */
  maxInFlight?: number;
}

export class MeshResidency {
  readonly state: Uint8Array;
  readonly bytes: Float64Array;
  /** Frame the mesh was last drawn (resident) or wanted. */
  readonly lastUsed: Uint32Array;
  /** Nearest distance it was wanted at in `wantFrame`. */
  private readonly wantDist: Float32Array;
  private readonly wantFrame: Uint32Array;
  /** The meshes wanted this frame (scratch, reused). */
  private wanted: Int32Array;
  private wantedCount = 0;
  usedBytes = 0;
  inFlight = 0;
  budgetBytes: number;
  readonly maxInFlight: number;
  /** A mesh was refused for the budget since the last `clearLimited`. */
  limited = false;

  constructor(isBoxOnly: readonly boolean[], opts: ResidencyOptions) {
    const n = isBoxOnly.length;
    this.state = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (isBoxOnly[i]) this.state[i] = MeshState.BoxOnly;
    this.bytes = new Float64Array(n);
    this.lastUsed = new Uint32Array(n);
    this.wantDist = new Float32Array(n);
    this.wantFrame = new Uint32Array(n);
    this.wanted = new Int32Array(Math.min(Math.max(n, 1), 256));
    this.budgetBytes = opts.budgetBytes;
    this.maxInFlight = opts.maxInFlight ?? 6;
  }

  get count(): number {
    return this.state.length;
  }

  isResident(mesh: number): boolean {
    return this.state[mesh] === MeshState.Resident;
  }

  /**
   * A chunk at `dist` will draw `mesh` this frame: true when it can draw the real mesh now. Wanting an absent mesh
   * queues it for `takeRequests`.
   */
  want(mesh: number, dist: number, frame: number): boolean {
    const s = this.state[mesh];
    if (s === MeshState.Resident) {
      this.lastUsed[mesh] = frame;
      return true;
    }
    if (s !== MeshState.Absent) return false;
    if (this.wantFrame[mesh] !== frame) {
      this.wantFrame[mesh] = frame;
      this.wantDist[mesh] = dist;
      if (this.wantedCount === this.wanted.length) {
        const w = new Int32Array(this.wanted.length * 2);
        w.set(this.wanted);
        this.wanted = w;
      }
      this.wanted[this.wantedCount++] = mesh;
    } else if (dist < (this.wantDist[mesh] ?? Infinity)) this.wantDist[mesh] = dist;
    return false;
  }

  /**
   * The meshes to ask the source for now (nearest first, up to the free request slots), marked Requested. Writes them
   * to `out`; returns how many. Clears the frame's wanted list.
   */
  takeRequests(out: Int32Array): number {
    let n = 0;
    const free = Math.min(out.length, this.maxInFlight - this.inFlight);
    // selection of the `free` nearest: free is small (≤ maxInFlight), so repeated minimum scans
    for (let k = 0; k < free; k++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.wantedCount; i++) {
        const m = this.wanted[i] ?? -1;
        if (m < 0 || this.state[m] !== MeshState.Absent) continue;
        const d = this.wantDist[m] ?? Infinity;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      const m = this.wanted[best] ?? -1;
      this.wanted[best] = -1;
      this.state[m] = MeshState.Requested;
      this.inFlight++;
      out[n++] = m;
    }
    this.wantedCount = 0;
    return n;
  }

  /**
   * A requested mesh arrived needing `bytes`. Evicts least recently used meshes not used in `frame` until it fits;
   * returns the meshes to free on the GPU (written to `evicted`, count returned as `evictedCount`) and whether the
   * mesh may be uploaded. A refused mesh becomes OverBudget.
   */
  admit(
    mesh: number,
    bytes: number,
    frame: number,
    evicted: Int32Array,
  ): { ok: boolean; evictedCount: number } {
    if (this.state[mesh] === MeshState.Requested) this.inFlight = Math.max(0, this.inFlight - 1);
    let evictedCount = 0;
    while (this.usedBytes + bytes > this.budgetBytes) {
      let victim = -1;
      let oldest = Infinity;
      for (let i = 0; i < this.state.length; i++) {
        if (this.state[i] !== MeshState.Resident) continue;
        const used = this.lastUsed[i] ?? 0;
        if (used >= frame) continue; // drawn this frame: keep
        if (used < oldest) {
          oldest = used;
          victim = i;
        }
      }
      if (victim < 0 || evictedCount >= evicted.length) break;
      this.evict(victim);
      evicted[evictedCount++] = victim;
    }
    if (this.usedBytes + bytes > this.budgetBytes) {
      this.state[mesh] = MeshState.OverBudget;
      this.limited = true;
      return { ok: false, evictedCount };
    }
    this.state[mesh] = MeshState.Resident;
    this.bytes[mesh] = bytes;
    this.usedBytes += bytes;
    this.lastUsed[mesh] = frame;
    return { ok: true, evictedCount };
  }

  /** Frees a resident mesh's bytes (the caller deletes its GPU buffers). */
  evict(mesh: number): void {
    if (this.state[mesh] !== MeshState.Resident) return;
    this.usedBytes -= this.bytes[mesh] ?? 0;
    this.bytes[mesh] = 0;
    this.state[mesh] = MeshState.Absent;
  }

  /** The request failed: cancelled requests may be asked again, others stay boxes. */
  failed(mesh: number, retry: boolean): void {
    if (this.state[mesh] === MeshState.Requested) this.inFlight = Math.max(0, this.inFlight - 1);
    this.state[mesh] = retry ? MeshState.Absent : MeshState.Failed;
  }

  /** Meshes refused for the budget may try again once a quarter of the budget is free. */
  retryOverBudget(): void {
    if (this.usedBytes > this.budgetBytes * 0.75) return;
    for (let i = 0; i < this.state.length; i++)
      if (this.state[i] === MeshState.OverBudget) this.state[i] = MeshState.Absent;
  }

  /** Everything on the GPU is gone (context lost): resident and requested meshes become absent. */
  reset(): void {
    for (let i = 0; i < this.state.length; i++) {
      const s = this.state[i];
      if (s === MeshState.Resident || s === MeshState.Requested || s === MeshState.OverBudget)
        this.state[i] = MeshState.Absent;
    }
    this.bytes.fill(0);
    this.usedBytes = 0;
    this.inFlight = 0;
    this.wantedCount = 0;
  }

  residentCount(): number {
    let n = 0;
    for (let i = 0; i < this.state.length; i++) if (this.state[i] === MeshState.Resident) n++;
    return n;
  }

  /** Meshes that can have detail (not stand-ins). */
  detailCount(): number {
    let n = 0;
    for (let i = 0; i < this.state.length; i++) if (this.state[i] !== MeshState.BoxOnly) n++;
    return n;
  }
}
