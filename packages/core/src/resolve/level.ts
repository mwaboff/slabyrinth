/**
 * Per-level resolution (architecture §2.4, normative order):
 *   1 base · 2 terrain "under" · 3 areas (routes last) · 4 terrain "over" · 5 edges + wall runs · 6 openings
 *   [7 links: done across levels by resolvePlan] · 8 explicit features · 9 generated features · 10 derived data.
 * Works on typed arrays; `toResolved()` converts to the plain ResolvedLevel contract shape.
 */
import type {
  Area,
  AreaKind,
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
} from "../contracts/plan";
import { BUILD_CONSTANTS, MATERIALS, PLAN_LIMITS } from "../contracts/plan";
import type { ResolvedArea, ResolvedFeature, ResolvedLevel, ResolvedOpening } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { featureInfo, rotatedSize } from "../gen/catalog";
import { type CellMask, forEachMaskCell } from "../gen/mask";
import { ValueNoise } from "../gen/noise";
import {
  type AvoidKind,
  type GeneratedPlacement,
  type PlacementGrid,
  dressArea,
  scatterFeatures,
} from "../gen/place";
import {
  type ClipBox,
  bandOffsets,
  jitterPolyline,
  rasterPolyline,
  rasterizeShape,
  routeCenterline,
} from "../gen/shapes";
import { elementSeed, subSeed } from "../util/hash";
import type { ThemeDefaults } from "./themes";
import { traceRings } from "./trace";

export interface LevelContext {
  plan: MapPlan;
  levelIndex: number;
  themeDefaults: (theme: ThemeId) => ThemeDefaults;
  issues: PlanIssue[];
}

interface AreaInfo {
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
  structCount: number;
}

interface EdgeArrays {
  kind: Uint8Array;
  ref: Int32Array;
  height: Float64Array;
  host: Uint8Array;
  run: Uint8Array;
  style: Array<WallStyle | null>;
  /** edge cleared by an "open" opening (counts for overlap). */
  opened: Uint8Array;
}

interface RouteRecord {
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

const DEFAULT_MODE: Record<AreaKind, WallMode> = {
  room: "auto",
  corridor: "auto",
  cave: "auto",
  building: "auto",
  courtyard: "perimeter",
  zone: "none",
};

const WATER_MATS = new Set<Material>(["water_shallow", "water_deep"]);
/** Wall styles that TaleSpire builds as whole-cell blocks (no thin piece exists). */
export const FULL_CELL_STYLES: ReadonlySet<WallStyle> = new Set<WallStyle>(["cave_rock"]);

export function materialOrdinal(m: Material): number {
  return MATERIALS.indexOf(m) + 1;
}

export class LevelWork {
  readonly plan: MapPlan;
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
  private readonly ctx: LevelContext;

  constructor(ctx: LevelContext) {
    this.ctx = ctx;
    this.plan = ctx.plan;
    this.li = ctx.levelIndex;
    const level = ctx.plan.levels[ctx.levelIndex] as Level;
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
    this.hE = makeEdges(this.w * (this.h + 1));
    this.vE = makeEdges((this.w + 1) * this.h);
    this.levelTheme = level.theme ?? ctx.plan.theme;
    this.defaultWallHeight = level.wallHeight ?? BUILD_CONSTANTS.wallHeight;
  }

  // ───────────────────────────── helpers ─────────────────────────────

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
    if (WATER_MATS.has(m)) f |= CELL_FLAG.WATER;
    this.flags[i] = f;
  }

  // ───────────────────────────── phase 1: steps 1–6 ─────────────────────────────

  runPhase1(): void {
    this.initAreas();
    this.stepBase();
    this.stepTerrain("under");
    this.stepAreas();
    this.stepTerrain("over");
    this.stepEdges();
    this.stepWallRuns();
    this.stepOpenings();
  }

  private initAreas(): void {
    this.themeIndex(this.levelTheme);
    this.level.areas.forEach((area, index) => {
      const theme = area.theme ?? this.levelTheme;
      const td = this.ctx.themeDefaults(theme);
      const defFloor =
        area.kind === "cave" ? td.caveFloor : area.kind === "courtyard" ? td.courtyardFloor : td.floor;
      const floor = area.floor ?? defFloor;
      this.areas.push({
        area,
        index,
        kind: area.kind,
        mode: area.walls ?? DEFAULT_MODE[area.kind],
        wallStyle: area.wallStyle ?? (area.kind === "cave" ? "cave_rock" : "wall"),
        wallHeight: area.wallHeight ?? this.defaultWallHeight,
        themeIdx: this.themeIndex(theme),
        theme,
        floorMat: floor === "none" ? 0 : materialOrdinal(floor),
        floorNone: floor === "none",
        isZone: area.kind === "zone",
        isRoute: area.shape.type === "route",
        structCount: 0,
      });
      if (!this.areaIndexById.has(area.id)) this.areaIndexById.set(area.id, index);
    });
  }

  private stepBase(): void {
    const base = this.level.base;
    if (base.type === "solid") this.state.fill(CELL.SOLID);
    else if (base.type === "void") this.state.fill(CELL.VOID);
    else {
      this.state.fill(CELL.OPEN);
      for (let i = 0; i < this.n; i++) this.setMaterial(i, base.material);
    }
    this.theme.fill(0);
  }

  private stepTerrain(layer: "under" | "over"): void {
    this.level.terrain.forEach((op, k) => {
      if (op.op === "scatter" || op.op === "dress") return;
      if ((op.layer ?? "under") !== layer) return;
      this.applyTerrain(op, `/levels/${this.li}/terrain/${k}`);
    });
  }

  private applyTerrain(op: Exclude<TerrainOp, { op: "scatter" } | { op: "dress" }>, path: string): void {
    const open = (i: number): boolean => this.state[i] === CELL.OPEN;
    switch (op.op) {
      case "paint": {
        for (const i of this.shapeCells(op.shape, "terrain", path, op.id))
          if (open(i)) this.setMaterial(i, op.material);
        return;
      }
      case "noise": {
        const seed = elementSeed(this.plan.seed, op.id, op.seed);
        const noise = new ValueNoise(subSeed(seed, "noise"));
        const scale = Math.max(1, op.scale ?? 8);
        for (const i of this.shapeCells(op.shape, "terrain", path, op.id)) {
          if (!open(i)) continue;
          const [x, y] = this.cellXY(i);
          if (noise.sample(x / scale, y / scale) < op.coverage) this.setMaterial(i, op.material);
        }
        return;
      }
      case "path": {
        const seed = elementSeed(this.plan.seed, op.id, op.seed);
        const pts = jitterPolyline(op.points, op.width, op.jitter ?? 0, seed);
        const m = rasterPolyline(pts, op.width, this.rasterClip());
        forEachMaskCell(m, (x, y) => {
          const i = this.idx(x, y);
          if (i < 0 || !open(i)) return;
          this.setMaterial(i, op.material);
          this.flags[i] = (this.flags[i] as number) | CELL_FLAG.PATH;
        });
        return;
      }
      case "height": {
        const cells = this.shapeCells(op.shape, "terrain", path, op.id);
        const smooth = Math.max(0, Math.floor(op.smooth ?? 0));
        const dist = smooth > 0 ? this.innerDistance(cells) : null;
        for (const i of cells) {
          if (!open(i)) continue;
          const d = dist ? (dist.get(i) ?? 1) : smooth + 1;
          const factor = Math.min(1, d / (smooth + 1));
          const cur = this.height[i] as number;
          let next: number;
          if (op.set !== undefined) next = Math.round(cur + (Math.round(op.set * 4) - cur) * factor);
          else next = cur + Math.round((op.delta ?? 0) * 4 * factor);
          this.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(PLAN_LIMITS.maxHeight * 4, next));
        }
        return;
      }
    }
  }

  /** 4-neighbour BFS distance from the outside of a cell set (boundary cells = 1). */
  private innerDistance(cells: number[]): Map<number, number> {
    const set = new Set(cells);
    const dist = new Map<number, number>();
    let frontier: number[] = [];
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      const nb = [this.idx(x + 1, y), this.idx(x - 1, y), this.idx(x, y + 1), this.idx(x, y - 1)];
      if (nb.some((k) => k < 0 || !set.has(k))) {
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

  private claim(i: number, info: AreaInfo): void {
    const ai1 = info.index + 1;
    if (info.isZone) {
      this.disp[i] = ai1;
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
      if (WATER_MATS.has(MATERIALS[info.floorMat - 1] as Material)) f |= CELL_FLAG.WATER;
    }
    this.flags[i] = f;
    if (info.area.floorHeight !== undefined) this.height[i] = Math.round(info.area.floorHeight * 4);
  }

  private stepAreas(): void {
    for (const info of this.areas) {
      if (info.isRoute) continue;
      const cells = this.shapeCells(
        info.area.shape,
        "area",
        `/levels/${this.li}/areas/${info.index}/shape`,
        info.area.id,
      );
      for (const i of cells) this.claim(i, info);
    }
    for (const info of this.areas) if (info.isRoute) this.routeArea(info);
    this.recountStruct();
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

  private routeArea(info: AreaInfo): void {
    const shape = info.area.shape;
    if (shape.type !== "route") return;
    const path = `/levels/${this.li}/areas/${info.index}/shape`;
    const endpoint = (
      ref: string | Vec2,
      which: "from" | "to",
    ): { cell: [number, number]; ai: number } | null => {
      if (typeof ref !== "string") return { cell: [ref[0], ref[1]], ai: -1 };
      const ai = this.areaIndexById.get(ref);
      if (ai === undefined) {
        this.issue("error", "ref_unknown", `route "${info.area.id}" ${which} unknown area "${ref}"`, {
          path: `${path}/${which}`,
          elementId: info.area.id,
          hint: `areas on ${this.level.id}: ${this.level.areas.map((a) => a.id).join(", ")}`,
        });
        return null;
      }
      const cell = this.anchorOf(this.areaCells(ai));
      if (!cell) return null;
      return { cell, ai };
    };
    const a = endpoint(shape.from, "from");
    const b = endpoint(shape.to, "to");
    if (!a || !b) return;
    const width = shape.width ?? 1;
    const line = routeCenterline(a.cell, b.cell, shape.bend ?? "hv");
    const inA = (c: readonly [number, number]): boolean => a.ai >= 0 && this.ownerIs(c, a.ai);
    const inB = (c: readonly [number, number]): boolean => b.ai >= 0 && this.ownerIs(c, b.ai);
    let i0 = 0;
    while (i0 < line.length && inA(line[i0] as [number, number])) i0++;
    let j0 = i0;
    while (j0 < line.length && !inB(line[j0] as [number, number])) j0++;
    const [lo, hi] = bandOffsets(width);
    const square = (c: readonly [number, number]): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let y = c[1] + lo; y <= c[1] + hi; y++)
        for (let x = c[0] + lo; x <= c[0] + hi; x++) out.push([x, y]);
      return out;
    };
    for (let k = i0; k < j0; k++) {
      for (const [x, y] of square(line[k] as [number, number])) {
        const i = this.idx(x, y);
        if (i >= 0 && this.struct[i] === 0) this.claim(i, info);
      }
    }
    this.routes.push({
      ai: info.index,
      from: a.ai,
      to: b.ai,
      width,
      kind: shape.openings ?? "open",
      startSquare: i0 < j0 ? square(line[i0] as [number, number]) : [],
      endSquare: i0 < j0 ? square(line[j0 - 1] as [number, number]) : [],
      orientA: i0 > 0 && i0 < line.length ? crossOrient(line[i0 - 1] as Vec2, line[i0] as Vec2) : null,
      orientB: j0 > 0 && j0 < line.length ? crossOrient(line[j0 - 1] as Vec2, line[j0] as Vec2) : null,
    });
  }

  private ownerIs(c: readonly [number, number], ai: number): boolean {
    const i = this.idx(c[0], c[1]);
    if (i < 0) return false;
    const info = this.areas[ai] as AreaInfo;
    return (info.isZone ? this.disp[i] : this.struct[i]) === ai + 1;
  }

  // ── step 5: edges ──

  /** Region of a cell: -1 = not open / out of bounds; 0 = @ground; k = structural area index + 1. */
  region(i: number): number {
    if (i < 0 || this.state[i] !== CELL.OPEN) return -1;
    return this.struct[i] as number;
  }

  private modeOf(region: number): WallMode {
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

  private stepEdges(): void {
    const one = (orient: "h" | "v", e: EdgeArrays, i: number): void => {
      const [a, b] = this.edgeCells(orient, i);
      const ra = this.region(a);
      const rb = this.region(b);
      let demand = -1; // 0 = a, 1 = b, 2 = both
      if (ra >= 0 !== rb >= 0) {
        const r = ra >= 0 ? ra : rb;
        const m = this.modeOf(r);
        if (m === "auto" || m === "perimeter") demand = ra >= 0 ? 0 : 1;
      } else if (ra >= 0 && rb >= 0 && ra !== rb) {
        const da = this.modeOf(ra) === "auto";
        const db = this.modeOf(rb) === "auto";
        if (da && db) demand = 2;
        else if (da) demand = 0;
        else if (db) demand = 1;
      }
      if (demand >= 0) {
        // Style: between two demanding sides a thin style beats a full-cell (natural rock) style whatever the
        // area sizes; between two thin (or two full-cell) styles the host side wins.
        let side: number;
        if (demand === 2) {
          const fa = FULL_CELL_STYLES.has((this.areas[ra - 1] as AreaInfo).wallStyle);
          const fb = FULL_CELL_STYLES.has((this.areas[rb - 1] as AreaInfo).wallStyle);
          side = fa !== fb ? (fa ? 1 : 0) : this.hostOf(a, b, false);
        } else side = demand;
        const info = this.areas[(side === 0 ? ra : rb) - 1] as AreaInfo;
        // Natural rock walls are full-cell blocks in TaleSpire: there is no thin rock wall to stand between two
        // open cells. When every demanding side uses a full-cell style and both sides are open, the spaces merge.
        const fullCell = FULL_CELL_STYLES.has(info.wallStyle);
        if (!(fullCell && ra >= 0 && rb >= 0)) {
          e.kind[i] = EDGE.WALL;
          e.style[i] = info.wallStyle;
          e.height[i] = info.wallHeight;
          return;
        }
      }
      if (ra >= 0 && rb >= 0) {
        const dh = Math.abs((this.height[a] as number) - (this.height[b] as number));
        if (dh >= 1) {
          e.kind[i] = EDGE.LEDGE;
          e.height[i] = dh / 4;
        }
      }
    };
    for (let i = 0; i < this.hE.kind.length; i++) one("h", this.hE, i);
    for (let i = 0; i < this.vE.kind.length; i++) one("v", this.vE, i);
  }

  private stepWallRuns(): void {
    this.level.walls.forEach((run, k) => {
      const path = `/levels/${this.li}/walls/${k}`;
      let clipped = 0;
      const thinRock: Array<[number, number]> = [];
      for (let s = 0; s + 1 < run.points.length; s++) {
        const p = run.points[s] as Vec2;
        const q = run.points[s + 1] as Vec2;
        const edges: Array<{ e: EdgeArrays; i: number; orient: "h" | "v" } | null> = [];
        if (p[1] === q[1]) {
          for (let x = Math.min(p[0], q[0]); x < Math.max(p[0], q[0]); x++)
            edges.push(this.hIndex(x - this.bx, p[1] - this.by));
        } else if (p[0] === q[0]) {
          for (let y = Math.min(p[1], q[1]); y < Math.max(p[1], q[1]); y++)
            edges.push(this.vIndex(p[0] - this.bx, y - this.by));
        } else {
          this.issue("error", "shape_invalid", `wall run "${run.id}" segment ${s} is not axis-aligned`, {
            path: `${path}/points/${s + 1}`,
            elementId: run.id,
            hint: `use [${q[0]},${p[1]}] or [${p[0]},${q[1]}] as an intermediate point`,
          });
          continue;
        }
        for (const ed of edges) {
          if (!ed) {
            clipped++;
            continue;
          }
          if (run.op === "add") {
            const [ca, cb] = this.edgeCells(ed.orient, ed.i);
            if (FULL_CELL_STYLES.has(run.style ?? "wall") && this.region(ca) >= 0 && this.region(cb) >= 0) {
              thinRock.push(this.edgeStart(ed.orient, ed.i));
            }
            ed.e.kind[ed.i] = EDGE.WALL;
            ed.e.style[ed.i] = run.style ?? "wall";
            ed.e.height[ed.i] = run.height ?? this.defaultWallHeight;
            ed.e.run[ed.i] = 1;
          } else if (ed.e.kind[ed.i] === EDGE.WALL) {
            ed.e.kind[ed.i] = EDGE.NONE;
            ed.e.style[ed.i] = null;
            ed.e.height[ed.i] = 0;
            ed.e.run[ed.i] = 0;
          }
        }
      }
      const firstThin = thinRock[0];
      if (firstThin)
        this.issue(
          "error",
          "shape_invalid",
          `wall run "${run.id}" asks for a ${run.style ?? "wall"} wall between two open cells at ${firstThin[0]},${firstThin[1]} (${thinRock.length} edges); natural rock is built as whole cells, so it cannot stand there as a thin wall`,
          {
            path: `${path}/style`,
            elementId: run.id,
            hint: "leave a solid (unclaimed) cell between the two areas, or use another wall style such as stone",
          },
        );
      if (clipped > 0)
        this.issue(
          "warning",
          "bounds_exceeded",
          `wall run "${run.id}" leaves the level bounds; ${clipped} edges clipped`,
          {
            path,
            elementId: run.id,
          },
        );
    });
  }

  // ── step 6: openings ──

  private owner(i: number): number {
    return i < 0 ? 0 : (this.struct[i] as number);
  }

  private areaIdOf(region: number): string | null {
    return region > 0 ? (this.areas[region - 1] as AreaInfo).area.id : null;
  }

  /** Maximal straight runs of the given edges. */
  private runsOf(
    edges: Array<{ orient: "h" | "v"; i: number }>,
  ): Array<{ orient: "h" | "v"; idx: number[]; start: [number, number] }> {
    const runs: Array<{ orient: "h" | "v"; idx: number[]; start: [number, number] }> = [];
    for (const orient of ["h", "v"] as const) {
      const list = edges
        .filter((e) => e.orient === orient)
        .map((e) => {
          const [x, y] = this.edgeStart(orient, e.i);
          return { i: e.i, line: orient === "h" ? y : x, pos: orient === "h" ? x : y };
        })
        .sort((p, q) => p.line - q.line || p.pos - q.pos);
      let cur: { line: number; last: number; idx: number[] } | null = null;
      for (const e of list) {
        if (cur && cur.line === e.line && e.pos === cur.last + 1) {
          cur.idx.push(e.i);
          cur.last = e.pos;
        } else {
          if (cur) runs.push({ orient, idx: cur.idx, start: this.edgeStart(orient, cur.idx[0] as number) });
          cur = { line: e.line, last: e.pos, idx: [e.i] };
        }
      }
      if (cur) runs.push({ orient, idx: cur.idx, start: this.edgeStart(orient, cur.idx[0] as number) });
    }
    return runs;
  }

  /** Longest run; ties → smallest start y, then x, then horizontal before vertical. */
  private pickRun<T extends { orient: "h" | "v"; idx: number[]; start: [number, number] }>(
    runs: T[],
  ): T | null {
    let best: T | null = null;
    for (const r of runs) {
      if (
        !best ||
        r.idx.length > best.idx.length ||
        (r.idx.length === best.idx.length &&
          (r.start[1] < best.start[1] ||
            (r.start[1] === best.start[1] &&
              (r.start[0] < best.start[0] ||
                (r.start[0] === best.start[0] && r.orient === "h" && best.orient === "v")))))
      )
        best = r;
    }
    return best;
  }

  private placeOpening(
    o: { id: string; kind: OpeningKind; label?: string; gmOnly?: boolean },
    orient: "h" | "v",
    idx: number[],
    path: string,
    explicitAt: boolean,
    silentOverlap: boolean,
  ): boolean {
    const e = orient === "h" ? this.hE : this.vE;
    for (const i of idx) {
      if (e.kind[i] === EDGE.OPENING || e.opened[i] === 1) {
        if (!silentOverlap) {
          const [x, y] = this.edgeStart(orient, i);
          this.issue(
            "error",
            "opening_overlap",
            `opening "${o.id}" overlaps another opening at edge ${orient} ${x},${y}`,
            {
              path,
              elementId: o.id,
              hint: "move it with position (0..1) or remove the other opening",
            },
          );
        }
        return false;
      }
    }
    const first = idx[0] as number;
    const [a, b] = this.edgeCells(orient, first);
    const anyWall = idx.some((i) => e.kind[i] === EDGE.WALL);
    if (explicitAt && !anyWall && o.kind !== "open") {
      const [x, y] = this.edgeStart(orient, first);
      this.issue(
        "warning",
        "opening_no_boundary",
        `opening "${o.id}" is not on a wall (edge ${orient} ${x},${y}); it is placed anyway`,
        {
          path,
          elementId: o.id,
          hint: "use between: [areaA, areaB] to snap it onto a shared wall",
        },
      );
    }
    const style = e.style[first] ?? "wall";
    const k = this.openings.length;
    const rec: ResolvedOpening = {
      id: o.id,
      kind: o.kind,
      orientation: orient,
      start: this.edgeStart(orient, first),
      width: idx.length,
      sides: [this.areaIdOf(this.owner(a)), this.areaIdOf(this.owner(b))],
      wallStyle: style,
      theme: this.themes[this.theme[b >= 0 ? b : a] ?? 0] ?? this.levelTheme,
    };
    if (o.label !== undefined) rec.label = o.label;
    if (o.gmOnly === true || o.kind === "secret_door") rec.gmOnly = true;
    this.openings.push(rec);
    for (const i of idx) {
      const wasWall = e.kind[i] === EDGE.WALL;
      if (o.kind === "open") {
        e.kind[i] = EDGE.NONE;
        e.style[i] = null;
        e.height[i] = 0;
        e.opened[i] = 1;
      } else {
        e.kind[i] = EDGE.OPENING;
        e.ref[i] = k;
        if (!wasWall) e.height[i] = this.defaultWallHeight;
        if (e.style[i] === null) e.style[i] = style;
      }
    }
    return true;
  }

  private stepOpenings(): void {
    this.level.openings.forEach((o, k) => {
      const path = `/levels/${this.li}/openings/${k}`;
      const width0 = o.width ?? (o.kind === "double_door" ? 2 : 1);
      if (o.between) {
        const ids = o.between;
        const res = ids.map((id) => (id === "@outside" ? 0 : (this.areaIndexById.get(id) ?? -1) + 1));
        const [ra, rb] = res as [number, number];
        const unknown = ids.filter((id, j) => id !== "@outside" && (res[j] as number) === 0);
        if (unknown.length > 0) {
          this.issue(
            "error",
            "ref_unknown",
            `opening "${o.id}" names unknown area(s) ${unknown.join(", ")}`,
            {
              path: `${path}/between`,
              elementId: o.id,
              hint: `areas on ${this.level.id}: ${this.level.areas.map((a) => a.id).join(", ")}`,
            },
          );
          return;
        }
        if (ra === rb) {
          this.issue("error", "opening_no_boundary", `opening "${o.id}" needs two different sides`, {
            path: `${path}/between`,
            elementId: o.id,
          });
          return;
        }
        const matches: Array<{ orient: "h" | "v"; i: number }> = [];
        const test = (orient: "h" | "v", i: number): void => {
          const [a, b] = this.edgeCells(orient, i);
          const oa = this.owner(a);
          const ob = this.owner(b);
          if ((oa === ra && ob === rb) || (oa === rb && ob === ra)) matches.push({ orient, i });
        };
        for (let i = 0; i < this.hE.kind.length; i++) test("h", i);
        for (let i = 0; i < this.vE.kind.length; i++) test("v", i);
        const run = this.pickRun(this.runsOf(matches));
        if (!run) {
          this.issue(
            "error",
            "opening_no_boundary",
            `areas ${ids[0]} and ${ids[1]} share no edge, so "${o.id}" has nowhere to go`,
            {
              path: `${path}/between`,
              elementId: o.id,
              hint: this.nearestHint(ra, rb),
            },
          );
          return;
        }
        const len = run.idx.length;
        const wd = Math.min(width0, len);
        const pos = Math.min(1, Math.max(0, o.position ?? 0.5));
        const off = Math.min(len - wd, Math.max(0, Math.floor((len - wd) * pos)));
        this.placeOpening(o, run.orient, run.idx.slice(off, off + wd), path, false, false);
        return;
      }
      if (o.at) {
        const ed = this.sideEdge(o.at.x, o.at.y, o.at.side);
        if (!ed) {
          this.issue("error", "bounds_exceeded", `opening "${o.id}" is outside the level bounds`, {
            path: `${path}/at`,
            elementId: o.id,
          });
          return;
        }
        const idx: number[] = [];
        for (let j = 0; j < width0; j++) {
          const next =
            ed.orient === "h"
              ? this.hIndex((ed.i % this.w) + j, Math.floor(ed.i / this.w))
              : this.vIndex(ed.i % (this.w + 1), Math.floor(ed.i / (this.w + 1)) + j);
          if (!next) {
            this.issue(
              "error",
              "bounds_exceeded",
              `opening "${o.id}" (width ${width0}) runs past the level bounds`,
              {
                path: `${path}/width`,
                elementId: o.id,
              },
            );
            return;
          }
          idx.push(next.i);
        }
        this.placeOpening(o, ed.orient, idx, path, true, false);
      }
    });
    for (const r of this.routes) {
      const info = this.areas[r.ai] as AreaInfo;
      const make = (
        target: number,
        square: Array<[number, number]>,
        suffix: "a" | "b",
        prefer: "h" | "v" | null,
      ): void => {
        if (target < 0) return;
        const routeCells = new Set(
          square.map(([x, y]) => this.idx(x, y)).filter((i) => i >= 0 && this.struct[i] === r.ai + 1),
        );
        let matches = this.meetingEdges(r.ai + 1, target + 1, routeCells);
        if (matches.length === 0) matches = this.meetingEdges(r.ai + 1, target + 1, null);
        if (prefer && matches.some((m) => m.orient === prefer))
          matches = matches.filter((m) => m.orient === prefer);
        const run = this.pickRun(this.runsOf(matches));
        if (!run) return;
        const len = run.idx.length;
        const wd = Math.min(len, r.width, 3);
        const off = Math.floor((len - wd) * 0.5);
        this.placeOpening(
          { id: `${info.area.id}~${suffix}`, kind: r.kind },
          run.orient,
          run.idx.slice(off, off + wd),
          `/levels/${this.li}/areas/${r.ai}`,
          false,
          true,
        );
      };
      make(r.from, r.startSquare, "a", r.orientA);
      make(r.to, r.endSquare, "b", r.orientB);
    }
  }

  private meetingEdges(
    routeRegion: number,
    targetRegion: number,
    only: Set<number> | null,
  ): Array<{ orient: "h" | "v"; i: number }> {
    const out: Array<{ orient: "h" | "v"; i: number }> = [];
    const test = (orient: "h" | "v", i: number): void => {
      const [a, b] = this.edgeCells(orient, i);
      if (a < 0 || b < 0) return;
      const oa = this.struct[a] as number;
      const ob = this.struct[b] as number;
      if (oa === routeRegion && ob === targetRegion && (!only || only.has(a))) out.push({ orient, i });
      else if (ob === routeRegion && oa === targetRegion && (!only || only.has(b))) out.push({ orient, i });
    };
    for (let i = 0; i < this.hE.kind.length; i++) test("h", i);
    for (let i = 0; i < this.vE.kind.length; i++) test("v", i);
    return out;
  }

  private nearestHint(ra: number, rb: number): string {
    const cellsOf = (r: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (r === 0 ? this.struct[i] === 0 : this.struct[i] === r) out.push(i);
      }
      return out;
    };
    // multi-source BFS from every cell of A (Manhattan distance on the full grid): O(cells)
    const A = cellsOf(ra);
    const inB = new Uint8Array(this.n);
    for (const j of cellsOf(rb)) inB[j] = 1;
    const dist = new Int32Array(this.n).fill(-1);
    const src = new Int32Array(this.n);
    const queue: number[] = [];
    for (const i of A) {
      dist[i] = 0;
      src[i] = i;
      queue.push(i);
    }
    let best = Infinity;
    let pa: [number, number] = [0, 0];
    let pb: [number, number] = [0, 0];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head] as number;
      if (inB[i] === 1) {
        best = dist[i] as number;
        pa = this.cellXY(src[i] as number);
        pb = this.cellXY(i);
        break;
      }
      const lx = i % this.w;
      for (const j of [i - this.w, lx < this.w - 1 ? i + 1 : -1, i + this.w, lx > 0 ? i - 1 : -1]) {
        if (j < 0 || j >= this.n || dist[j] !== -1) continue;
        dist[j] = (dist[i] as number) + 1;
        src[j] = src[i] as number;
        queue.push(j);
      }
    }
    if (!Number.isFinite(best)) return "one of the areas has no cells";
    return `nearest cells are ${pa[0]},${pa[1]} and ${pb[0]},${pb[1]} (${best - 1} cells apart); connect them with a corridor (route) or use at:{x,y,side}`;
  }

  // ───────────────────────────── phase 2: steps 8–10 ─────────────────────────────

  grid(): PlacementGrid {
    return {
      inBounds: (x, y) => this.idx(x, y) >= 0,
      isFloor: (x, y) => this.isFloor(this.idx(x, y)),
      flags: (x, y) => {
        const i = this.idx(x, y);
        return i < 0 ? 0 : (this.flags[i] as number);
      },
      area: (x, y) => {
        const i = this.idx(x, y);
        return i < 0 ? 0 : (this.disp[i] as number);
      },
      occupied: (x, y) => {
        const i = this.idx(x, y);
        return i >= 0 && (this.occ[i] as number) > 0;
      },
      edge: (x, y, s) => this.edgeKindAt(x, y, s),
    };
  }

  private addFeature(f: ResolvedFeature, cells: number[]): void {
    for (const i of cells) {
      this.occ[i] = (this.occ[i] as number) + 1;
      if (f.blocking) this.flags[i] = (this.flags[i] as number) | CELL_FLAG.FEATURE;
    }
    this.features.push(f);
  }

  private featureBase(i: number, lift: number): number {
    const h = i >= 0 ? (this.height[i] as number) / 4 : 0;
    return this.level.elevation + BUILD_CONSTANTS.floorThickness + h + lift;
  }

  private footprint(at: Vec2, size: readonly [number, number]): { cells: number[]; outside: boolean } {
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

  private nearestFree(
    type: FeatureType,
    at: Vec2,
    size: readonly [number, number],
    wall: Side | undefined,
  ): Vec2 | null {
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const p: Vec2 = [at[0] + dx, at[1] + dy];
          if (this.featureProblem(type, p, size, wall) === null) return p;
        }
      }
    }
    return null;
  }

  runPhase2(): void {
    this.stepExplicitFeatures();
    this.stepGeneratedFeatures();
  }

  private stepExplicitFeatures(): void {
    this.level.features.forEach((f, k) => {
      const info = featureInfo(f.type);
      const rot = f.rot ?? 0;
      const size = rotatedSize(f.size ?? info.size, rot);
      const wall = info.wallMounted ? (f.wall ?? "N") : f.wall;
      const problem = this.featureProblem(f.type, f.at, size, wall);
      if (problem) {
        const near = this.nearestFree(f.type, f.at, size, wall);
        const code = problem.includes("another feature") ? "feature_overlap" : "feature_blocked";
        this.issue("error", code, `feature "${f.id}" (${f.type}) at ${f.at[0]},${f.at[1]}: ${problem}`, {
          path: `/levels/${this.li}/features/${k}`,
          elementId: f.id,
          cell: f.at,
          ...(near ? { hint: `nearest free spot is [${near[0]},${near[1]}]` } : {}),
        });
      }
      const anchor = this.idx(f.at[0], f.at[1]);
      const rf: ResolvedFeature = {
        id: f.id,
        type: f.type,
        at: [f.at[0], f.at[1]],
        size,
        rot,
        rotFine: rot,
        baseHeight: this.featureBase(anchor, f.lift ?? 0),
        theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
        blocking: info.blocking,
      };
      if (wall !== undefined) rf.wall = wall;
      if (f.variant !== undefined) rf.variant = f.variant;
      if (f.hint !== undefined) rf.hint = f.hint;
      if (f.label !== undefined) rf.label = f.label;
      const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      if (f.gmOnly ?? info.gmOnly) rf.gmOnly = true;
      this.addFeature(rf, this.footprint(f.at, size).cells);
    });
  }

  private commitGenerated(opId: string, list: GeneratedPlacement[]): void {
    list.forEach((p, n) => {
      const info = featureInfo(p.type);
      const anchor = this.idx(p.at[0], p.at[1]);
      const rf: ResolvedFeature = {
        id: `${opId}#${n}`,
        type: p.type,
        generatedBy: opId,
        at: p.at,
        size: p.size,
        rot: p.rot,
        rotFine: p.rotFine,
        baseHeight: this.featureBase(anchor, 0),
        theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
        blocking: info.blocking,
      };
      if (p.wall !== undefined) rf.wall = p.wall;
      if (p.variant !== undefined) rf.variant = p.variant;
      const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      if (info.gmOnly) rf.gmOnly = true;
      this.addFeature(rf, this.footprint(p.at, p.size).cells);
      this.generated++;
    });
  }

  private stepGeneratedFeatures(): void {
    const grid = this.grid();
    const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
    const ops = this.level.terrain.map((op, k) => ({ op, k }));
    const capWarn = (id: string, path: string): void => {
      this.issue(
        "warning",
        "limit_exceeded",
        `"${id}" hit the ${cap} generated-feature cap for this level; the rest were dropped`,
        {
          path,
          elementId: id,
          hint: "lower density or narrow the shape",
        },
      );
    };
    for (const { op, k } of ops) {
      if (op.op !== "dress") continue;
      const path = `/levels/${this.li}/terrain/${k}`;
      const ai = this.areaIndexById.get(op.area);
      if (ai === undefined) {
        this.issue("error", "ref_unknown", `dress "${op.id}" names unknown area "${op.area}"`, {
          path: `${path}/area`,
          elementId: op.id,
          hint: `areas on ${this.level.id}: ${this.level.areas.map((a) => a.id).join(", ")}`,
        });
        continue;
      }
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < this.n; i++) if (this.disp[i] === ai + 1) cells.push(this.cellXY(i));
      const res = dressArea(grid, {
        preset: op.preset,
        areaIndex: ai + 1,
        areaCells: cells,
        density: op.density ?? 0.5,
        seed: elementSeed(this.plan.seed, op.id, op.seed),
        remaining: cap - this.generated,
      });
      this.commitGenerated(op.id, res.placements);
      if (res.capped) capWarn(op.id, path);
    }
    for (const { op, k } of ops) {
      if (op.op !== "scatter") continue;
      const path = `/levels/${this.li}/terrain/${k}`;
      const region = op.shape
        ? this.shapeCells(op.shape, "scatter", `${path}/shape`, op.id)
        : Array.from({ length: this.n }, (_, i) => i);
      const excluded = new Set<number>();
      (op.exclude ?? []).forEach((s) => {
        forEachMaskCell(rasterizeShape(s, { planSeed: this.plan.seed, clip: this.rasterClip() }), (x, y) => {
          const i = this.idx(x, y);
          if (i >= 0) excluded.add(i);
        });
      });
      const info = featureInfo(op.feature);
      const params = {
        feature: op.feature,
        candidates: region.filter((i) => !excluded.has(i)).map((i) => this.cellXY(i)),
        density: op.density,
        minSpacing: op.minSpacing ?? 1,
        avoid: new Set<AvoidKind>(op.avoid ?? ["water", "walls", "features", "links"]),
        randomRotation: op.randomRotation ?? info.organic,
        seed: elementSeed(this.plan.seed, op.id, op.seed),
        remaining: cap - this.generated,
      };
      const res = scatterFeatures(grid, op.variants ? { ...params, variants: op.variants } : params);
      this.commitGenerated(op.id, res.placements);
      if (res.capped) capWarn(op.id, path);
    }
  }

  // ───────────────────────────── step 10 + output ─────────────────────────────

  toResolved(): ResolvedLevel {
    const { w, h, n } = this;
    // materials in first-appearance order (row-major)
    const materials: Material[] = [];
    const matMap = new Map<number, number>();
    const material: number[] = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (!this.isFloor(i)) continue;
      const m = this.mat[i] as number;
      if (m === 0) continue;
      let k = matMap.get(m);
      if (k === undefined) {
        k = materials.length;
        materials.push(MATERIALS[m - 1] as Material);
        matMap.set(m, k);
      }
      material[i] = k + 1;
    }
    const height: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) height[i] = this.state[i] === CELL.OPEN ? (this.height[i] as number) : 0;

    // wall styles + edge grids
    const wallStyles: WallStyle[] = [];
    const styleIdx = (s: WallStyle): number => {
      let k = wallStyles.indexOf(s);
      if (k < 0) {
        k = wallStyles.length;
        wallStyles.push(s);
      }
      return k;
    };
    const grid = (orient: "h" | "v", e: EdgeArrays): ResolvedLevel["hEdges"] => {
      const len = e.kind.length;
      const kind = new Array<number>(len);
      const ref = new Array<number>(len);
      const hgt = new Array<number>(len);
      const host = new Array<number>(len);
      for (let i = 0; i < len; i++) {
        const k = e.kind[i] as number;
        kind[i] = k;
        hgt[i] = k === EDGE.NONE ? 0 : (e.height[i] as number);
        if (k === EDGE.WALL) ref[i] = styleIdx(e.style[i] ?? "wall");
        else if (k === EDGE.OPENING) ref[i] = e.ref[i] as number;
        else ref[i] = 0xffff;
        if (k === EDGE.WALL || k === EDGE.OPENING) {
          const [a, b] = this.edgeCells(orient, i);
          host[i] = this.hostOf(a, b, e.run[i] === 1);
        } else host[i] = 0;
      }
      return { kind, ref, height: hgt, host };
    };
    const hEdges = grid("h", this.hE);
    const vEdges = grid("v", this.vE);

    // areas
    const dispCells: number[][] = this.areas.map(() => []);
    for (let i = 0; i < n; i++) {
      const d = this.disp[i] as number;
      if (d > 0) (dispCells[d - 1] as number[]).push(i);
    }
    const areas: ResolvedArea[] = this.areas.map((info) => {
      const cells = dispCells[info.index] as number[];
      const openCells = cells.filter((i) => this.state[i] === CELL.OPEN);
      if (cells.length === 0) {
        this.issue(
          "error",
          "area_empty",
          info.isRoute
            ? `corridor "${info.area.id}" has no cells: its endpoints already touch or every cell on its path belongs to another area`
            : `area "${info.area.id}" has no cells (its shape is empty, outside the level, or covered by later areas)`,
          {
            path: `/levels/${this.li}/areas/${info.index}`,
            elementId: info.area.id,
            hint: info.isRoute
              ? "remove the route and add an opening between the two areas"
              : "move it, enlarge it, or reorder areas",
          },
        );
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const i of cells) {
        const [x, y] = this.cellXY(i);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const bbox =
        cells.length > 0
          ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
          : { x: this.bx, y: this.by, w: 0, h: 0 };
      const anchor = this.anchorOf(openCells.length > 0 ? openCells : cells) ?? [this.bx, this.by];
      const set = new Uint8Array(n);
      for (const i of cells) set[i] = 1;
      const outline =
        cells.length > 0
          ? traceRings(
              bbox.w,
              bbox.h,
              (ux, uy) => set[(bbox.y - this.by + uy) * w + (bbox.x - this.bx + ux)] === 1,
              bbox.x,
              bbox.y,
            )
          : [];
      const ra: ResolvedArea = {
        id: info.area.id,
        kind: info.kind,
        theme: info.theme,
        cellCount: cells.length,
        bbox,
        anchor,
        outline,
      };
      if (info.area.name !== undefined) ra.name = info.area.name;
      if (info.area.key !== undefined) ra.key = info.area.key;
      if (info.area.notes !== undefined) ra.notes = info.area.notes;
      if (info.area.labelAt !== undefined) ra.labelAt = [info.area.labelAt[0], info.area.labelAt[1]];
      return ra;
    });

    const lvl: ResolvedLevel = {
      id: this.level.id,
      name: this.level.name,
      elevation: this.level.elevation,
      bounds: { x: this.bx, y: this.by, w, h },
      cells: {
        state: Array.from(this.state),
        area: Array.from(this.disp),
        material,
        height,
        flags: Array.from(this.flags),
        theme: Array.from(this.theme),
      },
      areaIds: this.areas.map((a) => a.area.id),
      materials,
      themes: this.themes.slice(),
      wallStyles,
      hEdges,
      vEdges,
      areas,
      openings: this.openings,
      features: this.features,
      labels: this.level.labels.map((l) => ({
        id: l.id,
        text: l.text,
        at: [l.at[0], l.at[1]] as Vec2,
        size: l.size ?? "m",
      })),
    };
    return lvl;
  }

  /** Structural owner array (zones transparent) — used by geometric validation. */
  structuralOwners(): Int32Array {
    return this.struct;
  }
}

/** Orientation of the edge crossed when stepping from cell a to the 4-adjacent cell b. */
function crossOrient(a: Vec2, b: Vec2): "h" | "v" {
  return a[1] !== b[1] ? "h" : "v";
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
  };
}
