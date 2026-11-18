/**
 * Read-only views used by the verify stage: resolved cells/edges of a level, and a spatial index of realized
 * placement boxes keyed by PLAN cell (all levels share the global plan grid, so stacked levels index together).
 */
import type { Box3, Placement, PlacementRole } from "../../contracts/compiler";
import type { LevelId, Side } from "../../contracts/plan";
import { CELL, CELL_FLAG, EDGE, type ResolvedLevel } from "../../contracts/resolved";

export interface CellView {
  inBounds: boolean;
  open: boolean;
  floor: boolean;
  /** Relative floor height (tiles). */
  height: number;
  flags: number;
  area: number;
}

export class LevelGrid {
  readonly w: number;
  readonly h: number;
  constructor(readonly L: ResolvedLevel) {
    this.w = L.bounds.w;
    this.h = L.bounds.h;
  }
  idx(x: number, y: number): number {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    return lx < 0 || ly < 0 || lx >= this.w || ly >= this.h ? -1 : ly * this.w + lx;
  }
  cell(x: number, y: number): CellView {
    const i = this.idx(x, y);
    if (i < 0) return { inBounds: false, open: false, floor: false, height: 0, flags: 0, area: 0 };
    const c = this.L.cells;
    const open = c.state[i] === CELL.OPEN;
    const flags = c.flags[i] ?? 0;
    return {
      inBounds: true,
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && (c.material[i] ?? 0) > 0,
      height: (c.height[i] ?? 0) / 4,
      flags,
      area: c.area[i] ?? 0,
    };
  }
  /** Walkable floor top (absolute y). */
  top(x: number, y: number): number {
    return this.L.elevation + this.cell(x, y).height + 0.5;
  }
  /** Edge on `side` of cell (x,y): grid, index, and whether that cell hosts the strip. */
  edge(
    x: number,
    y: number,
    side: Side,
  ): { kind: number; hostedHere: boolean; index: number; horizontal: boolean } {
    const L = this.L;
    const lx = x - L.bounds.x;
    const ly = y - L.bounds.y;
    let horizontal: boolean;
    let i: number;
    let hereIsSecond: boolean;
    if (side === "N" || side === "S") {
      horizontal = true;
      const ey = side === "N" ? ly : ly + 1;
      i = lx < 0 || lx >= this.w || ey < 0 || ey > this.h ? -1 : ey * this.w + lx;
      hereIsSecond = side === "N";
    } else {
      horizontal = false;
      const ex = side === "W" ? lx : lx + 1;
      i = ex < 0 || ex > this.w || ly < 0 || ly >= this.h ? -1 : ly * (this.w + 1) + ex;
      hereIsSecond = side === "W";
    }
    if (i < 0) return { kind: EDGE.NONE, hostedHere: false, index: -1, horizontal };
    const g = horizontal ? L.hEdges : L.vEdges;
    const kind = g.kind[i] ?? EDGE.NONE;
    const host = g.host[i] ?? 1;
    return {
      kind,
      hostedHere: (kind === EDGE.WALL || kind === EDGE.OPENING) && (host === 1) === hereIsSecond,
      index: i,
      horizontal,
    };
  }
}

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
