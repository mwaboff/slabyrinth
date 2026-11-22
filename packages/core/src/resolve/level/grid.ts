/**
 * The grid of one level while it resolves (ResolveGrid), and the primitives every stage shares.
 * resolve/level.ts runs the stages in their normative order; each stage is a module beside this one in resolve/level/,
 * and resolve/level/state.ts holds this grid together with the records the stages own.
 * Reads: the resolve context (plan, level index, theme defaults, palette view) and the plan level, expanded with its
 * structures' synthetic areas, openings and wall runs (resolve/structure.ts expandStructures).
 * Holds: the per-cell and per-edge arrays, which every stage may write in its turn (the stage order in resolve/level.ts
 * is what makes a value final), the area table (built once, read-only), and the stair edges the terrain and bridge
 * passes ask for. Nothing else: a record one stage leaves for another lives in state.ts, owned by its stage.
 * The methods here are the shared vocabulary of the stages: cell and edge indexing, which area owns a cell, plan
 * issues, shape rasterising, feature footprints and the checks before a feature is placed.
 */
import type {
  Area,
  AreaKind,
  FeatureType,
  Level,
  MapPlan,
  Material,
  PlanIssue,
  PlanIssueCode,
  Severity,
  Shape,
  Side,
  ThemeId,
  Vec2,
  WallMode,
  WallStyle,
} from "../../contracts/plan";
import { BUILD_CONSTANTS, MATERIALS } from "../../contracts/plan";
import type { ThemeInterior } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import { SIDES } from "../../gen/gridGeometry";
import { type CellMask, forEachMaskCell } from "../../gen/mask";
import type { RoomClass } from "../../gen/roomPurpose";
import { type ClipBox, rasterizeShape } from "../../gen/shapes";
import type { PaletteView } from "../../palette/view";
import { generatorProfile, type GeneratorProfile } from "../../plan/generator";
import { floorTopAt, QUARTERS_PER_TILE } from "../../plan/levels";
import {
  cellIndex,
  edgeCol,
  edgeCount,
  edgeFirstCell,
  edgeRow,
  edgeSecondCell,
  hEdgeIndex,
  sideEdgeIndex,
  sideOrient,
  vEdgeIndex,
} from "../levelGrid";
import { isWater, materialOrdinal } from "../materials";
import type { ThemeDefaults } from "../themes";
import { type StructureWork, expandStructures } from "../structure";
import { areaTable } from "./areas";
import { MAX_LEVEL_SIDE } from "../../plan/sizeTiers";

export interface LevelContext {
  plan: MapPlan;
  levelIndex: number;
  themeDefaults: (theme: ThemeId) => ThemeDefaults;
  issues: PlanIssue[];
  /**
   * The palette as the resolver sees it (piece sizes, room pieces, covered-stall forms, floor tile sizes): one view,
   * built once per resolve, the same palettes the compiler decides from (palette/view.ts).
   */
  palette: PaletteView;
}

/**
 * One plan area as the stages see it, described once when the grid is built (resolve/level/areas.ts areaTable) and
 * never changed: what a stage does to an area's cells (a room's own floor, a step) it does to the cells.
 */
export interface AreaInfo {
  readonly area: Area;
  readonly index: number;
  readonly kind: AreaKind;
  readonly mode: WallMode;
  readonly wallStyle: WallStyle;
  readonly wallHeight: number;
  readonly themeIdx: number;
  readonly theme: ThemeId;
  /** The floor the area asks for (MATERIALS ordinal + 1; 0 = no floor, "none"), laid when it claims its cells. */
  readonly floorMat: number;
  readonly floorNone: boolean;
  readonly isZone: boolean;
  readonly isRoute: boolean;
  readonly isBridge: boolean;
  /** What the area is for and whether it is abandoned: read once from its words (gen/roomPurpose.ts classifyRoom). */
  readonly room: RoomClass;
  /** The theme's interior character (resolve/themes.ts themeDefaults). */
  readonly interior: ThemeInterior;
  /**
   * Dressed rough: the theme's finish is rough, or nobody keeps the room up (resolve/wallTops.ts roughCells reads the
   * same back from ResolvedArea.finish and .abandoned). Dressing only: what the walls are built of is `interior`.
   */
  readonly rough: boolean;
}

/**
 * A record as a stage that does not own it sees it: nothing can be added, removed or reassigned, at any depth (arrays
 * and tuples become readonly, sets and maps their read-only views, typed arrays plain indexable reads). The owner
 * stage is handed the writable record; resolve/level.ts decides who gets which (resolve/level/state.ts).
 */
export type ReadOnly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ArrayLike<number> & { readonly buffer: ArrayBufferLike }
    ? ArrayLike<number>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<K, ReadOnly<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<U>
        : T extends object
          ? { readonly [K in keyof T]: ReadOnly<T[K]> }
          : T;

export interface EdgeArrays {
  kind: Uint8Array;
  ref: Int32Array;
  height: Float64Array;
  host: Uint8Array;
  run: Uint8Array;
  style: Array<WallStyle | null>;
  /** edge cleared by an "open" opening (counts for overlap). */
  opened: Uint8Array;
  /** Forced host side (0/1) for generated edges such as bridge railings; -1 = use the host rule. */
  hostSet: Int8Array;
}

/** Railing height above the deck (tiles). */
export const RAILING_HEIGHT = 1;
// material traits (water, natural ground, deck spans): resolve/materials.ts; wall style traits (low rims, whole-cell
// natural rock, styles that may stand uneven): gen/wallStyles.ts

export class ResolveGrid {
  readonly plan: MapPlan;
  /** What the plan's generator does (plan/generator.ts): every version-dependent rule below reads a switch of it. */
  readonly profile: GeneratorProfile;
  readonly level: Level;
  readonly li: number;
  readonly bx: number;
  readonly by: number;
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly state: Uint8Array;
  readonly struct: Int32Array;
  readonly disp: Int32Array;
  readonly mat: Uint8Array;
  readonly height: Int16Array;
  readonly flags: Uint8Array;
  readonly theme: Uint16Array;
  /** Cells whose height an area set explicitly (floorHeight), for the under-layer no-effect check. */
  readonly heightSet: Uint8Array;
  /** The level's themes (cells and areas refer to them by index; the level theme is index 0). */
  readonly themes: readonly ThemeId[];
  /** The plan level's areas (structures' synthetic areas included), in plan order. */
  readonly areas: readonly AreaInfo[];
  readonly areaIndexById: ReadonlyMap<string, number>;
  /** Per area, how many cells it owns structurally (recountStruct): the host rule gives a wall to the larger side. */
  private readonly ownedCells: number[];
  readonly hE: EdgeArrays;
  readonly vE: EdgeArrays;
  readonly levelTheme: ThemeId;
  readonly defaultWallHeight: number;
  /** Stair edges asked for by platform and stairs ops and inclined bridges ("a,b" local cell pairs, a < b). */
  private readonly stairPairs = new Set<string>();
  readonly ctx: LevelContext;
  /** Buildings and enclosures (resolve/structure.ts); null when the level has none. */
  readonly structs: StructureWork | null;
  /**
   * The next level up by elevation, linked once every level's areas are laid (resolvePlan.ts, after phase 1): where it
   * has floor, its elevation is this level's ceiling (`ceilingAt`). Null for the top level.
   */
  above: ResolveGrid | null = null;

  constructor(ctx: LevelContext) {
    this.ctx = ctx;
    this.plan = ctx.plan;
    this.profile = generatorProfile(ctx.plan);
    this.li = ctx.levelIndex;
    const planLevel = ctx.plan.levels[ctx.levelIndex] as Level;
    const lb = planLevel.bounds;
    // structures add synthetic areas / openings / wall runs after the plan's own (resolve/structure.ts)
    const ex = expandStructures(
      ctx.plan,
      planLevel,
      ctx.levelIndex,
      ctx.issues,
      (x, y) => x >= lb.x && y >= lb.y && x < lb.x + lb.w && y < lb.y + lb.h,
    );
    const level = ex.level;
    this.structs = ex.work;
    this.level = level;
    this.bx = Math.floor(level.bounds.x);
    this.by = Math.floor(level.bounds.y);
    this.w = Math.max(1, Math.min(MAX_LEVEL_SIDE, Math.floor(level.bounds.w)));
    this.h = Math.max(1, Math.min(MAX_LEVEL_SIDE, Math.floor(level.bounds.h)));
    this.n = this.w * this.h;
    this.state = new Uint8Array(this.n);
    this.struct = new Int32Array(this.n);
    this.disp = new Int32Array(this.n);
    this.mat = new Uint8Array(this.n);
    this.height = new Int16Array(this.n);
    this.flags = new Uint8Array(this.n);
    this.theme = new Uint16Array(this.n);
    this.heightSet = new Uint8Array(this.n);
    this.hE = makeEdges(edgeCount(this, "h"));
    this.vE = makeEdges(edgeCount(this, "v"));
    this.levelTheme = level.theme ?? ctx.plan.theme;
    this.defaultWallHeight = level.wallHeight ?? BUILD_CONSTANTS.wallHeight;
    const table = areaTable(level, ctx, this.profile, this.levelTheme, this.defaultWallHeight);
    this.areas = table.areas;
    this.areaIndexById = table.byId;
    this.themes = table.themes;
    this.ownedCells = this.areas.map(() => 0);
  }

  // ───────────────────────────── cells and edges ─────────────────────────────

  // The index arithmetic is the level grid's (resolve/levelGrid.ts), shared with every reader of a resolved level.

  idx(gx: number, gy: number): number {
    return cellIndex(this, gx - this.bx, gy - this.by);
  }

  isFloor(i: number): boolean {
    return i >= 0 && this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
  }

  issue(
    severity: Severity,
    code: PlanIssueCode,
    message: string,
    extra: { path?: string; elementId?: string; cell?: Vec2; hint?: string } = {},
  ): void {
    const is: PlanIssue = { severity, code, message, levelId: this.level.id };
    if (extra.path !== undefined) is.path = extra.path;
    if (extra.elementId !== undefined) is.elementId = extra.elementId;
    if (extra.cell !== undefined) is.cell = extra.cell;
    if (extra.hint !== undefined) is.hint = extra.hint;
    this.ctx.issues.push(is);
  }

  /** Global-coordinate edge on `side` of cell (gx, gy): [which grid, local index] or null if out of range. */
  sideEdge(gx: number, gy: number, side: Side): { e: EdgeArrays; i: number; orient: "h" | "v" } | null {
    const lx = gx - this.bx;
    const ly = gy - this.by;
    switch (side) {
      case "N":
        return this.hIndex(lx, ly);
      case "S":
        return this.hIndex(lx, ly + 1);
      case "W":
        return this.vIndex(lx, ly);
      case "E":
        return this.vIndex(lx + 1, ly);
    }
  }

  hIndex(lx: number, ly: number): { e: EdgeArrays; i: number; orient: "h" } | null {
    const i = hEdgeIndex(this, lx, ly);
    return i < 0 ? null : { e: this.hE, i, orient: "h" };
  }

  vIndex(lx: number, ly: number): { e: EdgeArrays; i: number; orient: "v" } | null {
    const i = vEdgeIndex(this, lx, ly);
    return i < 0 ? null : { e: this.vE, i, orient: "v" };
  }

  edgeKindAt(gx: number, gy: number, side: Side): number {
    const i = sideEdgeIndex(this, gx - this.bx, gy - this.by, side);
    return i < 0 ? EDGE.NONE : ((sideOrient(side) === "h" ? this.hE : this.vE).kind[i] as number);
  }

  /** The two cells (local index or -1 when out of bounds) on either side of an edge: [first (N/W), second (S/E)]. */
  edgeCells(orient: "h" | "v", i: number): [number, number] {
    return [edgeFirstCell(this, orient, i), edgeSecondCell(this, orient, i)];
  }

  /** Global vertex at the start of an edge. */
  edgeStart(orient: "h" | "v", i: number): [number, number] {
    return [this.bx + edgeCol(this, orient, i), this.by + edgeRow(this, orient, i)];
  }

  cellXY(i: number): [number, number] {
    const lx = i % this.w;
    return [this.bx + lx, this.by + (i - lx) / this.w];
  }

  /**
   * The theme of cell `i` (the level's outside the level): the one a piece anchored there is built in and verified by.
   * Every stage asks this, never the cell arrays.
   */
  themeAt(i: number): ThemeId {
    return this.themes[i >= 0 ? (this.theme[i] as number) : 0] ?? this.levelTheme;
  }

  /**
   * The theme the size of a piece anchored on cell `i` is asked of: its cell's theme, the one it is built in (generator
   * 4, `piecesInCellTheme`); the released generators asked the level's theme.
   */
  pieceTheme(i: number): ThemeId {
    return this.profile.piecesInCellTheme ? this.themeAt(i) : this.levelTheme;
  }

  private clipMask(m: CellMask, what: string, path: string, id: string): Array<number> {
    const out: number[] = [];
    let clipped = 0;
    forEachMaskCell(m, (x, y) => {
      const i = this.idx(x, y);
      if (i < 0) clipped++;
      else out.push(i);
    });
    if (clipped > 0) {
      this.issue(
        "warning",
        "bounds_exceeded",
        `${what} "${id}" extends beyond the level bounds; the cells outside are clipped`,
        {
          path,
          elementId: id,
          hint: `level ${this.level.id} bounds are ${this.bx},${this.by} ${this.w}x${this.h}`,
        },
      );
    }
    return out;
  }

  shapeCells(shape: Shape, what: string, path: string, id: string): number[] {
    return this.clipMask(
      rasterizeShape(shape, { planSeed: this.plan.seed, clip: this.rasterClip() }),
      what,
      path,
      id,
    );
  }

  /** Level bounds plus a one-cell ring: shapes are only evaluated there (ring cells reveal clipping). */
  rasterClip(): ClipBox {
    return { x0: this.bx - 1, y0: this.by - 1, x1: this.bx + this.w, y1: this.by + this.h };
  }

  setMaterial(i: number, m: Material): void {
    this.mat[i] = materialOrdinal(m);
    let f = (this.flags[i] as number) & ~CELL_FLAG.WATER;
    if (isWater(m)) f |= CELL_FLAG.WATER;
    this.flags[i] = f;
  }

  /** 4-neighbour BFS distance from the outside of a cell set (boundary cells = 1). */
  innerDistance(cells: number[], boundsInside = false): Map<number, number> {
    const set = new Set(cells);
    const dist = new Map<number, number>();
    let frontier: number[] = [];
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      const nb = [this.idx(x + 1, y), this.idx(x - 1, y), this.idx(x, y + 1), this.idx(x, y - 1)];
      if (nb.some((k) => (k < 0 ? !boundsInside : !set.has(k)))) {
        dist.set(i, 1);
        frontier.push(i);
      }
    }
    let d = 1;
    while (frontier.length > 0) {
      d++;
      const next: number[] = [];
      for (const i of frontier) {
        const [x, y] = this.cellXY(i);
        for (const k of [this.idx(x + 1, y), this.idx(x - 1, y), this.idx(x, y + 1), this.idx(x, y - 1)]) {
          if (k >= 0 && set.has(k) && !dist.has(k)) {
            dist.set(k, d);
            next.push(k);
          }
        }
      }
      frontier = next;
    }
    return dist;
  }

  neighbours4(i: number): number[] {
    const [x, y] = this.cellXY(i);
    return [this.idx(x, y - 1), this.idx(x + 1, y), this.idx(x, y + 1), this.idx(x - 1, y)];
  }

  /** Open, non-deck cells within two cells of a shape (where a ragged outline may wander out to). */
  growRing(cells: readonly number[]): number[] {
    const inS = new Set(cells);
    const out = new Set<number>();
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const j = this.idx(x + dx, y + dy);
          if (j < 0 || inS.has(j) || this.state[j] !== CELL.OPEN) continue;
          if (((this.flags[j] as number) & (CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR)) !== 0) continue;
          out.add(j);
        }
    }
    return [...out].sort((a, b) => a - b);
  }

  organicGrid(): { xy: (i: number) => [number, number]; idx: (x: number, y: number) => number } {
    return { xy: (i) => this.cellXY(i), idx: (x, y) => this.idx(x, y) };
  }

  /** True when any of the four edges of a global cell already holds a wall or an opening. */
  hasWallAround(gx: number, gy: number): boolean {
    return SIDES.some((s) => {
      const ed = this.sideEdge(gx, gy, s);
      return !ed || ed.e.kind[ed.i] === EDGE.WALL || ed.e.kind[ed.i] === EDGE.OPENING;
    });
  }

  /** True when the cell has open floor (used by the level above to check what lies under its floor openings). */
  hasFloorAt(gx: number, gy: number): boolean {
    return this.isFloor(this.idx(gx, gy));
  }

  /**
   * Clear height in tiles above the floor top of global cell (gx, gy): up to the underside of the level above where
   * that level has floor over the cell (verify measures `verify_pokes_into_level_above` there), else Infinity.
   */
  headroomAt(gx: number, gy: number): number {
    const up = this.above;
    if (up === null || !up.hasFloorAt(gx, gy)) return Infinity;
    const i = this.idx(gx, gy);
    const height = i < 0 ? 0 : (this.height[i] as number) / QUARTERS_PER_TILE;
    return up.level.elevation - floorTopAt(this.level.elevation, height);
  }

  // ───────────────────────────── areas ─────────────────────────────

  /** Area `info` takes cell `i`: opens it with the area's floor, theme and (if set) floor height. */
  claim(i: number, info: AreaInfo): void {
    const ai1 = info.index + 1;
    if (info.isZone) {
      this.disp[i] = ai1;
      return;
    }
    if (info.isBridge && this.state[i] === CELL.OPEN) {
      // A bridge keeps what lies under it (floor, height, flags); the bridge pass lays the deck on top.
      this.struct[i] = ai1;
      this.disp[i] = ai1;
      this.theme[i] = info.themeIdx;
      return;
    }
    this.state[i] = CELL.OPEN;
    this.struct[i] = ai1;
    this.disp[i] = ai1;
    this.theme[i] = info.themeIdx;
    let f = (this.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH);
    if (info.floorNone) {
      f |= CELL_FLAG.NO_FLOOR;
      this.mat[i] = 0;
    } else {
      this.mat[i] = info.floorMat;
      if (isWater(MATERIALS[info.floorMat - 1] as Material)) f |= CELL_FLAG.WATER;
    }
    this.flags[i] = f;
    if (info.area.floorHeight !== undefined && !info.isBridge) {
      this.height[i] = Math.round(info.area.floorHeight * 4);
      this.heightSet[i] = 1;
    }
  }

  /** Counts each area's structural cells again (after the areas claim theirs, and after cave outlines move them). */
  recountStruct(): void {
    this.ownedCells.fill(0);
    for (let i = 0; i < this.n; i++) {
      const s = this.struct[i] as number;
      if (s > 0) this.ownedCells[s - 1] = (this.ownedCells[s - 1] as number) + 1;
    }
  }

  /** Cells (local indices) whose structural (or, for zones, display) owner is area `ai`. */
  areaCells(ai: number): number[] {
    const info = this.areas[ai];
    if (!info) return [];
    const arr = info.isZone ? this.disp : this.struct;
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (arr[i] === ai + 1) out.push(i);
    return out;
  }

  /** Cells (local indices) that show as area `ai` (its display cells: a zone's, or a room's not under a zone). */
  shownCells(ai: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.disp[i] === ai + 1) out.push(i);
    return out;
  }

  /**
   * The area a cell shows as (its display owner: a zone over a room shows the zone; ResolvedLevel.cells.area), or
   * undefined outside every area or the level.
   */
  areaAt(i: number): AreaInfo | undefined {
    const d = i >= 0 ? (this.disp[i] as number) : 0;
    return d > 0 ? this.areas[d - 1] : undefined;
  }

  /**
   * The structural region of a cell as a number: 0 for @ground (or outside the level), an area's index + 1 for the area
   * that owns it (`ownerAt`). For walks that compare regions of neighbouring cells.
   */
  regionAt(i: number): number {
    return i >= 0 ? (this.struct[i] ?? 0) : 0;
  }

  /** The display region of a cell as a number: 0 for none, an area's index + 1 for the area it shows as (`areaAt`). */
  shownRegionAt(i: number): number {
    return i >= 0 ? (this.disp[i] ?? 0) : 0;
  }

  /** The area that owns a cell structurally (its walls, floor and theme; never a zone), or undefined (@ground). */
  ownerAt(i: number): AreaInfo | undefined {
    const s = i >= 0 ? (this.struct[i] as number) : 0;
    return s > 0 ? this.areas[s - 1] : undefined;
  }

  /**
   * The level's open ground as regions, in display-index order: @ground (index 0) and each zone, with their open cells
   * in index order. Areas that are not zones are left out: they are dressed and banded as areas of their own.
   */
  openRegions(): Array<{ index: number; cells: Array<[number, number]> }> {
    const byIndex = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== CELL.OPEN) continue;
      const d = this.disp[i] as number;
      if (d > 0 && this.areas[d - 1]?.kind !== "zone") continue;
      const list = byIndex.get(d) ?? [];
      list.push(this.cellXY(i));
      byIndex.set(d, list);
    }
    return [...byIndex.entries()].sort((p, q) => p[0] - q[0]).map(([index, cells]) => ({ index, cells }));
  }

  /** Anchor (§2.4 step 10): cell nearest the bbox centre by squared distance; ties → smallest y, then x. */
  anchorOf(cells: number[]): [number, number] | null {
    if (cells.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const xy = cells.map((i) => this.cellXY(i));
    for (const [x, y] of xy) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    // doubled coordinates keep everything integral: centre*2 = x0 + x1 + 1, cell centre*2 = 2x + 1
    const cx2 = x0 + x1 + 1;
    const cy2 = y0 + y1 + 1;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const [x, y] of xy) {
      const dx = 2 * x + 1 - cx2;
      const dy = 2 * y + 1 - cy2;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && best && (y < best[1] || (y === best[1] && x < best[0])))) {
        bestD = d;
        best = [x, y];
      }
    }
    return best;
  }

  /** Region of a cell: -1 = not open / out of bounds; 0 = @ground; k = structural area index + 1. */
  region(i: number): number {
    if (i < 0 || this.state[i] !== CELL.OPEN) return -1;
    return this.struct[i] as number;
  }

  modeOf(region: number): WallMode {
    if (region <= 0) return "none";
    return (this.areas[region - 1] as AreaInfo).mode;
  }

  /** Host rule (§2.4 step 10): 0 = first cell (N/W), 1 = second (S/E). Border edges host in bounds. */
  hostOf(a: number, b: number, explicitRun: boolean): number {
    if (a < 0) return 1;
    if (b < 0) return 0;
    if (explicitRun) return 1;
    const openA = this.state[a] === CELL.OPEN;
    const openB = this.state[b] === CELL.OPEN;
    if (openA !== openB) return openA ? 1 : 0;
    const sa = this.struct[a] as number;
    const sb = this.struct[b] as number;
    if ((sa === 0) !== (sb === 0)) return sa === 0 ? 0 : 1;
    const ca = sa > 0 ? (this.ownedCells[sa - 1] as number) : 0;
    const cb = sb > 0 ? (this.ownedCells[sb - 1] as number) : 0;
    if (ca !== cb) return ca > cb ? 0 : 1;
    return 1;
  }

  /** Structural owner of a cell (area index + 1), 0 outside the level. */
  owner(i: number): number {
    return i < 0 ? 0 : (this.struct[i] as number);
  }

  /** Records a stair edge between two 4-adjacent cells (applied after the edges, when heights are final). */
  addStairEdge(a: number, b: number): void {
    if (a < 0 || b < 0) return;
    this.stairPairs.add(a < b ? `${a},${b}` : `${b},${a}`);
  }

  /** True when a stair edge was asked for between cells a and b. */
  hasStairEdge(a: number, b: number): boolean {
    return this.stairPairs.has(a < b ? `${a},${b}` : `${b},${a}`);
  }

  /** The stair edges asked for, in the order they were asked for ("a,b" local cell pairs, a < b). */
  get stairEdges(): ReadonlySet<string> {
    return this.stairPairs;
  }

  /** Explicit deck height (quarters) when the cell belongs to a bridge area with floorHeight (a raised deck), else null. */
  deckHeightOf(i: number): number | null {
    const s = this.struct[i] as number;
    const info = s > 0 ? this.areas[s - 1] : undefined;
    return info?.isBridge && info.area.floorHeight !== undefined
      ? Math.round(info.area.floorHeight * 4)
      : null;
  }

  // ───────────────────────────── features (the features themselves: resolve/level/features.ts FeatureWork) ─────

  /** Absolute height a feature anchored on cell `i` stands at, `lift` tiles above the floor. */
  featureBase(i: number, lift: number): number {
    const h =
      i >= 0 && !(this.state[i] === CELL.VOID && this.profile.voidIsBasePlane)
        ? (this.height[i] as number) / 4
        : 0;
    return this.level.elevation + BUILD_CONSTANTS.floorThickness + h + lift;
  }

  footprint(at: Readonly<Vec2>, size: readonly [number, number]): { cells: number[]; outside: boolean } {
    const cells: number[] = [];
    let outside = false;
    for (let y = at[1]; y < at[1] + size[1]; y++) {
      for (let x = at[0]; x < at[0] + size[0]; x++) {
        const i = this.idx(x, y);
        if (i < 0) outside = true;
        else cells.push(i);
      }
    }
    return { cells, outside };
  }

  /** Why a feature cannot stand at `at`, or null if it can. */
  featureProblem(
    type: FeatureType,
    at: Readonly<Vec2>,
    size: readonly [number, number],
    wall: Side | undefined,
  ): string | null {
    const info = featureInfo(type);
    const { cells, outside } = this.footprint(at, size);
    if (outside) return "its footprint leaves the level bounds";
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      if (this.state[i] !== CELL.OPEN)
        return `cell ${x},${y} is ${this.state[i] === CELL.SOLID ? "solid rock" : "void"}`;
      if ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) return `cell ${x},${y} has no floor`;
      if ((this.flags[i] as number) & CELL_FLAG.LINK)
        return `cell ${x},${y} is taken by stairs or a level link`;
      if ((this.flags[i] as number) & CELL_FLAG.STEPS) return `cell ${x},${y} holds a flight of steps`;
      if (info.blocking && (this.flags[i] as number) & CELL_FLAG.FEATURE)
        return `cell ${x},${y} is taken by another feature`;
    }
    for (let y = at[1]; y < at[1] + size[1]; y++) {
      for (let x = at[0]; x < at[0] + size[0]; x++) {
        if (x + 1 < at[0] + size[0] && this.edgeKindAt(x, y, "E") === EDGE.WALL)
          return `a wall runs between ${x},${y} and ${x + 1},${y}`;
        if (y + 1 < at[1] + size[1] && this.edgeKindAt(x, y, "S") === EDGE.WALL)
          return `a wall runs between ${x},${y} and ${x},${y + 1}`;
        if (x + 1 < at[0] + size[0] && this.edgeKindAt(x, y, "E") === EDGE.OPENING)
          return `it straddles the doorway between ${x},${y} and ${x + 1},${y}`;
        if (y + 1 < at[1] + size[1] && this.edgeKindAt(x, y, "S") === EDGE.OPENING)
          return `it straddles the doorway between ${x},${y} and ${x},${y + 1}`;
      }
    }
    if (info.wallMounted) {
      const side = wall ?? "N";
      const k = this.edgeKindAt(at[0], at[1], side);
      if (k !== EDGE.WALL && k !== EDGE.OPENING)
        return `there is no wall on the ${side} side of ${at[0]},${at[1]}`;
    }
    return null;
  }
}

function makeEdges(len: number): EdgeArrays {
  return {
    kind: new Uint8Array(len),
    ref: new Int32Array(len).fill(-1),
    height: new Float64Array(len),
    host: new Uint8Array(len),
    run: new Uint8Array(len),
    style: new Array<WallStyle | null>(len).fill(null),
    opened: new Uint8Array(len),
    hostSet: new Int8Array(len).fill(-1),
  };
}
