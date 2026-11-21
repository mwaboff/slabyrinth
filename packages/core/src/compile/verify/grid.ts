/**
 * The verify stage's spatial index of realized placement boxes, keyed by PLAN cell (all levels share the global plan
 * grid, so stacked levels index together). The resolved cells and edges it checks against are read through the level
 * grid (resolve/levelGrid.ts LevelGrid), as realize reads them.
 */
import type { Box3, Placement, PlacementRole } from "../../contracts/compiler";
import type { LevelId } from "../../contracts/plan";

export interface Solid {
  p: Placement;
  box: Box3;
  levelId: LevelId;
  role: PlacementRole;
  name: string;
  /** Feature that blocks movement (from the resolved feature), or a non-feature solid. */
  blocking: boolean;
  /** Organic scatter/dress prop (rotation inherit): overlaps are expected-ish. */
  organic: boolean;
  wallMounted: boolean;
  isTileFeature: boolean;
}

/** Spatial index keyed by plan cell "x,y"; boxes are world-space (x east, z north). */
export class SolidIndex {
  private readonly cells = new Map<string, Solid[]>();
  readonly all: Solid[] = [];
  constructor(
    readonly hg: number,
    readonly flipZ: boolean,
  ) {}
  /** World (x,z) → plan (px,py). */
  toPlan(x: number, z: number): { px: number; py: number } {
    return { px: x, py: this.flipZ ? this.hg - z : z };
  }
  toWorld(px: number, py: number): { x: number; z: number } {
    return { x: px, z: this.flipZ ? this.hg - py : py };
  }
  private cellsOf(b: Box3): Array<[number, number]> {
    const e = 0.01;
    const a = this.toPlan(b.min.x + e, b.min.z + e);
    const c = this.toPlan(b.max.x - e, b.max.z - e);
    const x0 = Math.floor(Math.min(a.px, c.px));
    const x1 = Math.floor(Math.max(a.px, c.px));
    const y0 = Math.floor(Math.min(a.py, c.py));
    const y1 = Math.floor(Math.max(a.py, c.py));
    const out: Array<[number, number]> = [];
    if (!Number.isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > 400) return out;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
    return out;
  }
  add(s: Solid): void {
    this.all.push(s);
    for (const [x, y] of this.cellsOf(s.box)) {
      const k = `${x},${y}`;
      const arr = this.cells.get(k);
      if (arr) arr.push(s);
      else this.cells.set(k, [s]);
    }
  }
  remove(s: Solid): void {
    for (const [x, y] of this.cellsOf(s.box)) {
      const arr = this.cells.get(`${x},${y}`);
      if (arr) {
        const i = arr.indexOf(s);
        if (i >= 0) arr.splice(i, 1);
      }
    }
    const i = this.all.indexOf(s);
    if (i >= 0) this.all.splice(i, 1);
  }
  /** Every solid indexed in any cell the box covers (grown by `grow` tiles). */
  overlapping(b: Box3, grow = 0.05): Solid[] {
    const g = {
      min: { x: b.min.x - grow, y: b.min.y, z: b.min.z - grow },
      max: { x: b.max.x + grow, y: b.max.y, z: b.max.z + grow },
    };
    const set = new Set<Solid>();
    for (const [x, y] of this.cellsOf(g)) for (const s of this.cells.get(`${x},${y}`) ?? []) set.add(s);
    return [...set];
  }
  near(px: number, py: number): Solid[] {
    return this.cells.get(`${Math.floor(px)},${Math.floor(py)}`) ?? [];
  }
  /** Solids containing world point (x,z) strictly (margin m) and overlapping [y0,y1]. */
  at(x: number, z: number, y0: number, y1: number, m = 0.02): Solid[] {
    // candidates from the point's cell, plus the neighbours when the point lies within 0.03 of a cell seam
    const { px, py } = this.toPlan(x, z);
    const fx = px - Math.floor(px);
    const fy = py - Math.floor(py);
    let cand: Solid[] = this.near(px, py);
    if (fx < 0.03 || fx > 0.97 || fy < 0.03 || fy > 0.97) {
      const set = new Set<Solid>(cand);
      for (const dx of [-0.03, 0.03])
        for (const dy of [-0.03, 0.03]) for (const s of this.near(px + dx, py + dy)) set.add(s);
      cand = [...set];
    }
    return cand.filter(
      (s) =>
        s.box.min.x < x - m &&
        s.box.max.x > x + m &&
        s.box.min.z < z - m &&
        s.box.max.z > z + m &&
        s.box.max.y > y0 &&
        s.box.min.y < y1,
    );
  }
}

export function overlap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
