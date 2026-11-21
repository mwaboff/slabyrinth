/**
 * The working state of one level while it resolves, and the grid primitives every stage shares.
 * resolve/level.ts runs the stages in their normative order; each stage is a module beside this one in resolve/level/.
 * Reads: the resolve context (plan, level index, theme defaults, palette view) and the plan level, expanded with its
 * structures' synthetic areas, openings and wall runs (resolve/structure.ts expandStructures).
 * Writes: nothing by itself. It holds the typed per-cell and per-edge arrays and the records the stages fill
 * (openings, features, bridges, roads, floor openings, ...); resolve/level/output.ts turns them into a ResolvedLevel.
 * The methods here are the shared vocabulary of the stages: cell and edge indexing, which area owns a cell, plan
 * issues, shape rasterising, feature footprints and the checks before a feature is placed.
 */
import type {
  Area,
  AreaKind,
  BridgeSpan,
  FeatureType,
  Level,
  MapPlan,
  Material,
  OpeningKind,
  PlanIssue,
  PlanIssueCode,
  Severity,
  Shape,
  Side,
  TerrainOp,
  ThemeId,
  Vec2,
  WallMode,
  WallStyle,
} from "../../contracts/plan";
import { BUILD_CONSTANTS, MATERIALS, PLAN_LIMITS } from "../../contracts/plan";
import type {
  ResolvedBridge,
  ResolvedChannel,
  ResolvedFall,
  ResolvedFeature,
  ResolvedLevel,
  ResolvedLine,
  ResolvedOpening,
  ThemeInterior,
} from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import { type CellMask, forEachMaskCell } from "../../gen/mask";
import type { RoomClass } from "../../gen/roomPurpose";
import { type ClipBox, rasterizeShape } from "../../gen/shapes";
import type { PaletteView } from "../../palette/view";
import { generatorProfile, type GeneratorProfile } from "../../plan/generator";
import { isWater, materialOrdinal } from "../materials";
import type { ThemeDefaults } from "../themes";
import { type StructureWork, expandStructures } from "../structure";

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

export interface AreaInfo {
  area: Area;
  index: number;
  kind: AreaKind;
  mode: WallMode;
  wallStyle: WallStyle;
  wallHeight: number;
  themeIdx: number;
  theme: ThemeId;
  floorMat: number; // MATERIALS ordinal + 1; 0 = no floor ("none")
  floorNone: boolean;
  isZone: boolean;
  isRoute: boolean;
  isBridge: boolean;
  structCount: number;
  /** What the area is for and whether it is abandoned: read once from its words (gen/roomPurpose.ts classifyRoom). */
  room: RoomClass;
  /** The theme's interior character (resolve/themes.ts themeInterior). */
  interior: ThemeInterior;
  /** A rough interior: the theme's finish is rough, or nobody keeps the room up (ResolvedArea.finish). */
  rough: boolean;
}

/** A bridge deck waiting for the bridge pass (area of kind "bridge" or a chasm op's bridge). */
export interface BridgeRequest {
  id: string;
  elementId: string;
  path: string;
  cells: number[];
  /** Deck material ordinal (materialOrdinal). */
  floorMat: number;
  /** Explicit deck height (quarter tiles) or null = infer from the floor it touches. */
  deck: number | null;
  /** Explicit railing (null = none); undefined = the span's default. */
  railing: WallStyle | null | undefined;
  broken: number[];
  crumble: number;
  seed: number;
  span?: BridgeSpan;
  /** Explicit rise of the middle (tiles). */
  arch?: number;
  /** Direction the deck runs (chasm bridges know it; areas use their longer side). */
  axis?: "h" | "v";
  label?: string;
}

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

export interface RouteRecord {
  ai: number;
  from: number; // area index or -1
  to: number;
  width: number;
  kind: OpeningKind;
  startSquare: Array<[number, number]>;
  endSquare: Array<[number, number]>;
  /** Edge orientation crossed by the route where it leaves `from` / enters `to` (null = unknown). */
  orientA: "h" | "v" | null;
  orientB: "h" | "v" | null;
}

/** Railing height above the deck (tiles). */
export const RAILING_HEIGHT = 1;
// material traits (water, natural ground, deck spans): resolve/materials.ts; wall style traits (low rims, whole-cell
// natural rock, styles that may stand uneven): gen/wallStyles.ts

export class LevelWork {
  readonly plan: MapPlan;
  /** What the plan's generator does (plan/generator.ts): every version-dependent rule below reads a switch of it. */
  readonly gen: GeneratorProfile;
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
  readonly occ: Uint16Array;
  readonly themes: ThemeId[] = [];
  readonly areas: AreaInfo[] = [];
  readonly areaIndexById = new Map<string, number>();
  readonly hE: EdgeArrays;
  readonly vE: EdgeArrays;
  readonly openings: ResolvedOpening[] = [];
  readonly features: ResolvedFeature[] = [];
  readonly routes: RouteRecord[] = [];
  readonly levelTheme: ThemeId;
  readonly defaultWallHeight: number;
  generated = 0;
  /** Bridge decks (after the bridge pass), and per cell the deck index + 1 (0 = not a deck). */
  readonly bridges: ResolvedBridge[] = [];
  readonly bridgeOf: Int32Array;
  readonly bridgeReqs: BridgeRequest[] = [];
  /** Cells whose height an area set explicitly (floorHeight), for the under-layer no-effect check. */
  readonly heightSet: Uint8Array;
  readonly underTouched: Array<{ op: TerrainOp; path: string; cells: number[] }> = [];
  /** Stair edges requested by platform and stairs ops ("a,b" local cell pairs, a < b). */
  readonly stairEdges = new Set<string>();
  readonly outcrops: NonNullable<ResolvedLevel["outcrops"]> = [];
  /** Generator 3: floor openings (terrain op floor_opening): the cut cells and what the level below shows. */
  readonly floorOpenings: Array<{
    id: string;
    kind: "collapse" | "shaft" | "balcony";
    rim: WallStyle | "none";
    cells: number[];
    rubble: boolean;
    seed: number;
    below?: string;
    floorBelow: number;
    hiddenEdge: number;
    edgeCells: number;
    /** Generator 4: floor cells beside the hole (the broken rim of a collapse), where low debris is dropped. */
    rimCells: number[];
  }> = [];
  /** Generator 3: rubble to heap on this level's floor under a collapse in the level above (global cells). */
  readonly rubbleUnder: Array<{ id: string; cells: Vec2[]; seed: number }> = [];
  readonly kerbs: NonNullable<ResolvedLevel["kerbs"]> = [];
  /** Rubble at the ends of crumbling bridges, committed with the generated features. */
  readonly bridgeRubble: Array<{ id: string; at: Vec2 }> = [];
  readonly bridgeCrumble = new Map<number, { crumble: number; seed: number }>();
  readonly deckChecks: Array<() => void> = [];
  readonly ctx: LevelContext;
  /** Buildings and enclosures (resolve/structure.ts); null when the level has none. */
  readonly structs: StructureWork | null;

  // terrain records (resolve/level/relief.ts, resolve/level/chasms.ts)

  /** Rock ramps laid by stairs ops in style "ramp" (generator 2). */
  readonly ramps: NonNullable<ResolvedLevel["ramps"]> = [];
  /** Generator 3: courses of long rifts and rivers, falls of stepped rivers, and the cells of their upper reaches. */
  readonly channels: ResolvedChannel[] = [];
  readonly falls: ResolvedFall[] = [];
  readonly upperReach = new Set<number>();
  waterRange: [number, number] | null = null;

  // path ops waiting for their pavements and kerbs, and the finished roads (resolve/level/paths.ts)

  readonly pendingKerbs: Array<{
    cells: Set<number>;
    material: Material;
    seed: number;
    anchors: Vec2[];
    /** Natural trails get broken kerbs (stones on the verge); straight paths a continuous line. */
    natural: boolean;
  }> = [];

  /** Roads (path ops in road form, generator 2): carriageway cells, pavement cells laid and their heights. */
  readonly pendingRoads: Array<{
    op: Extract<TerrainOp, { op: "path" }>;
    axis: Vec2[];
    layer: "under" | "over";
    cells: number[];
    pave: Array<{ i: number; h: number }>;
  }> = [];
  readonly roads: NonNullable<ResolvedLevel["roads"]> = [];

  // what feature placement reads and builds (resolve/level/features.ts, market.ts, rooms.ts)

  rampSet: Set<number> | null = null;

  /** Generator 4: the recipe variants each purpose has drawn so far on this level (rooms of one purpose differ). */
  readonly roomMemory = new Map<string, number[]>();

  /** Road crossings and the pavement cells at their ends: generated dressing keeps off them (built lazily). */
  crossingClearCache: Set<number> | null = null;

  /** Cells under landmark pieces (great trees, landmarks, great statues): later dressing keeps an apron round them. */
  readonly landmarkCells = new Set<number>();
  /** Cells under vehicles: the street preset counts them toward its parking cap and keeps its own clear of them. */
  readonly vehicleCells = new Set<number>();

  /** Overhead lines that found both anchors (ResolvedLevel.lines). */
  readonly resolvedLines: ResolvedLine[] = [];

  /** Cells the natural board outline keeps open (resolve/level/terrain.ts stepOutline). */
  readonly outlineKeep = new Set<number>();

  constructor(ctx: LevelContext) {
    this.ctx = ctx;
    this.plan = ctx.plan;
    this.gen = generatorProfile(ctx.plan);
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
    this.w = Math.max(1, Math.min(PLAN_LIMITS.levelSide, Math.floor(level.bounds.w)));
    this.h = Math.max(1, Math.min(PLAN_LIMITS.levelSide, Math.floor(level.bounds.h)));
    this.n = this.w * this.h;
    this.state = new Uint8Array(this.n);
    this.struct = new Int32Array(this.n);
    this.disp = new Int32Array(this.n);
    this.mat = new Uint8Array(this.n);
    this.height = new Int16Array(this.n);
    this.flags = new Uint8Array(this.n);
    this.theme = new Uint16Array(this.n);
    this.occ = new Uint16Array(this.n);
    this.bridgeOf = new Int32Array(this.n);
    this.heightSet = new Uint8Array(this.n);
    this.hE = makeEdges(this.w * (this.h + 1));
    this.vE = makeEdges((this.w + 1) * this.h);
    this.levelTheme = level.theme ?? ctx.plan.theme;
    this.defaultWallHeight = level.wallHeight ?? BUILD_CONSTANTS.wallHeight;
  }

  // ───────────────────────────── cells and edges ─────────────────────────────

  idx(gx: number, gy: number): number {
    const lx = gx - this.bx;
    const ly = gy - this.by;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return -1;
    return ly * this.w + lx;
  }

  isFloor(i: number): boolean {
    return i >= 0 && this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
  }

  themeIndex(t: ThemeId): number {
    let k = this.themes.indexOf(t);
    if (k < 0) {
      k = this.themes.length;
      this.themes.push(t);
    }
    return k;
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
    if (lx < 0 || lx >= this.w || ly < 0 || ly > this.h) return null;
    return { e: this.hE, i: ly * this.w + lx, orient: "h" };
  }

  vIndex(lx: number, ly: number): { e: EdgeArrays; i: number; orient: "v" } | null {
    if (lx < 0 || lx > this.w || ly < 0 || ly >= this.h) return null;
    return { e: this.vE, i: ly * (this.w + 1) + lx, orient: "v" };
  }

  edgeKindAt(gx: number, gy: number, side: Side): number {
    const s = this.sideEdge(gx, gy, side);
    return s ? (s.e.kind[s.i] as number) : EDGE.NONE;
  }

  /** The two cells (local index or -1 when out of bounds) on either side of an edge: [first (N/W), second (S/E)]. */
  edgeCells(orient: "h" | "v", i: number): [number, number] {
    if (orient === "h") {
      const lx = i % this.w;
      const ly = (i - lx) / this.w;
      return [ly > 0 ? (ly - 1) * this.w + lx : -1, ly < this.h ? ly * this.w + lx : -1];
    }
    const W1 = this.w + 1;
    const lx = i % W1;
    const ly = (i - lx) / W1;
    return [lx > 0 ? ly * this.w + lx - 1 : -1, lx < this.w ? ly * this.w + lx : -1];
  }

  /** Global vertex at the start of an edge. */
  edgeStart(orient: "h" | "v", i: number): [number, number] {
    if (orient === "h") {
      const lx = i % this.w;
      return [this.bx + lx, this.by + (i - lx) / this.w];
    }
    const W1 = this.w + 1;
    const lx = i % W1;
    return [this.bx + lx, this.by + (i - lx) / W1];
  }

  cellXY(i: number): [number, number] {
    const lx = i % this.w;
    return [this.bx + lx, this.by + (i - lx) / this.w];
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
    return (["N", "E", "S", "W"] as const).some((s) => {
      const ed = this.sideEdge(gx, gy, s);
      return !ed || ed.e.kind[ed.i] === EDGE.WALL || ed.e.kind[ed.i] === EDGE.OPENING;
    });
  }

  /** True when the cell has open floor (used by the level above to check what lies under its floor openings). */
  hasFloorAt(gx: number, gy: number): boolean {
    const i = this.idx(gx, gy);
    return i >= 0 && this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
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

  recountStruct(): void {
    for (const a of this.areas) a.structCount = 0;
    for (let i = 0; i < this.n; i++) {
      const s = this.struct[i] as number;
      if (s > 0) (this.areas[s - 1] as AreaInfo).structCount++;
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
    const ca = sa > 0 ? (this.areas[sa - 1] as AreaInfo).structCount : 0;
    const cb = sb > 0 ? (this.areas[sb - 1] as AreaInfo).structCount : 0;
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
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    this.stairEdges.add(key);
  }

  /** Explicit deck height (quarters) when the cell belongs to a bridge area with floorHeight (a raised deck), else null. */
  deckHeightOf(i: number): number | null {
    const s = this.struct[i] as number;
    const info = s > 0 ? this.areas[s - 1] : undefined;
    return info?.isBridge && info.area.floorHeight !== undefined
      ? Math.round(info.area.floorHeight * 4)
      : null;
  }

  // ───────────────────────────── features ─────────────────────────────

  addFeature(f: ResolvedFeature, cells: number[]): void {
    const landmark = f.type === "tree_large" || f.type === "landmark" || f.type === "statue_large";
    for (const i of cells) {
      if (landmark) this.landmarkCells.add(i);
      if (f.type === "vehicle") this.vehicleCells.add(i);
      this.occ[i] = (this.occ[i] as number) + 1;
      if (f.blocking) this.flags[i] = (this.flags[i] as number) | CELL_FLAG.FEATURE;
    }
    this.features.push(f);
  }

  /** Adds a generated feature on its own footprint and counts it toward the level's generated-feature cap. */
  addFeatureCells(f: ResolvedFeature): void {
    this.addFeature(f, this.footprint(f.at, f.size).cells);
    this.generated++;
  }

  featureBase(i: number, lift: number): number {
    const h =
      i >= 0 && !(this.state[i] === CELL.VOID && this.gen.voidIsBasePlane)
        ? (this.height[i] as number) / 4
        : 0;
    return this.level.elevation + BUILD_CONSTANTS.floorThickness + h + lift;
  }

  footprint(at: Vec2, size: readonly [number, number]): { cells: number[]; outside: boolean } {
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
    at: Vec2,
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
