/**
 * Realize, level view: read-only cell and edge access to one resolved level in plan coordinates.
 * Reads: a ResolvedLevel. Writes: nothing.
 */
import type { Material, ThemeId } from "../../contracts/plan";
import { CELL, CELL_FLAG, type ResolvedLevel } from "../../contracts/resolved";

export interface CellInfo {
  open: boolean;
  floor: boolean;
  /** Relative floor height in tiles. */
  height: number;
  material: Material | null;
  theme: ThemeId;
  area: number;
  flags: number;
}

export class LevelView {
  readonly w: number;
  readonly h: number;
  constructor(
    readonly L: ResolvedLevel,
    readonly defaultTheme: ThemeId,
  ) {
    this.w = L.bounds.w;
    this.h = L.bounds.h;
  }
  inBounds(x: number, y: number): boolean {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    return lx >= 0 && ly >= 0 && lx < this.w && ly < this.h;
  }
  cell(x: number, y: number): CellInfo {
    if (!this.inBounds(x, y))
      return {
        open: false,
        floor: false,
        height: 0,
        material: null,
        theme: this.defaultTheme,
        area: 0,
        flags: 0,
      };
    const i = (y - this.L.bounds.y) * this.w + (x - this.L.bounds.x);
    const c = this.L.cells;
    const state = c.state[i] ?? CELL.VOID;
    const flags = c.flags[i] ?? 0;
    const mat = c.material[i] ?? 0;
    const open = state === CELL.OPEN;
    return {
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && mat > 0,
      height: (c.height[i] ?? 0) / 4,
      material: mat > 0 ? (this.L.materials[mat - 1] ?? null) : null,
      theme: this.L.themes[c.theme[i] ?? 0] ?? this.defaultTheme,
      area: c.area[i] ?? 0,
      flags,
    };
  }
  /** Horizontal edge = NORTH edge of cell (x, y); y may equal bounds.y + h (south border). */
  hEdge(x: number, y: number): number {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    if (lx < 0 || lx >= this.w || ly < 0 || ly > this.h) return -1;
    return ly * this.w + lx;
  }
  /** Vertical edge = WEST edge of cell (x, y); x may equal bounds.x + w (east border). */
  vEdge(x: number, y: number): number {
    const lx = x - this.L.bounds.x;
    const ly = y - this.L.bounds.y;
    if (lx < 0 || lx > this.w || ly < 0 || ly >= this.h) return -1;
    return ly * (this.w + 1) + lx;
  }
}
