/**
 * Playability checks: does the map make sense to walk around in, not only is it well formed?
 * Works on the resolved grid only (the same geometry the compiler builds), so it can also run on realized
 * geometry: the compiler passes extra blocked cells / opening sides through PlayabilityOptions and reuses
 * WalkGraph for its own reachability instead of writing a second pathfinder.
 *
 * Severity policy (shared with the compiler's verify stage):
 *   error   = the map is unusable as designed (an intended room cannot be reached, a blocked only door,
 *             stairs you cannot get onto or off);
 *   warning = a likely mistake (a door into rock, a bookshelf in mid-room, a corridor plugged by furniture);
 *   info    = a note (reachable only through a secret door, a door that leads off the map).
 */
import type {
  AreaId,
  LevelId,
  MapPlan,
  PlanIssue,
  PlanIssueCode,
  Severity,
  Side,
  Vec2,
} from "../contracts/plan";
import type { ResolvedLevel, ResolvedLink, ResolvedOpening, ResolvedPlan } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";
import { isPassage, isSecret } from "../gen/openingKinds";
import { OPPOSITE, SIDES, SIDE_STEP as DIRS } from "../gen/gridGeometry";
import { sideEdgeIndex } from "./levelGrid";
import { entryLevelId, linkKindInfo } from "../plan/links";
import { exhaustive } from "../util/never";
import { MAX_LEVEL_SIDE } from "../plan/sizeTiers";

// ───────────────────────────── options and walk modes ─────────────────────────────

export interface PlayabilityOptions {
  /** Extra blocked cells per level, as local cell indices (ly * w + lx), e.g. cells the built props occupy. */
  extraBlocked?: Record<LevelId, Iterable<number>>;
  /** Openings whose side is blocked in the built geometry (0 = north/west cell, 1 = south/east cell). */
  extraBlockedOpenings?: Record<LevelId, Array<{ openingId: string; side: 0 | 1 | "both"; reason?: string }>>;
  /** Run only these check groups (default: all). */
  checks?: PlayabilityCheck[];
}

export type PlayabilityCheck = "openings" | "reachability" | "links" | "passages" | "features" | "routes";

export interface WalkMode {
  /** Secret doors are passable. */
  secret: boolean;
  /** Blocking features (and extra blocked cells) do not block. */
  ignoreFeatures?: boolean;
  /** Deep water does not block. */
  ignoreWater?: boolean;
  /** Stairwell holes do not block. */
  ignoreStairwells?: boolean;
  /** Also allow climbing UP through trapdoors (they are walkable downwards only: nothing to climb). */
  trapdoorUp?: boolean;
}

/** A cell on a level: local index ly * w + lx. */
export interface LevelCell {
  levelId: LevelId;
  cell: number;
}

const MAX_STEP_QUARTERS = 2; // a 0.5-tile step can be walked; more needs stairs

interface LevelData {
  l: ResolvedLevel;
  li: number;
  w: number;
  h: number;
  /** Index + 1 of the blocking feature covering the cell; 0 = none. */
  featAt: Int32Array;
  extra: Uint8Array;
  extraReason: Map<number, string>;
  deep: number;
  /** Material index + 1 of lava (never walkable, never swimmable); 0 = none on this level. */
  lava: number;
  linkLower: Map<number, ResolvedLink>;
  linkUpper: Map<number, ResolvedLink>;
  blockedOpening: Map<string, { sides: Set<0 | 1>; reason?: string }>;
}

/**
 * The walking graph of a resolved plan: cells, passable edges (walls block; doors and archways pass; windows
 * and bars do not; secret doors per mode; steps of more than 0.5 tile block) and level links.
 */
export class WalkGraph {
  readonly levels: LevelData[];
  readonly byId = new Map<LevelId, LevelData>();
  /** Directed link transitions: "li:cell" → targets. */
  private readonly linkMoves = new Map<string, Array<[number, number]>>();
  /** Upward trapdoor moves, used only when WalkMode.trapdoorUp is set. */
  private readonly trapdoorUpMoves = new Map<string, Array<[number, number]>>();
  /** Plan has at least one trapdoor link. */
  hasTrapdoors = false;

  constructor(
    readonly resolved: ResolvedPlan,
    options: PlayabilityOptions = {},
  ) {
    this.levels = resolved.levels.map((l, li) => {
      const w = l.bounds.w;
      const h = l.bounds.h;
      const featAt = new Int32Array(w * h);
      l.features.forEach((f, k) => {
        if (!f.blocking) return;
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) {
            const lx = x - l.bounds.x;
            const ly = y - l.bounds.y;
            if (lx >= 0 && ly >= 0 && lx < w && ly < h && featAt[ly * w + lx] === 0)
              featAt[ly * w + lx] = k + 1;
          }
      });
      const extra = new Uint8Array(w * h);
      for (const i of options.extraBlocked?.[l.id] ?? []) if (i >= 0 && i < w * h) extra[i] = 1;
      const blockedOpening = new Map<string, { sides: Set<0 | 1>; reason?: string }>();
      for (const b of options.extraBlockedOpenings?.[l.id] ?? []) {
        const e = blockedOpening.get(b.openingId) ?? { sides: new Set<0 | 1>() };
        if (b.side === "both" || b.side === 0) e.sides.add(0);
        if (b.side === "both" || b.side === 1) e.sides.add(1);
        if (b.reason !== undefined) e.reason = b.reason;
        blockedOpening.set(b.openingId, e);
      }
      const d: LevelData = {
        l,
        li,
        w,
        h,
        featAt,
        extra,
        extraReason: new Map(),
        deep: l.materials.indexOf("water_deep") + 1,
        lava: l.materials.indexOf("lava") + 1,
        linkLower: new Map(),
        linkUpper: new Map(),
        blockedOpening,
      };
      this.byId.set(l.id, d);
      return d;
    });
    for (const link of resolved.links) {
      const lo = this.byId.get(link.fromLevel);
      const up = this.byId.get(link.toLevel);
      if (!lo || !up) continue;
      for (const c of link.lowerCells) {
        const i = this.idx(lo, c[0], c[1]);
        if (i >= 0 && !lo.linkLower.has(i)) lo.linkLower.set(i, link);
      }
      for (const c of link.upperCells) {
        const i = this.idx(up, c[0], c[1]);
        if (i >= 0 && !up.linkUpper.has(i)) up.linkUpper.set(i, link);
      }
      this.addLinkMoves(link, lo, up);
    }
  }

  idx(d: LevelData, gx: number, gy: number): number {
    const lx = gx - d.l.bounds.x;
    const ly = gy - d.l.bounds.y;
    return lx < 0 || ly < 0 || lx >= d.w || ly >= d.h ? -1 : ly * d.w + lx;
  }

  xy(d: LevelData, i: number): Vec2 {
    return [d.l.bounds.x + (i % d.w), d.l.bounds.y + Math.floor(i / d.w)];
  }

  private move(from: [number, number], to: [number, number]): void {
    const k = `${from[0]}:${from[1]}`;
    const list = this.linkMoves.get(k);
    if (list) list.push(to);
    else this.linkMoves.set(k, [to]);
  }

  /** Top cells of a stair/ramp run with the cell one step further in the ascent direction. */
  static runTop(link: ResolvedLink): Array<{ top: Vec2; beyond: Vec2 }> {
    const [dx, dy] = DIRS[link.dir];
    const set = new Set(link.lowerCells.map((c) => `${c[0]},${c[1]}`));
    return link.lowerCells
      .filter((c) => !set.has(`${c[0] + dx},${c[1] + dy}`))
      .map((c) => ({ top: c, beyond: [c[0] + dx, c[1] + dy] }));
  }

  /** Bottom cells of a stair/ramp run with the approach cell one step before them. */
  static runBottom(link: ResolvedLink): Array<{ bottom: Vec2; before: Vec2 }> {
    const [dx, dy] = DIRS[link.dir];
    const set = new Set(link.lowerCells.map((c) => `${c[0]},${c[1]}`));
    return link.lowerCells
      .filter((c) => !set.has(`${c[0] - dx},${c[1] - dy}`))
      .map((c) => ({ bottom: c, before: [c[0] - dx, c[1] - dy] }));
  }

  /** Cells 4-adjacent to a footprint, outside it. */
  static ring(cells: readonly Vec2[]): Vec2[] {
    const set = new Set(cells.map((c) => `${c[0]},${c[1]}`));
    const out: Vec2[] = [];
    const seen = new Set<string>();
    for (const [x, y] of cells)
      for (const [dx, dy] of Object.values(DIRS)) {
        const k = `${x + dx},${y + dy}`;
        if (set.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push([x + dx, y + dy]);
      }
    return out;
  }

  private addLinkMoves(link: ResolvedLink, lo: LevelData, up: LevelData): void {
    const both = (a: [number, number], b: [number, number]): void => {
      this.move(a, b);
      this.move(b, a);
    };
    const L = (c: Vec2): [number, number] => [lo.li, this.idx(lo, c[0], c[1])];
    const U = (c: Vec2): [number, number] => [up.li, this.idx(up, c[0], c[1])];
    const ok = (p: [number, number]): boolean => p[1] >= 0;
    switch (link.kind) {
      case "stairs":
      case "ramp":
        // the top step leads onto the landing only if the upper level has no wall on that edge
        for (const { top, beyond } of WalkGraph.runTop(link))
          if (ok(L(top)) && ok(U(beyond)) && this.edgeOpen(up, top, link.dir)) both(L(top), U(beyond));
        break;
      case "trapdoor":
        // down only: the build places a hatch in the upper floor with nothing to climb back up
        this.hasTrapdoors = true;
        for (const c of link.lowerCells)
          if (ok(L(c)) && ok(U(c))) {
            this.move(U(c), L(c));
            const k = `${lo.li}:${L(c)[1]}`;
            const list = this.trapdoorUpMoves.get(k);
            if (list) list.push(U(c));
            else this.trapdoorUpMoves.set(k, [U(c)]);
          }
        break;
      case "pit_drop":
        for (const n of WalkGraph.ring(link.upperCells))
          for (const c of link.lowerCells) if (ok(U(n)) && ok(L(c))) this.move(U(n), L(c));
        break;
      case "ladder":
      case "spiral_stairs":
        // climb out onto any cell beside the hole
        for (const n of WalkGraph.ring(link.upperCells))
          for (const c of link.lowerCells) if (ok(U(n)) && ok(L(c))) both(L(c), U(n));
        break;
      default:
        exhaustive(link.kind, "link kind");
    }
  }

  /** True when the edge on `side` of global cell `c` is not a wall (or other impassable edge) on level d. */
  edgeOpen(d: LevelData, c: Vec2, side: Side): boolean {
    const i = this.idx(d, c[0], c[1]);
    if (i < 0) return false;
    return this.step(d, i, side, { secret: true, ignoreFeatures: true })[1];
  }

  /** Can a person stand on this cell? */
  walkable(d: LevelData, i: number, m: WalkMode): boolean {
    if (i < 0 || i >= d.w * d.h) return false;
    const l = d.l;
    if (l.cells.state[i] !== CELL.OPEN) return false;
    const f = l.cells.flags[i] as number;
    if (f & CELL_FLAG.NO_FLOOR && !(m.ignoreStairwells === true && f & CELL_FLAG.STAIRWELL)) return false;
    if (m.ignoreFeatures !== true && ((d.featAt[i] as number) > 0 || d.extra[i] === 1)) return false;
    if (m.ignoreWater !== true && d.deep > 0 && l.cells.material[i] === d.deep) return false;
    if (d.lava > 0 && l.cells.material[i] === d.lava) return false;
    return true;
  }

  /** Edge from cell i toward `side`: [neighbour index or -1, passable]. */
  step(d: LevelData, i: number, side: Side, m: WalkMode): [number, boolean] {
    const { w, h, l } = d;
    const lx = i % w;
    const ly = (i - lx) / w;
    let j: number;
    let kind: number;
    let ref: number;
    let height: number;
    const e = sideEdgeIndex(d, lx, ly, side);
    if (side === "N" || side === "S") {
      j = side === "N" ? (ly > 0 ? i - w : -1) : ly < h - 1 ? i + w : -1;
      kind = l.hEdges.kind[e] as number;
      ref = l.hEdges.ref[e] as number;
      height = l.hEdges.height[e] as number;
    } else {
      j = side === "W" ? (lx > 0 ? i - 1 : -1) : lx < w - 1 ? i + 1 : -1;
      kind = l.vEdges.kind[e] as number;
      ref = l.vEdges.ref[e] as number;
      height = l.vEdges.height[e] as number;
    }
    if (j < 0) return [-1, false];
    if (kind === EDGE.WALL) return [j, false];
    if (kind === EDGE.STAIR) return [j, true]; // a flight of steps: walkable whatever the height
    if (kind === EDGE.LEDGE) return [j, height * 4 <= MAX_STEP_QUARTERS];
    if (Math.abs((l.cells.height[i] as number) - (l.cells.height[j] as number)) > MAX_STEP_QUARTERS)
      return [j, false];
    if (kind === EDGE.OPENING) {
      const o = l.openings[ref];
      if (!o) return [j, true];
      if (!isPassage(o.kind)) return [j, false];
      if (isSecret(o.kind) && !m.secret) return [j, false];
      if (m.ignoreFeatures !== true && d.blockedOpening.has(o.id)) return [j, false];
    }
    return [j, true];
  }

  /** Breadth-first walk from the given cells; returns a reached mask per level (same order as resolved.levels). */
  flood(starts: Iterable<readonly [number, number]>, m: WalkMode): Uint8Array[] {
    return this.walk(starts, m, null);
  }

  /**
   * The same walk, also recording the cell each cell was first reached from: `from[li][i]` is the parent's level index
   * times PARENT_STRIDE plus its cell index, -1 for a start or a cell not reached.
   */
  floodWithParents(
    starts: Iterable<readonly [number, number]>,
    m: WalkMode,
  ): { reached: Uint8Array[]; from: Int32Array[] } {
    const from = this.levels.map((d) => new Int32Array(d.w * d.h).fill(-1));
    return { reached: this.walk(starts, m, from), from };
  }

  private walk(
    starts: Iterable<readonly [number, number]>,
    m: WalkMode,
    from: Int32Array[] | null,
  ): Uint8Array[] {
    const reached = this.levels.map((d) => new Uint8Array(d.w * d.h));
    const queue: Array<[number, number]> = [];
    const push = (li: number, i: number, parent: number): void => {
      const d = this.levels[li];
      const r = reached[li];
      if (!d || !r || i < 0 || r[i] === 1 || !this.walkable(d, i, m)) return;
      r[i] = 1;
      if (from) (from[li] as Int32Array)[i] = parent;
      queue.push([li, i]);
    };
    for (const [li, i] of starts) push(li, i, -1);
    for (let head = 0; head < queue.length; head++) {
      const [li, i] = queue[head] as [number, number];
      const d = this.levels[li] as LevelData;
      const here = li * PARENT_STRIDE + i;
      for (const s of SIDES) {
        const [j, pass] = this.step(d, i, s, m);
        if (pass) push(li, j, here);
      }
      for (const [tl, ti] of this.linkMoves.get(`${li}:${i}`) ?? []) push(tl, ti, here);
      if (m.trapdoorUp === true)
        for (const [tl, ti] of this.trapdoorUpMoves.get(`${li}:${i}`) ?? []) push(tl, ti, here);
    }
    return reached;
  }

  /**
   * Entry points: the entry level's lowest-key area and the outside side of every "@outside" opening. `entry` is the
   * plan's entry level (plan/links.ts `entryLevelId`, the one rule).
   */
  starts(entry: LevelId | undefined): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const ed = entry !== undefined ? this.byId.get(entry) : undefined;
    if (ed) {
      const keyed = ed.l.areas
        .map((a, ai) => ({ a, ai }))
        .filter((x) => x.a.key !== undefined && x.a.cellCount > 0 && x.a.kind !== "zone")
        .sort((p, q) => keyOrder(p.a.key as string, q.a.key as string));
      const first = keyed[0];
      if (first) ed.l.cells.area.forEach((a, i) => (a === first.ai + 1 ? out.push([ed.li, i]) : undefined));
      else
        ed.l.cells.area.forEach((a, i) =>
          a === 0 && ed.l.cells.state[i] === CELL.OPEN ? out.push([ed.li, i]) : undefined,
        );
      // no keyed area and no open ground: the first (non-zone) area in plan order is the entrance
      if (out.length === 0) {
        const firstArea = ed.l.areas.findIndex((a) => a.kind !== "zone" && a.cellCount > 0);
        if (firstArea >= 0)
          ed.l.cells.area.forEach((a, i) =>
            a === firstArea + 1 && ed.l.cells.state[i] === CELL.OPEN ? out.push([ed.li, i]) : undefined,
          );
      }
      if (out.length === 0)
        ed.l.cells.state.forEach((s, i) => (s === CELL.OPEN ? out.push([ed.li, i]) : undefined));
    }
    for (const d of this.levels) {
      for (const o of d.l.openings) {
        if (o.sides[0] !== null && o.sides[1] !== null) continue;
        openingSideCells(this, d, o).forEach((cells, side) => {
          if (o.sides[side] === null) for (const i of cells) if (i >= 0) out.push([d.li, i]);
        });
      }
    }
    return out;
  }
}

function keyOrder(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Local cell indices on each side of an opening ([side 0 = N/W cells, side 1 = S/E cells]); -1 off the map. */
function openingSideCells(g: WalkGraph, d: LevelData, o: ResolvedOpening): [number[], number[]] {
  const a: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < o.width; k++) {
    if (o.orientation === "h") {
      a.push(g.idx(d, o.start[0] + k, o.start[1] - 1));
      b.push(g.idx(d, o.start[0] + k, o.start[1]));
    } else {
      a.push(g.idx(d, o.start[0] - 1, o.start[1] + k));
      b.push(g.idx(d, o.start[0], o.start[1] + k));
    }
  }
  return [a, b];
}

/**
 * Lower-level reachability for other stages (the compiler's verify stage): which cells can be walked to from
 * the plan's entry points. Returns a mask per level id.
 */
export function walkReachability(
  plan: MapPlan,
  resolved: ResolvedPlan,
  options: PlayabilityOptions = {},
  mode: WalkMode = { secret: true },
): Map<LevelId, Uint8Array> {
  return walkPathsFrom(resolved, entryLevelId(plan), options, mode).reached;
}

/** A cell of the walk: its level id and plan cell. */
export interface WalkCell {
  readonly levelId: LevelId;
  readonly cell: Vec2;
}

/** The walk from a plan's entry points, with the way the walk first reached each cell (shortest in steps). */
export interface WalkPaths {
  /** Reached mask per level id. */
  readonly reached: Map<LevelId, Uint8Array>;
  /** The cells from an entry point to a cell of the level (local index), in walking order; [] when not reached. */
  pathTo(levelId: LevelId, index: number): WalkCell[];
}

/**
 * The walk from the entry points of level `entry` (plan/links.ts `entryLevelId`) and the "@outside" openings, with
 * paths: the compiler's verify stage names the first thing in the way on the path to an area the build cuts off.
 */
export function walkPathsFrom(
  resolved: ResolvedPlan,
  entry: LevelId | undefined,
  options: PlayabilityOptions = {},
  mode: WalkMode = { secret: true },
): WalkPaths {
  const g = new WalkGraph(resolved, options);
  const { reached, from } = g.floodWithParents(g.starts(entry), mode);
  const at = new Map(g.levels.map((d) => [d.l.id, d]));
  return {
    reached: new Map(g.levels.map((d, k) => [d.l.id, reached[k] as Uint8Array])),
    pathTo(levelId, index) {
      const d = at.get(levelId);
      if (!d || reached[d.li]?.[index] !== 1) return [];
      const out: WalkCell[] = [];
      let li = d.li;
      let i = index;
      while (li >= 0) {
        const dl = g.levels[li] as LevelData;
        out.push({ levelId: dl.l.id, cell: g.xy(dl, i) });
        const p = from[li]?.[i] ?? -1;
        if (p < 0) break;
        li = Math.floor(p / PARENT_STRIDE);
        i = p % PARENT_STRIDE;
      }
      return out.reverse();
    },
  };
}

/** Parents are stored as level index * stride + cell index (a level has at most MAX_LEVEL_SIDE² cells; 8 levels of 1024² fit an Int32). */
const PARENT_STRIDE = MAX_LEVEL_SIDE * MAX_LEVEL_SIDE;

// ───────────────────────────── the checks ─────────────────────────────

/**
 * The playability checks in issue order. Every check reads the context (`PlayCtx`: the walk graph, the plan, the one
 * issue writer and the naming helpers); the floods and the ways into each area are computed once and passed on, and
 * the blockers the reachability check names (`blamed`) are handed to the checks after it, which do not name them again.
 */
export function checkPlayability(
  plan: MapPlan,
  resolved: ResolvedPlan,
  options: PlayabilityOptions = {},
): PlanIssue[] {
  const ctx = playCtx(plan, resolved, options);
  const want = (c: PlayabilityCheck): boolean => !options.checks || options.checks.includes(c);
  const walks = structuralWalks(ctx);
  const waysIn = countWaysIn(ctx);
  const blamed = want("reachability") ? checkAreaReach(ctx, walks, waysIn) : new Set<string>();
  if (want("openings")) checkOpeningUse(ctx, waysIn, blamed);
  if (want("links")) checkLinkUse(ctx);
  if (want("passages")) checkCorridorPlugs(ctx, blamed);
  if (want("features")) checkFurnitureSense(ctx);
  if (want("routes")) checkRouteEnds(ctx);
  return ctx.out;
}

/** What every playability check reads: the walk graph, the plan, the issue list and its writer, naming helpers. */
function playCtx(plan: MapPlan, resolved: ResolvedPlan, options: PlayabilityOptions) {
  const g = new WalkGraph(resolved, options);
  const out: PlanIssue[] = [];
  const levelPath = (id: string): number => plan.levels.findIndex((l) => l.id === id);
  const issue = (
    d: LevelData,
    severity: Severity,
    code: PlanIssueCode,
    message: string,
    hint: string,
    elementId: string | undefined,
    cell: Vec2 | undefined,
    path?: string,
  ): void => {
    const is: PlanIssue = { severity, code, message, hint, levelId: d.l.id };
    if (elementId !== undefined) is.elementId = elementId;
    if (cell !== undefined) is.cell = cell;
    is.path = path ?? `/levels/${levelPath(d.l.id)}`;
    out.push(is);
  };
  const xy = (d: LevelData, i: number): Vec2 => g.xy(d, i);
  const at = (c: Vec2): string => `${c[0]},${c[1]}`;
  const areaName = (d: LevelData, id: string | null): string => {
    if (id === null) return "outside";
    const a = d.l.areas.find((r) => r.id === id);
    if (!a) return id;
    return a.key !== undefined ? `room ${a.key}${a.name ? ` (${a.name})` : ""}` : (a.name ?? id);
  };
  const featName = (d: LevelData, k: number): string => {
    const f = d.l.features[k - 1];
    return f ? `the ${featureInfo(f.type).label.toLowerCase()} "${f.id}"` : "a feature";
  };
  /** What makes a cell unusable (null = nothing). */
  const blockerAt = (d: LevelData, i: number): { what: string; id?: string } | null => {
    if (i < 0) return { what: "the map edge" };
    const l = d.l;
    if (l.cells.state[i] === CELL.SOLID) return { what: "solid rock" };
    if (l.cells.state[i] === CELL.VOID) return { what: "empty air" };
    const link = d.linkLower.get(i) ?? d.linkUpper.get(i);
    if (link) return { what: `the ${link.kind.replace("_", " ")} "${link.id}"`, id: link.id };
    const f = (l.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR;
    if (f) return { what: "a hole in the floor" };
    const k = d.featAt[i] as number;
    if (k > 0) return { what: featName(d, k), id: d.l.features[k - 1]?.id ?? "" };
    if (d.extra[i] === 1) return { what: d.extraReason.get(i) ?? "built geometry" };
    if (d.deep > 0 && l.cells.material[i] === d.deep) return { what: "deep water" };
    if (d.lava > 0 && l.cells.material[i] === d.lava) return { what: "lava" };
    return null;
  };
  return { g, plan, out, issue, levelPath, xy, at, areaName, blockerAt };
}

type PlayCtx = ReturnType<typeof playCtx>;

/** Structural reachability from the plan's starts, computed once: with and without secret doors, loose, and up trapdoors. */
function structuralWalks({ g, plan }: PlayCtx) {
  const starts = g.starts(entryLevelId(plan));
  // deep water is swimmable for reachability (a door opening straight into it is still flagged above)
  const reached = g.flood(starts, { secret: true, ignoreWater: true });
  const reachedNoSecret = g.flood(starts, { secret: false, ignoreWater: true });
  const reachedLoose = g.flood(starts, {
    secret: true,
    ignoreFeatures: true,
    ignoreWater: true,
    ignoreStairwells: true,
  });

  const reachedTrapUp = g.hasTrapdoors
    ? g.flood(starts, { secret: true, ignoreWater: true, trapdoorUp: true })
    : null;
  return { starts, reached, reachedNoSecret, reachedLoose, reachedTrapUp };
}

type StructuralWalks = ReturnType<typeof structuralWalks>;

/** Passable (non-secret) openings and links touching each area ("level|area"), for "only way in" decisions. */
function countWaysIn({ g }: PlayCtx): ReadonlyMap<string, number> {
  const waysIn = new Map<string, number>();
  for (const d of g.levels) {
    for (const o of d.l.openings) {
      if (!isPassage(o.kind) || isSecret(o.kind)) continue;
      for (const s of o.sides)
        if (s !== null) waysIn.set(`${d.l.id}|${s}`, (waysIn.get(`${d.l.id}|${s}`) ?? 0) + 1);
    }
    for (const link of g.resolved.links) {
      for (const [lid, cells] of [
        [link.fromLevel, link.lowerCells],
        [link.toLevel, WalkGraph.ring(link.upperCells)],
      ] as const) {
        if (lid !== d.l.id) continue;
        const ids = new Set<string>();
        for (const c of cells) {
          const i = g.idx(d, c[0], c[1]);
          const a = i >= 0 ? (d.l.cells.area[i] as number) : 0;
          if (a > 0) ids.add(d.l.areaIds[a - 1] as string);
        }
        for (const id of ids) waysIn.set(`${d.l.id}|${id}`, (waysIn.get(`${d.l.id}|${id}`) ?? 0) + 1);
      }
    }
  }
  return waysIn;
}

/**
 * (b) Reachability on foot, sealed rooms, secret-only rooms. Returns the blockers it named (an unreachable issue): the
 * later checks do not report them again under another code.
 */
function checkAreaReach(
  ctx: PlayCtx,
  { starts, reached, reachedNoSecret, reachedLoose, reachedTrapUp }: StructuralWalks,
  waysIn: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  const { g, plan, issue, levelPath, at, areaName } = ctx;
  const blamed = new Set<string>();
  for (const d of g.levels) {
    const r = reached[d.li] as Uint8Array;
    const r0 = reachedNoSecret[d.li] as Uint8Array;
    const rl = reachedLoose[d.li] as Uint8Array;
    const isStart = new Set(starts.filter(([li]) => li === d.li).map(([, i]) => d.l.cells.area[i] as number));
    d.l.areas.forEach((a, ai) => {
      if (a.kind === "zone" || a.cellCount === 0) return;
      const cells: number[] = [];
      d.l.cells.area.forEach((v, i) => {
        if (
          v === ai + 1 &&
          d.l.cells.state[i] === CELL.OPEN &&
          ((d.l.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0
        )
          cells.push(i);
      });
      if (cells.length === 0 || isStart.has(ai + 1)) return;
      const name = areaName(d, a.id);
      const intended = a.key !== undefined;
      const path = `/levels/${levelPath(d.l.id)}/areas/${plan.levels[levelPath(d.l.id)]?.areas.findIndex((p) => p.id === a.id) ?? -1}`;
      // sealed: no passable edge out (secret doors count, furniture ignored) and no level link touching it
      const inArea = new Set(cells);
      let sealed = (waysIn.get(`${d.l.id}|${a.id}`) ?? 0) === 0;
      if (sealed) {
        outer: for (const i of cells) {
          for (const s of SIDES) {
            const [j, pass] = g.step(d, i, s, { secret: true, ignoreFeatures: true });
            if (pass && j >= 0 && !inArea.has(j) && d.l.cells.state[j] === CELL.OPEN) {
              sealed = false;
              break outer;
            }
          }
        }
      }
      if (sealed) {
        issue(
          d,
          intended ? "error" : "warning",
          "area_sealed",
          `${cap(name)} has no door, opening or stairs: it is walled in.`,
          `add an opening between ["${a.id}", "<neighbouring area or @outside>"] or a level link into it`,
          a.id,
          a.anchor,
          path,
        );
        return;
      }
      if (cells.some((i) => r[i] === 1)) {
        const behindSecret = d.l.openings.some((o) => isSecret(o.kind) && o.sides.includes(a.id));
        if (behindSecret && !cells.some((i) => r0[i] === 1))
          issue(
            d,
            "info",
            "reachable_secret_only",
            `${cap(name)} can only be reached through a secret door.`,
            `fine if intended; otherwise add a normal door into "${a.id}"`,
            a.id,
            a.anchor,
            path,
          );
        return;
      }
      // only reachable by climbing up through a trapdoor: warning, the fix is a ladder
      const viaTrap = reachedTrapUp?.[d.li];
      if (viaTrap && cells.some((i) => viaTrap[i] === 1)) {
        const trap = g.resolved.links.find((l) => linkKindInfo(l.kind).hatch && l.toLevel === d.l.id);
        issue(
          d,
          "warning",
          "unreachable",
          `${cap(name)} can only be reached by climbing up through the trapdoor${trap ? ` "${trap.id}"` : ""}, and there is nothing to climb.`,
          "add a ladder link beside the trapdoor",
          a.id,
          trap ? trap.arrival : a.anchor,
          path,
        );
        return;
      }
      // not reachable on foot: find the single blocker if the layout itself connects
      let blocker: { what: string; id?: string; cell?: Vec2 } | null = null;
      if (cells.some((i) => rl[i] === 1)) blocker = findBlocker(g, d, cells, r);
      const severity: Severity = intended ? "error" : "warning";
      // A blocker standing in front of the area's only door is reported once, as that door's
      // opening_blocked (error), whatever the keys: suppress the unreachable issue for it.
      if (blocker?.cell && (waysIn.get(`${d.l.id}|${a.id}`) ?? 0) <= 1) {
        const bi = g.idx(d, blocker.cell[0], blocker.cell[1]);
        const atDoor = d.l.openings.some(
          (o) => isPassage(o.kind) && openingSideCells(g, d, o).some((side) => side.includes(bi)),
        );
        if (atDoor) return;
      }
      if (blocker) {
        if (blocker.id !== undefined) blamed.add(blocker.id);
        issue(
          d,
          severity,
          "unreachable",
          `${cap(name)} can't be reached on foot: ${blocker.what} blocks the only way in${blocker.cell ? ` at ${at(blocker.cell)}` : ""}.`,
          blocker.id !== undefined ? `move or remove "${blocker.id}"` : "clear a path into the area",
          a.id,
          blocker.cell ?? a.anchor,
          path,
        );
      } else {
        const nb = neighbourArea(g, d, cells, r);
        issue(
          d,
          severity,
          "unreachable",
          `${cap(name)} can't be reached from the entrance.`,
          nb !== null
            ? `add an opening between ["${a.id}", "${nb}"]`
            : "connect it with a corridor (route), an opening, or a level link",
          a.id,
          a.anchor,
          path,
        );
      }
    });
  }
  return blamed;
}

/** (a) Door approaches and (f) doors that lead nowhere. */
function checkOpeningUse(
  ctx: PlayCtx,
  waysIn: ReadonlyMap<string, number>,
  blamed: ReadonlySet<string>,
): void {
  const { g, plan, issue, levelPath, xy, at, areaName, blockerAt } = ctx;
  for (const d of g.levels) {
    for (const o of d.l.openings) {
      if (!isPassage(o.kind)) continue;
      const planOpening = plan.levels[levelPath(d.l.id)]?.openings.find((p) => p.id === o.id);
      const markedExit =
        planOpening?.between?.includes("@outside") === true || planOpening?.label !== undefined;
      const sides = openingSideCells(g, d, o);
      const nowhere = sides.map((cells) => cells.every((i) => i < 0 || d.l.cells.state[i] !== CELL.OPEN));
      const kindName = o.kind.replace("_", " ");
      const where = `edge ${o.orientation} ${at(o.start)}`;
      if (nowhere[0] === true || nowhere[1] === true) {
        if (nowhere[0] === true && nowhere[1] === true) {
          issue(
            d,
            "warning",
            "opening_dead_end",
            `The ${kindName} "${o.id}" has no floor on either side.`,
            `remove "${o.id}" or move it onto a wall between two areas`,
            o.id,
            o.start,
          );
          continue;
        }
        const side = nowhere[0] === true ? 0 : 1;
        const cells = sides[side];
        const first = cells.find((i) => i >= 0) ?? -1;
        const into =
          first < 0
            ? "off the edge of the map"
            : d.l.cells.state[first] === CELL.SOLID
              ? "into solid rock"
              : "into empty air";
        const rock = first >= 0 && d.l.cells.state[first] === CELL.SOLID;
        if (!markedExit && !o.id.includes("~"))
          issue(
            d,
            rock ? "warning" : "info",
            "opening_dead_end",
            `The ${kindName} "${o.id}" (${where}) opens ${into}.`,
            rock
              ? `move "${o.id}" onto a wall shared with another area (use between: [a, b]) or add a corridor beyond it`
              : `if "${o.id}" is a way out of the map, set between: ["${o.sides[0] ?? o.sides[1] ?? "area"}", "@outside"]`,
            o.id,
            o.start,
          );
      }
      for (const side of [0, 1] as const) {
        if (nowhere[side] === true) continue;
        const cells = sides[side];
        const other = sides[side === 0 ? 1 : 0];
        const blocked = d.blockedOpening.get(o.id)?.sides.has(side) === true;
        const okCell = cells.findIndex((i, k) => {
          if (blocked || i < 0) return false;
          if (!g.walkable(d, i, { secret: true })) return false;
          if (d.linkLower.has(i) || d.linkUpper.has(i)) return false;
          const j = other[k] ?? -1;
          return !(
            j >= 0 &&
            Math.abs((d.l.cells.height[i] as number) - (d.l.cells.height[j] as number)) > MAX_STEP_QUARTERS
          );
        });
        if (okCell >= 0) continue;
        const i0 = cells[0] ?? -1;
        const j0 = other[0] ?? -1;
        let reason = blocked
          ? { what: d.blockedOpening.get(o.id)?.reason ?? "built geometry" }
          : blockerAt(d, i0);
        if (reason === null && i0 >= 0 && j0 >= 0) {
          const step = Math.abs((d.l.cells.height[i0] as number) - (d.l.cells.height[j0] as number)) / 4;
          reason = { what: `a ${step}-tile height step` };
        }
        if (reason?.id !== undefined && blamed.has(reason.id)) continue;
        const what = reason?.what ?? "an obstacle";
        const areaId = o.sides[side];
        const only = o.sides.some((s) => s !== null && (waysIn.get(`${d.l.id}|${s}`) ?? 0) <= 1);
        const secret = isSecret(o.kind);
        issue(
          d,
          secret ? "info" : only && what !== "deep water" ? "error" : "warning",
          "opening_blocked",
          `The ${kindName} "${o.id}" cannot be used from ${areaName(d, areaId)}: ${what} stands right in front of it at ${i0 >= 0 ? at(xy(d, i0)) : "the map edge"}.`,
          o.id.includes("~")
            ? `the corridor "${o.id.split("~")[0] ?? ""}" ends here; change its bend ("hv"/"vh") or its endpoint`
            : reason?.id !== undefined
              ? `move "${reason.id}" away from ${at(i0 >= 0 ? xy(d, i0) : o.start)} or move "${o.id}" along the wall`
              : `move "${o.id}" along the wall to a spot with open floor on both sides`,
          o.id,
          i0 >= 0 ? xy(d, i0) : o.start,
        );
      }
    }
  }
}

/** (c) Level links: approach, landing, run. */
function checkLinkUse(ctx: PlayCtx): void {
  const { g, issue, at, blockerAt } = ctx;
  g.resolved.links.forEach((link, k) => {
    const lo = g.byId.get(link.fromLevel);
    const up = g.byId.get(link.toLevel);
    const info = linkKindInfo(link.kind);
    // a link that lands nowhere you walk from (a pit drop) has no approach or landing to check
    if (!lo || !up || info.arrival === "none") return;
    const path = `/links/${k}`;
    const kind = link.kind.replace("_", " ");
    const free = (d: LevelData, c: Vec2): boolean => {
      const i = g.idx(d, c[0], c[1]);
      return g.walkable(d, i, { secret: true }) && !d.linkLower.has(i) && !d.linkUpper.has(i);
    };
    const describe = (d: LevelData, c: Vec2): { what: string; id?: string } =>
      blockerAt(d, g.idx(d, c[0], c[1])) ?? { what: "an obstacle" };
    if (info.footprint === "run") {
      // run must not cross a wall or doorway
      const [dx, dy] = DIRS[link.dir];
      for (const c of link.lowerCells) {
        const i = g.idx(lo, c[0], c[1]);
        const nxt: Vec2 = [c[0] + dx, c[1] + dy];
        if (i < 0 || !link.lowerCells.some((p) => p[0] === nxt[0] && p[1] === nxt[1])) continue;
        const [, pass] = g.step(lo, i, link.dir, { secret: true, ignoreFeatures: true });
        if (!pass) {
          issue(
            lo,
            "error",
            "link_run_blocked",
            `The ${kind} "${link.id}" run crosses a wall or doorway between ${at(c)} and ${at(nxt)}.`,
            `move from.at or change dir so the whole run lies inside one room`,
            link.id,
            c,
            path,
          );
          break;
        }
      }
      const bottoms = WalkGraph.runBottom(link);
      const usableBottom = bottoms.some(({ bottom, before }) => {
        const i = g.idx(lo, bottom[0], bottom[1]);
        const [j, pass] = g.step(lo, i, opposite(link.dir), { secret: true });
        return pass && j === g.idx(lo, before[0], before[1]) && free(lo, before);
      });
      if (!usableBottom && bottoms[0]) {
        const walled = !g.edgeOpen(lo, bottoms[0].bottom, opposite(link.dir));
        const b = walled ? { what: "a wall" } : describe(lo, bottoms[0].before);
        issue(
          lo,
          "error",
          "link_approach_blocked",
          `The ${kind} "${link.id}" can't be stepped onto: ${b.what} is at its foot (${at(bottoms[0].before)}).`,
          b.id !== undefined
            ? `move "${b.id}" off ${at(bottoms[0].before)}`
            : `turn the stairs (dir) or move from.at so the cell before ${at(link.lowerCells[0] ?? bottoms[0].bottom)} is open floor`,
          link.id,
          bottoms[0].before,
          path,
        );
      }
      const tops = WalkGraph.runTop(link);
      const usableTop = tops.some(({ top, beyond }) => free(up, beyond) && g.edgeOpen(up, top, link.dir));
      const topWalled = tops.length > 0 && tops.every(({ top }) => !g.edgeOpen(up, top, link.dir));
      const firstTop = tops[0];
      if (!usableTop && firstTop) {
        const i = g.idx(up, firstTop.beyond[0], firstTop.beyond[1]);
        const openFloor =
          i >= 0 &&
          up.l.cells.state[i] === CELL.OPEN &&
          ((up.l.cells.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0;
        if (openFloor && topWalled) {
          issue(
            up,
            "error",
            "link_approach_blocked",
            `The ${kind} "${link.id}" arrives at ${at(firstTop.beyond)} on ${up.l.name}, but a wall stands between the stairwell and that landing.`,
            `extend the upper area over the stairwell ${at(firstTop.top)} so no wall separates it from ${at(firstTop.beyond)}, or turn the stairs (dir)`,
            link.id,
            firstTop.beyond,
            path,
          );
        } else if (openFloor) {
          const b = describe(up, firstTop.beyond);
          issue(
            up,
            "error",
            "link_approach_blocked",
            `The ${kind} "${link.id}" arrives at ${at(firstTop.beyond)} on ${up.l.name}, but ${b.what} stands on the landing.`,
            b.id !== undefined
              ? `move "${b.id}" off the landing ${at(firstTop.beyond)}`
              : `clear ${at(firstTop.beyond)}`,
            link.id,
            firstTop.beyond,
            path,
          );
        }
      }
    } else {
      const lowRing = WalkGraph.ring(link.lowerCells);
      const upRing = WalkGraph.ring(info.hatch ? [] : link.upperCells);
      const lowOk = lowRing.some((c) => free(lo, c));
      const upOk = info.hatch ? true : upRing.some((c) => free(up, c));
      if (!lowOk)
        issue(
          lo,
          "error",
          "link_approach_blocked",
          `The ${kind} "${link.id}" at ${at(link.lowerCells[0] ?? [0, 0])} has no free floor beside it on ${lo.l.name}.`,
          `clear a cell next to ${at(link.lowerCells[0] ?? [0, 0])}`,
          link.id,
          link.lowerCells[0],
          path,
        );
      if (!upOk)
        issue(
          up,
          "error",
          "link_approach_blocked",
          `The ${kind} "${link.id}" comes up at ${at(link.arrival)} on ${up.l.name} with no free floor beside it.`,
          `clear a cell next to ${at(link.arrival)} on ${up.l.id}`,
          link.id,
          link.arrival,
          path,
        );
    }
  });
}

/** (d) Corridors plugged by furniture. */
function checkCorridorPlugs(ctx: PlayCtx, blamed: ReadonlySet<string>): void {
  const { g, issue, xy, at, blockerAt } = ctx;
  for (const d of g.levels) {
    d.l.areas.forEach((a, ai) => {
      if (a.kind !== "corridor" || a.cellCount === 0) return;
      const cells: number[] = [];
      d.l.cells.area.forEach((v, i) => {
        if (v === ai + 1 && g.walkable(d, i, { secret: true, ignoreFeatures: true })) cells.push(i);
      });
      const plugs = cells.filter((i) => (d.featAt[i] as number) > 0 || d.extra[i] === 1);
      if (plugs.length === 0) return;
      const before = components(g, d, cells);
      const after = components(
        g,
        d,
        cells.filter((i) => !plugs.includes(i)),
      );
      if (after <= before) return;
      const p = plugs[0] as number;
      const b = blockerAt(d, p);
      if (b?.id !== undefined && blamed.has(b.id)) return;
      issue(
        d,
        "warning",
        "passage_blocked",
        `${cap(b?.what ?? "Something")} blocks corridor "${a.id}" at ${at(xy(d, p))}; nobody can get past.`,
        b?.id !== undefined
          ? `move "${b.id}" out of the corridor or widen the corridor to 2`
          : "clear the corridor",
        b?.id ?? a.id,
        xy(d, p),
      );
    });
  }
}

/** (e) Furniture sense: against walls, seats at tables. */
function checkFurnitureSense(ctx: PlayCtx): void {
  const { g, plan, issue, levelPath, at } = ctx;
  for (const d of g.levels) {
    const lvl = plan.levels[levelPath(d.l.id)];
    for (const f of d.l.features) {
      if (f.generatedBy !== undefined) continue;
      const fi = lvl?.features.findIndex((p) => p.id === f.id) ?? -1;
      const path = `/levels/${levelPath(d.l.id)}/features/${fi}`;
      if (featureInfo(f.type).wallHugger === true) {
        let touches = false;
        for (let y = f.at[1]; y < f.at[1] + f.size[1] && !touches; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0] && !touches; x++) {
            const i = g.idx(d, x, y);
            if (i < 0) continue;
            for (const s of SIDES) {
              const [dx, dy] = DIRS[s];
              const inside =
                x + dx >= f.at[0] &&
                x + dx < f.at[0] + f.size[0] &&
                y + dy >= f.at[1] &&
                y + dy < f.at[1] + f.size[1];
              if (inside) continue;
              const [j, pass] = g.step(d, i, s, { secret: true, ignoreFeatures: true });
              if (j < 0 || d.l.cells.state[j] !== CELL.OPEN || (!pass && !isHeightStep(d, i, j)))
                touches = true;
            }
          }
        if (!touches)
          issue(
            d,
            "warning",
            "feature_not_at_wall",
            `The ${featureInfo(f.type).label.toLowerCase()} "${f.id}" stands in the middle of the floor at ${at(f.at)}, not against a wall.`,
            `move "${f.id}" so one side touches a wall (rot turns its back to the wall)`,
            f.id,
            f.at,
            path,
          );
      }
      if (featureInfo(f.type).seat === true) {
        const near = (dist: number): string | null => {
          for (const t of d.l.features) {
            if (featureInfo(t.type).seatsAt !== true) continue;
            const gapX = Math.max(
              t.at[0] - (f.at[0] + f.size[0] - 1),
              f.at[0] - (t.at[0] + t.size[0] - 1),
              0,
            );
            const gapY = Math.max(
              t.at[1] - (f.at[1] + f.size[1] - 1),
              f.at[1] - (t.at[1] + t.size[1] - 1),
              0,
            );
            if (Math.max(gapX, gapY) <= dist) return t.id;
          }
          return null;
        };
        const far = near(2);
        if (far !== null && near(1) === null)
          issue(
            d,
            "warning",
            "seat_detached",
            `The ${featureInfo(f.type).label.toLowerCase()} "${f.id}" at ${at(f.at)} is near table "${far}" but not next to it.`,
            `move "${f.id}" to a cell touching "${far}"`,
            f.id,
            f.at,
            path,
          );
      }
    }
  }
}

/** (f) Corridors (routes) that never reach their destination. */
function checkRouteEnds(ctx: PlayCtx): void {
  const { g, plan, issue, levelPath } = ctx;
  for (const d of g.levels) {
    const lvl = plan.levels[levelPath(d.l.id)];
    for (const a of lvl?.areas ?? []) {
      if (a.shape.type !== "route") continue;
      const ra = d.l.areas.find((r) => r.id === a.id);
      if (!ra || ra.cellCount === 0) continue;
      for (const [suffix, end] of [
        ["a", a.shape.from],
        ["b", a.shape.to],
      ] as const) {
        if (typeof end !== "string") continue;
        if (d.l.openings.some((o) => o.id === `${a.id}~${suffix}`)) continue;
        issue(
          d,
          "warning",
          "route_dead_end",
          `Corridor "${a.id}" never opens into "${end}": it ends at a wall or another room.`,
          `change the route's bend ("hv"/"vh") or add an opening between ["${a.id}", "${end}"]`,
          a.id,
          ra.anchor,
        );
      }
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function opposite(s: Side): Side {
  return OPPOSITE[s];
}

function isHeightStep(d: LevelData, i: number, j: number): boolean {
  return Math.abs((d.l.cells.height[i] as number) - (d.l.cells.height[j] as number)) > MAX_STEP_QUARTERS;
}

function components(g: WalkGraph, d: LevelData, cells: number[]): number {
  const set = new Set(cells);
  const seen = new Set<number>();
  let n = 0;
  for (const c of cells) {
    if (seen.has(c)) continue;
    n++;
    const stack = [c];
    seen.add(c);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      for (const s of SIDES) {
        const [j, pass] = g.step(d, i, s, { secret: true, ignoreFeatures: true });
        if (pass && set.has(j) && !seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
  }
  return n;
}

/**
 * The one obstacle between what the party reaches and an area: a blocking feature, built cell, stairwell or deep
 * water cell that touches both the reached region and the area's own walkable region.
 */
function findBlocker(
  g: WalkGraph,
  d: LevelData,
  areaCells: number[],
  reached: Uint8Array,
): { what: string; id?: string; cell?: Vec2 } | null {
  const area = new Set(areaCells);
  const touches = (i: number, mask: Uint8Array | Set<number>): boolean => {
    for (const s of SIDES) {
      const [j, pass] = g.step(d, i, s, { secret: true, ignoreFeatures: true });
      if (pass && j >= 0 && (mask instanceof Set ? mask.has(j) : mask[j] === 1)) return true;
    }
    return false;
  };
  // a blocker stands beside the reached part of the level: find those cells first, and flood from the area (a walk of
  // the whole map) only when there are any, so a level nobody reaches costs no flood per area
  const beside: number[] = [];
  for (let i = 0; i < d.w * d.h; i++) {
    if (d.l.cells.state[i] !== CELL.OPEN) continue;
    if (g.walkable(d, i, { secret: true, ignoreWater: true })) continue;
    if (!g.walkable(d, i, { secret: true, ignoreFeatures: true, ignoreWater: true, ignoreStairwells: true }))
      continue;
    if (touches(i, reached)) beside.push(i);
  }
  if (beside.length === 0) return null;
  const inner = g.flood(
    areaCells.map((i) => [d.li, i] as [number, number]),
    { secret: true, ignoreWater: true },
  )[d.li] as Uint8Array;
  const candidates = beside.filter((i) => area.has(i) || touches(i, inner) || touches(i, area));
  const best = candidates[0];
  if (best === undefined) return null;
  const k = d.featAt[best] as number;
  const cell = g.xy(d, best);
  if (k > 0) {
    const f = d.l.features[k - 1];
    return {
      what: f ? `the ${featureInfo(f.type).label.toLowerCase()} "${f.id}"` : "a feature",
      ...(f ? { id: f.id } : {}),
      cell,
    };
  }
  const link = d.linkUpper.get(best) ?? d.linkLower.get(best);
  if (link) return { what: `the stairwell of "${link.id}"`, id: link.id, cell };
  return { what: "built geometry", cell };
}

/** A reached area (or "@outside") sharing an edge with these cells, for the opening hint. */
function neighbourArea(g: WalkGraph, d: LevelData, cells: number[], reached: Uint8Array): AreaId | null {
  const set = new Set(cells);
  const out = new Set<string>();
  for (const i of cells)
    for (const s of SIDES) {
      const [j] = g.step(d, i, s, { secret: true });
      if (j < 0 || set.has(j) || reached[j] !== 1) continue;
      const a = d.l.cells.area[j] as number;
      out.add(a > 0 ? (d.l.areaIds[a - 1] as string) : "@outside");
    }
  return [...out].sort()[0] ?? null;
}
