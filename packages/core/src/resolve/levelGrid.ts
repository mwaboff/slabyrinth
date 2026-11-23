/**
 * Reading a level's grid: the one place that knows how a level's cells and edges are indexed (the layout is the
 * resolved contract's, contracts/resolved.ts `EdgeGrid`), and the questions every stage asks of a resolved level.
 *
 * Two layers:
 *  - Index arithmetic over a grid of w x h cells in LOCAL coordinates (lx = x - bounds.x, ly = y - bounds.y). Plain
 *    functions over the grid's size, no allocation: the resolver's writable grid (resolve/level/grid.ts `ResolveGrid`)
 *    and every reader that loops over a level in local coordinates (the wall-height passes, the shell planner, the
 *    review's cave measures, the 2D display list, playability) index with these.
 *  - `LevelGrid`: a read-only view of one ResolvedLevel in PLAN coordinates (the realize passes, verify, the review's
 *    interior notes): in-bounds, cell index, the cell as the build reads it, the edge on a side of a cell, whether a wall
 *    stands there and which cell holds its strip.
 *
 * Why two grids and not one: `ResolveGrid` owns the typed arrays every resolve stage writes in turn and exists only while
 * a level resolves; `LevelGrid` reads the contract's arrays once the level is final, and must never write them. They
 * share the arithmetic below, so an index means the same in both. The generators' own vocabulary (sides, steps,
 * opposite sides, edge kinds and cell flags as numbers) is gen/gridGeometry.ts, which this module reads; edge kinds and
 * flags are the contract's `EDGE` and `CELL_FLAG` either way.
 *
 * Edge layout (contracts/resolved.ts): horizontal edges ("h") are w x (h+1), index ly*w + lx is the NORTH edge of
 * (lx, ly), ly == h is the south border; vertical edges ("v") are (w+1) x h, index ly*(w+1) + lx is the WEST edge of
 * (lx, ly), lx == w is the east border. A side of a cell names one of them: N and S are horizontal, W and E vertical.
 * Every index function returns -1 outside the grid. The lint rule in eslint.config.js rejects the vertical stride
 * `(w + 1)` anywhere else in packages/core/src, so no reader computes an edge index by hand again.
 */
import type { Side, ThemeId, Material } from "../contracts/plan";
import { CELL, CELL_FLAG, EDGE, type EdgeGrid, type ResolvedLevel } from "../contracts/resolved";
import { GENERIC_THEME } from "../palette/resolve";

/**
 * Is an area (a resolved one, or the resolver's AreaInfo) part of a building's ground storey: the building's own area,
 * or (generator 5, `buildingRooms`) a room it is split into? Ask this, not `kind === "building"`, of a cell's area.
 */
export function partOfBuilding(a: {
  readonly kind: string;
  readonly building?: string | undefined;
}): boolean {
  return a.kind === "building" || a.building !== undefined;
}

/** A cell whose unhosted part is narrower than this (either way) has no free centre (`LevelGrid.freeCentre`). */
export const MIN_FREE_SPAN = 0.2;

/** A grid's size in cells (a ResolvedLevel's `bounds`, a ResolveGrid). */
export interface GridSize {
  readonly w: number;
  readonly h: number;
}

/** Which edge grid: "h" = horizontal edges (the N and S sides of cells), "v" = vertical edges (W and E). */
export type EdgeOrient = "h" | "v";

/** The edge grid a side of a cell lies in. */
export const sideOrient = (side: Side): EdgeOrient => (side === "N" || side === "S" ? "h" : "v");

// ───────────────────────────── index arithmetic (local coordinates) ─────────────────────────────

/** How many edges one orientation has: w x (h+1) horizontal, (w+1) x h vertical. */
export const edgeCount = (g: GridSize, orient: EdgeOrient): number =>
  orient === "h" ? g.w * (g.h + 1) : (g.w + 1) * g.h;

/** Index of cell (lx, ly), -1 outside the grid. */
export function cellIndex(g: GridSize, lx: number, ly: number): number {
  return lx < 0 || ly < 0 || lx >= g.w || ly >= g.h ? -1 : ly * g.w + lx;
}

/** Index of the horizontal edge north of cell (lx, ly) (ly == h: the south border), -1 outside. */
export function hEdgeIndex(g: GridSize, lx: number, ly: number): number {
  return lx < 0 || lx >= g.w || ly < 0 || ly > g.h ? -1 : ly * g.w + lx;
}

/** Index of the vertical edge west of cell (lx, ly) (lx == w: the east border), -1 outside. */
export function vEdgeIndex(g: GridSize, lx: number, ly: number): number {
  return lx < 0 || lx > g.w || ly < 0 || ly >= g.h ? -1 : ly * (g.w + 1) + lx;
}

/** Index of the edge of one grid whose cell (the one it is the N or W edge of) is (lx, ly), -1 outside. */
export function edgeIndex(g: GridSize, orient: EdgeOrient, lx: number, ly: number): number {
  return orient === "h" ? hEdgeIndex(g, lx, ly) : vEdgeIndex(g, lx, ly);
}

/** Index (in the side's grid, `sideOrient`) of the edge on `side` of cell (lx, ly), -1 outside. */
export function sideEdgeIndex(g: GridSize, lx: number, ly: number, side: Side): number {
  switch (side) {
    case "N":
      return hEdgeIndex(g, lx, ly);
    case "S":
      return hEdgeIndex(g, lx, ly + 1);
    case "W":
      return vEdgeIndex(g, lx, ly);
    case "E":
      return vEdgeIndex(g, lx + 1, ly);
  }
}

/**
 * Edges as lines: an orientation's edges lie on `edgeLines` lines (rows of h edges, columns of v edges), each
 * `edgeLineLength` long; `edgeOnLine` is the edge at position `pos` along line `line` (h: row line, column pos; v: column
 * line, row pos). For passes that walk the edges in runs.
 */
export const edgeLines = (g: GridSize, orient: EdgeOrient): number => (orient === "h" ? g.h + 1 : g.w + 1);
export const edgeLineLength = (g: GridSize, orient: EdgeOrient): number => (orient === "h" ? g.w : g.h);
export function edgeOnLine(g: GridSize, orient: EdgeOrient, line: number, pos: number): number {
  return orient === "h" ? hEdgeIndex(g, pos, line) : vEdgeIndex(g, line, pos);
}

/** Local column of edge `i`: the x of the cell it is the N (h) or W (v) edge of, which is also its start vertex. */
export function edgeCol(g: GridSize, orient: EdgeOrient, i: number): number {
  return orient === "h" ? i % g.w : i % (g.w + 1);
}

/** Local row of edge `i` (see `edgeCol`). */
export function edgeRow(g: GridSize, orient: EdgeOrient, i: number): number {
  const stride = orient === "h" ? g.w : g.w + 1;
  return (i - (i % stride)) / stride;
}

/** The first cell of edge `i` (north of an h edge, west of a v edge) as a cell index, -1 outside the grid. */
export function edgeFirstCell(g: GridSize, orient: EdgeOrient, i: number): number {
  const lx = edgeCol(g, orient, i);
  const ly = edgeRow(g, orient, i);
  return orient === "h" ? cellIndex(g, lx, ly - 1) : cellIndex(g, lx - 1, ly);
}

/** The second cell of edge `i` (south of an h edge, east of a v edge) as a cell index, -1 outside the grid. */
export function edgeSecondCell(g: GridSize, orient: EdgeOrient, i: number): number {
  return cellIndex(g, edgeCol(g, orient, i), edgeRow(g, orient, i));
}

// ───────────────────────────── a resolved level, read-only (plan coordinates) ─────────────────────────────

/** One cell of a resolved level as the build reads it. Outside the level: not open, no floor, height 0. */
export interface LevelCell {
  inBounds: boolean;
  open: boolean;
  /** Open, with floor (no NO_FLOOR flag) and a floor material. */
  floor: boolean;
  /** Floor height relative to the level's elevation, in tiles. */
  height: number;
  material: Material | null;
  /** The cell's effective theme; the grid's default theme outside the level. */
  theme: ThemeId;
  /** Display area index + 1 (0 = none). */
  area: number;
  flags: number;
}

/**
 * The theme of a resolved level's cell `i` (a local index; `fallback` for a cell with none): the one theme reader of a
 * resolved level, as ResolveGrid.themeAt is while it resolves.
 */
export function cellTheme(level: ResolvedLevel, i: number, fallback: ThemeId): ThemeId {
  return level.themes[(i >= 0 ? level.cells.theme[i] : 0) ?? 0] ?? fallback;
}

/**
 * The theme a resolved element (a feature, a link, an opening) is built in: its own, or, when it has none (`""`, the
 * resolver's "inherit"), the theme of where it stands (`inherited`: its anchor cell's, an opening's wall face's). The
 * one reader of that convention: the realize passes, verify and the review ask it.
 */
export function elementTheme(own: ThemeId, inherited: ThemeId): ThemeId {
  return own === "" ? inherited : own;
}

/**
 * The theme a resolved element anchored at plan cell `at` of `level` is built in: its own, else that cell's
 * (`elementTheme` over `cellTheme`; `fallback` for a cell with none). For readers that hold the level, not a LevelGrid.
 */
export function elementThemeAt(
  own: ThemeId,
  level: ResolvedLevel,
  at: readonly [number, number],
  fallback: ThemeId,
): ThemeId {
  const i = cellIndex(level.bounds, at[0] - level.bounds.x, at[1] - level.bounds.y);
  return elementTheme(own, cellTheme(level, i, fallback));
}

export class LevelGrid implements GridSize {
  /** Plan coordinates of the level's first cell. */
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;

  /**
   * `defaultTheme` is the theme of a cell outside the level or without one (the realizer's palette fallback; readers
   * that never ask a cell's theme keep "generic").
   */
  constructor(
    readonly level: ResolvedLevel,
    readonly defaultTheme: ThemeId = GENERIC_THEME,
  ) {
    this.x0 = level.bounds.x;
    this.y0 = level.bounds.y;
    this.w = level.bounds.w;
    this.h = level.bounds.h;
  }

  inBounds(x: number, y: number): boolean {
    return cellIndex(this, x - this.x0, y - this.y0) >= 0;
  }

  /** Cell index of (x, y), -1 outside the level. */
  index(x: number, y: number): number {
    return cellIndex(this, x - this.x0, y - this.y0);
  }

  /** The edges of one orientation. */
  edges(orient: EdgeOrient): EdgeGrid {
    return orient === "h" ? this.level.hEdges : this.level.vEdges;
  }

  /** Horizontal edge north of cell (x, y); y may be the row below the level (its south border). -1 outside. */
  hEdge(x: number, y: number): number {
    return hEdgeIndex(this, x - this.x0, y - this.y0);
  }

  /** Vertical edge west of cell (x, y); x may be the column right of the level (its east border). -1 outside. */
  vEdge(x: number, y: number): number {
    return vEdgeIndex(this, x - this.x0, y - this.y0);
  }

  /** Index (into `edges(sideOrient(side))`) of the edge on `side` of cell (x, y), -1 outside. */
  edgeIndex(x: number, y: number, side: Side): number {
    return sideEdgeIndex(this, x - this.x0, y - this.y0, side);
  }

  /** Kind (EDGE) of the edge on `side` of cell (x, y); NONE outside the level. */
  edgeKind(x: number, y: number, side: Side): number {
    const i = this.edgeIndex(x, y, side);
    return i < 0 ? EDGE.NONE : (this.edges(sideOrient(side)).kind[i] ?? EDGE.NONE);
  }

  /** Does a wall (EDGE.WALL) stand on `side` of cell (x, y)? */
  wallOn(x: number, y: number, side: Side): boolean {
    return this.edgeKind(x, y, side) === EDGE.WALL;
  }

  /**
   * Is the strip of the wall or opening on `side` of cell (x, y) in this cell? (EdgeGrid `host`: a wall or door piece
   * stands in the half cell on its host's side.) False when that edge is neither, or outside the level.
   */
  hostedOn(x: number, y: number, side: Side): boolean {
    const i = this.edgeIndex(x, y, side);
    if (i < 0) return false;
    const g = this.edges(sideOrient(side));
    const kind = g.kind[i] ?? EDGE.NONE;
    if (kind !== EDGE.WALL && kind !== EDGE.OPENING) return false;
    // host 1 = the edge's second cell: the cell whose N or W side it is
    return ((g.host[i] ?? 1) === 1) === (side === "N" || side === "W");
  }

  /** The theme an element standing at (x, y) is built in: its own, else that cell's (`elementTheme`). */
  themeAt(own: ThemeId, x: number, y: number): ThemeId {
    return elementTheme(own, this.cell(x, y).theme);
  }

  /** The cell at (x, y) as the build reads it (a new object; see `LevelCell`). */
  cell(x: number, y: number): LevelCell {
    const i = this.index(x, y);
    if (i < 0)
      return {
        inBounds: false,
        open: false,
        floor: false,
        height: 0,
        material: null,
        theme: this.defaultTheme,
        area: 0,
        flags: 0,
      };
    const L = this.level;
    const c = L.cells;
    const flags = c.flags[i] ?? 0;
    const mat = c.material[i] ?? 0;
    const open = (c.state[i] ?? CELL.VOID) === CELL.OPEN;
    return {
      inBounds: true,
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && mat > 0,
      height: (c.height[i] ?? 0) / 4,
      material: mat > 0 ? (L.materials[mat - 1] ?? null) : null,
      theme: cellTheme(L, i, this.defaultTheme),
      area: c.area[i] ?? 0,
      flags,
    };
  }

  /**
   * The centre (plan coordinates) of the part of cell (x, y) no wall or door strip stands in, or null when less than
   * `minSpan` is left either way: the point the 2D map's open floor is judged at (verify's open-floor check, the recipe
   * engine's keep-clear rule).
   */
  freeCentre(x: number, y: number, minSpan: number = MIN_FREE_SPAN): [number, number] | null {
    let x0 = x,
      x1 = x + 1,
      y0 = y,
      y1 = y + 1;
    if (this.hostedOn(x, y, "W")) x0 += 0.5;
    if (this.hostedOn(x, y, "E")) x1 -= 0.5;
    if (this.hostedOn(x, y, "N")) y0 += 0.5;
    if (this.hostedOn(x, y, "S")) y1 -= 0.5;
    if (x1 - x0 < minSpan || y1 - y0 < minSpan) return null;
    // an outer corner of a building diagonal to this cell (walls on both neighbours, hosted on this side) carries a
    // corner post in this cell's corner quarter: when that quarter is all that is left free, the cell is not open floor
    const quarter = (qx: number, qy: number): boolean =>
      x0 >= qx - 0.01 && x1 <= qx + 0.51 && y0 >= qy - 0.01 && y1 <= qy + 0.51;
    if (
      (quarter(x + 0.5, y + 0.5) && this.hostedOn(x + 1, y, "S") && this.hostedOn(x, y + 1, "E")) ||
      (quarter(x, y + 0.5) && this.hostedOn(x - 1, y, "S") && this.hostedOn(x, y + 1, "W")) ||
      (quarter(x + 0.5, y) && this.hostedOn(x + 1, y, "N") && this.hostedOn(x, y - 1, "E")) ||
      (quarter(x, y) && this.hostedOn(x - 1, y, "N") && this.hostedOn(x, y - 1, "W"))
    )
      return null;
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }

  /** Absolute walkable floor top of (x, y): elevation + floor thickness (0.5) + the cell's height. */
  top(x: number, y: number): number {
    const i = this.index(x, y);
    return this.level.elevation + (i < 0 ? 0 : (this.level.cells.height[i] ?? 0) / 4) + 0.5;
  }
}
