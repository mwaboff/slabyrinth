/**
 * Which pieces stand where in plan: a hash of plan squares over the pieces' boxes, so a question about a rectangle
 * looks only at the pieces near it, never every piece. The checks' space (checks/space.ts) and the shot planner's
 * probes (shots/planner.ts) share it.
 *
 * A question marks each piece it has seen with the question's stamp (one number per piece, kept between questions),
 * so a piece under several squares is visited once without a set or a sort per question: a map of 1024 x 1024 tiles
 * asks millions of them.
 */
import type { Box3 } from "../types/index";

/** Side of a hash square in plan, tiles. */
const HASH = 2;

const key = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

export class PlanHash {
  private readonly squares = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private mark = 0;
  private busy = false;

  constructor(
    readonly boxes: readonly Box3[],
    /** Pieces left out of every question. */
    keep: (idx: number) => boolean = () => true,
  ) {
    this.stamp = new Uint32Array(boxes.length);
    boxes.forEach((b, idx) => {
      if (!keep(idx)) return;
      for (let i = Math.floor(b.min.x / HASH); i <= Math.floor(b.max.x / HASH); i++)
        for (let j = Math.floor(b.min.z / HASH); j <= Math.floor(b.max.z / HASH); j++) {
          const k = key(i, j);
          let l = this.squares.get(k);
          if (!l) this.squares.set(k, (l = []));
          l.push(idx);
        }
    });
  }

  /**
   * Calls `visit` once for each piece whose box meets the plan rectangle, in no promised order, allocating nothing.
   * `visit` must not ask this hash another question (use `near` for that).
   */
  each(minX: number, maxX: number, minZ: number, maxZ: number, visit: (idx: number) => void): void {
    if (this.busy) throw new Error("PlanHash.each: a question inside a question");
    this.busy = true;
    try {
      if (++this.mark === 0xffffffff) {
        this.stamp.fill(0);
        this.mark = 1;
      }
      const m = this.mark;
      for (let i = Math.floor(minX / HASH); i <= Math.floor(maxX / HASH); i++)
        for (let j = Math.floor(minZ / HASH); j <= Math.floor(maxZ / HASH); j++) {
          const l = this.squares.get(key(i, j));
          if (!l) continue;
          for (const idx of l) {
            if (this.stamp[idx] === m) continue;
            this.stamp[idx] = m;
            const b = this.boxes[idx];
            if (b && b.max.x >= minX && b.min.x <= maxX && b.max.z >= minZ && b.min.z <= maxZ) visit(idx);
          }
        }
    } finally {
      this.busy = false;
    }
  }

  /** The pieces whose box meets the plan rectangle, each once, in index order. */
  near(minX: number, maxX: number, minZ: number, maxZ: number): number[] {
    const out: number[] = [];
    this.each(minX, maxX, minZ, maxZ, (idx) => out.push(idx));
    return out.sort((a, b) => a - b);
  }
}
