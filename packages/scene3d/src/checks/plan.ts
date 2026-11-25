/**
 * What the build planned, in world terms, for the checks to hold the meshes to: each level's cells (floored or open,
 * their walkable top, whether a roofed building covers them), its passages (doors, arches, gaps), the closed sides of
 * its enclosures (a building's walls storey by storey, an object's rails and hull round its decks) and each object's
 * heading. Read from the resolved plan through core's own readers (LevelGrid, the opening-kind table, the world frame
 * of the orientation calibration and its inverse, the side steps, areaObject, resolvedLinkCells), never re-derived.
 */
import {
  CELL_FLAG,
  DIRS,
  EDGE,
  LevelGrid,
  SIDE_STEP,
  WorldFrame,
  elementCharacter,
  featureInfo,
  isPassage,
  loadOrientation,
  resolvedLinkCells,
  type OrientationCalibration,
  type ResolvedLevel,
  type ResolvedPlan,
  type Side,
} from "@slabyrinth/core";
import { areaObject, isObjectBody } from "@slabyrinth/core/objects";
import type { Scene, Vec3 } from "../types/index";
import { CHECK_THRESHOLDS as T } from "./thresholds";

/** One plan cell in the world: the square [x0, x0+1] × [z0, z0+1]. */
export interface PlanCell {
  levelIndex: number;
  /** Plan cell. */
  cell: readonly [number, number];
  x0: number;
  z0: number;
  /** Absolute walkable floor top. */
  top: number;
  /** Open with a floor tile planned. */
  floor: boolean;
  /** Open (walkable or a hole). */
  open: boolean;
  /** A stair or a stairwell is planned here (its own pieces make the surface). */
  link: boolean;
  /** The id of the roofed building whose ground storey footprint the cell is in (null when none). */
  roofedBy: string | null;
  /** Ground floor top of that building (absolute). */
  roofedFloor: number;
}

/** A planned way through a wall (a door, an arch, a gap): the edge run it crosses, in the world. */
export interface PlanPassage {
  id: string;
  kind: string;
  levelIndex: number;
  /** World start and end of the edge run (y: the walkable floor top beside it). */
  a: Vec3;
  b: Vec3;
  /** Unit normal across the wall. */
  normal: Vec3;
  width: number;
}

/**
 * A closed side of an enclosure the build planned: a run of edges between its inside and the outside with no opening,
 * to be probed at `heights` (absolute) by rays from `rayInside` inside to `rayOutside` outside along `outward`.
 */
export interface PlanBoundary {
  /** The enclosure (a building's or an object's id). */
  owner: string;
  levelIndex: number;
  /** "wall": a building storey's wall; "rail": an object's rail, bulwark or hull round a deck. */
  kind: "wall" | "rail";
  /** World start and end of the run (y unused). */
  a: Vec3;
  b: Vec3;
  outward: Vec3;
  heights: number[];
  /** The plan cells inside the run, in order. */
  cells: Array<readonly [number, number]>;
}

export interface PlanObject {
  id: string;
  /** World direction its front (a vessel's bow) faces. */
  heading: Vec3;
}

export interface PlanFacts {
  /**
   * Every planned cell in bounds, level by level. A build's facts make each cell as it is walked (a map of 1024 x 1024
   * tiles and 8 levels keeps typed arrays per level, not 8 million objects): keep a cell only while it is needed.
   */
  cells: Iterable<PlanCell>;
  passages: PlanPassage[];
  boundaries: PlanBoundary[];
  objects: PlanObject[];
  /** Elements planned on a wall (a feature with a wall side): they hang, they do not stand. */
  mounted: ReadonlySet<string>;
  /**
   * Elements that are organic dressing (the feature table's traits organic and growth: plants, rocks, cliff faces,
   * vines): they grow into the ground, the walls and each other by design.
   */
  organic: ReadonlySet<string>;
  /** The plan's features: for these the plan's own word (`organic`) decides, not the pieces' class. */
  features: ReadonlySet<string>;
  /** Arrangements whose pieces the plan sets into the ground (layered ground's low rocks and tufts). */
  sunkByPlan: ReadonlySet<string>;
  /** Overhead lines (a rope, a chain of banners between two walls): their pieces carry each other end to end. */
  spans: ReadonlySet<string>;
  /**
   * The arrangement instances that are an object's own body (core `isObjectBody`: the mark placeObject puts on them),
   * however the object was split (`ship`, `ship#2`, `ship@deck#1`): its hull, decks, rails and masts.
   */
  bodies: ReadonlySet<string>;
  /** Each scene level's elevation (the bottom of its floor tiles), by level index. */
  levelBase: number[];
  /** The planned cell under a world point on a level (null outside the level). */
  cellAt(levelIndex: number, x: number, z: number): PlanCell | null;
}

/** What the planner knows of an object (core ObjectSite): its id, heading and the cells of its gangway. */
export interface ObjectPlan {
  id: string;
  /** Degrees clockwise from plan north. */
  heading: number;
  gangway?: ReadonlyArray<readonly [number, number]>;
}

interface Edge {
  cell: readonly [number, number];
  side: Side;
}

/** The plan facts of a resolved plan whose scene is `scene` (levels matched by id). */
export function planFacts(
  resolved: ResolvedPlan,
  scene: Scene,
  opts: { orientation?: OrientationCalibration; objects?: readonly ObjectPlan[] } = {},
): PlanFacts {
  const orientation = opts.orientation ?? loadOrientation().orientation;
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const frame = new WorldFrame(orientation, hg);
  const levelIndex = new Map(scene.levels.map((l) => [l.id, l.index]));
  const objectIds = new Set((opts.objects ?? []).map((o) => o.id));
  const gangway = new Set(
    (opts.objects ?? []).flatMap((o) => (o.gangway ?? []).map(([x, y]) => `${String(x)},${String(y)}`)),
  );
  const passages: PlanPassage[] = [];
  const boundaries: PlanBoundary[] = [];
  const mounted = new Set<string>();
  const organic = new Set<string>();
  const features = new Set<string>();
  const sunkByPlan = new Set<string>();
  const spans = new Set<string>();
  const bodies = new Set<string>();
  const levelBase: number[] = scene.levels.map(() => scene.bounds.min.y);
  /** Each level's cells as typed arrays over its bounds (row by row): what a PlanCell is made from on demand. */
  const byLevel = new Map<number, LevelCells>();
  const roofIds: string[] = [];
  const roofIndex = new Map<string, number>();

  /** World (x, z) of a plan vertex. */
  const vertex = (x: number, y: number): { x: number; z: number } => frame.point(x, y);
  /** The world segment and outward normal of a cell's side. */
  const sideSegment = (x: number, y: number, side: Side): { a: Vec3; b: Vec3; out: Vec3 } => {
    const [p, q] =
      side === "N"
        ? [vertex(x, y), vertex(x + 1, y)]
        : side === "S"
          ? [vertex(x, y + 1), vertex(x + 1, y + 1)]
          : side === "W"
            ? [vertex(x, y), vertex(x, y + 1)]
            : [vertex(x + 1, y), vertex(x + 1, y + 1)];
    const c = vertex(x + 0.5, y + 0.5);
    const mx = (p.x + q.x) / 2 - c.x;
    const mz = (p.z + q.z) / 2 - c.z;
    const n = Math.hypot(mx, mz) || 1;
    return { a: { x: p.x, y: 0, z: p.z }, b: { x: q.x, y: 0, z: q.z }, out: { x: mx / n, y: 0, z: mz / n } };
  };
  /** Joins edges on one line, facing one way, into runs (consecutive cells). */
  const runsOf = (edges: readonly Edge[]): Edge[][] => {
    const groups = new Map<string, Edge[]>();
    for (const e of edges) {
      const ns = e.side === "N" || e.side === "S";
      const k = `${e.side}:${String(ns ? e.cell[1] : e.cell[0])}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(e);
    }
    const out: Edge[][] = [];
    for (const g of [...groups.keys()].sort()) {
      const list = (groups.get(g) ?? []).slice();
      const ns = list[0]?.side === "N" || list[0]?.side === "S";
      list.sort((p, q) => (ns ? p.cell[0] - q.cell[0] : p.cell[1] - q.cell[1]));
      let run: Edge[] = [];
      for (const e of list) {
        const last = run[run.length - 1];
        const along = (x: Edge): number => (ns ? x.cell[0] : x.cell[1]);
        if (last && along(e) !== along(last) + 1) {
          out.push(run);
          run = [];
        }
        run.push(e);
      }
      if (run.length > 0) out.push(run);
    }
    return out;
  };
  const addRuns = (
    owner: string,
    li: number,
    kind: PlanBoundary["kind"],
    edges: readonly Edge[],
    heights: (e: Edge) => number[],
  ): void => {
    for (const run of runsOf(edges)) {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) continue;
      const s0 = sideSegment(first.cell[0], first.cell[1], first.side);
      const s1 = sideSegment(last.cell[0], last.cell[1], last.side);
      // the run goes from the first edge's far-from-last end to the last edge's far end
      const ends = [s0.a, s0.b, s1.a, s1.b];
      let a = s0.a;
      let b = s1.b;
      let best = -1;
      for (const p of ends)
        for (const q of ends) {
          const d = Math.hypot(p.x - q.x, p.z - q.z);
          if (d > best) {
            best = d;
            a = p;
            b = q;
          }
        }
      if (a.x > b.x || (a.x === b.x && a.z > b.z)) [a, b] = [b, a];
      boundaries.push({
        owner,
        levelIndex: li,
        kind,
        a,
        b,
        outward: s0.out,
        heights: heights(first),
        cells: run.map((e) => e.cell),
      });
    }
  };

  for (const level of resolved.levels) {
    const li = levelIndex.get(level.id);
    if (li === undefined) continue;
    levelBase[li] = level.elevation;
    const grid = new LevelGrid(level);
    const roofed = new Map<string, { id: string; floor: number }>();
    for (const s of level.structures ?? []) {
      if (s.kind !== "building" || s.roof.type === "none" || s.roof.broken > 0) continue;
      const floor = s.storeys[0]?.floorTop ?? grid.top(s.cells[0]?.[0] ?? 0, s.cells[0]?.[1] ?? 0);
      for (const [x, y] of s.cells) roofed.set(`${String(x)},${String(y)}`, { id: s.id, floor });
    }
    const linkCells = linkCellsOf(resolved, level);
    const b = level.bounds;
    const n = b.w * b.h;
    const lc: LevelCells = {
      li,
      x0: b.x,
      y0: b.y,
      w: b.w,
      h: b.h,
      bits: new Uint8Array(n),
      top: new Float64Array(n),
      roof: new Int32Array(n).fill(-1),
      roofFloor: new Float64Array(n),
    };
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const c = grid.cell(x, y);
        if (!c.inBounds) continue;
        const k = (y - b.y) * b.w + (x - b.x);
        const link =
          linkCells.has(`${String(x)},${String(y)}`) ||
          (c.flags & (CELL_FLAG.LINK | CELL_FLAG.STAIRWELL | CELL_FLAG.STEPS)) !== 0;
        lc.bits[k] =
          BIT.inBounds | (c.floor ? BIT.floor : 0) | (c.open ? BIT.open : 0) | (link ? BIT.link : 0);
        lc.top[k] = grid.top(x, y);
        const r = roofed.get(`${String(x)},${String(y)}`);
        if (r) {
          let id = roofIndex.get(r.id);
          if (id === undefined) roofIndex.set(r.id, (id = roofIds.push(r.id) - 1));
          lc.roof[k] = id;
          lc.roofFloor[k] = r.floor;
        }
      }
    byLevel.set(li, lc);

    for (const o of level.openings) {
      if (!isPassage(o.kind)) continue;
      const p = vertex(o.start[0], o.start[1]);
      const e =
        o.orientation === "h"
          ? vertex(o.start[0] + o.width, o.start[1])
          : vertex(o.start[0], o.start[1] + o.width);
      const [c1, c2] =
        o.orientation === "h"
          ? [grid.top(o.start[0], o.start[1] - 1), grid.top(o.start[0], o.start[1])]
          : [grid.top(o.start[0] - 1, o.start[1]), grid.top(o.start[0], o.start[1])];
      const y = Math.max(c1, c2);
      passages.push({
        id: o.id,
        kind: o.kind,
        levelIndex: li,
        a: { x: p.x, y, z: p.z },
        b: { x: e.x, y, z: e.z },
        normal: o.orientation === "h" ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 },
        width: o.width,
      });
    }
    for (const f of level.features) {
      features.add(f.id);
      if (f.wall !== undefined) mounted.add(f.id);
      const info = featureInfo(f.type);
      if (info.organic || info.growth === true) organic.add(f.id);
    }
    for (const l of level.lines ?? []) spans.add(l.id);
    for (const a of level.arrangements ?? []) {
      if (isObjectBody(a)) bodies.add(a.id);
      if (a.mount === "wall") mounted.add(a.id);
      if (a.pieces.some((p) => p.y < -T.plannedSink)) sunkByPlan.add(a.id);
    }

    // a building's walls, storey by storey: its footprint's WALL edges (openings are their own edges), less the
    // upper storeys' own openings
    for (const s of level.structures ?? []) {
      // a ruin's walls are broken by design (its condition, from the level's own record)
      if (s.kind !== "building" || elementCharacter(level, s.id)?.condition === "ruined") continue;
      const foot = new Set(s.cells.map(([x, y]) => `${String(x)},${String(y)}`));
      const walls: Edge[] = [];
      for (const [x, y] of s.cells)
        for (const side of DIRS) {
          const [dx, dy] = SIDE_STEP[side];
          if (foot.has(`${String(x + dx)},${String(y + dy)}`)) continue;
          if (grid.edgeKind(x, y, side) === EDGE.WALL) walls.push({ cell: [x, y], side });
        }
      // upper storeys only when one volume holds them all (a building of several volumes steps its outline)
      const storeys = (s.volumes?.length ?? 1) > 1 ? s.storeys.slice(0, 1) : s.storeys;
      storeys.forEach((st, n) => {
        const holes = new Set(
          s.upperOpenings
            .filter((u) => u.storey === n)
            .flatMap((u) =>
              Array.from({ length: Math.max(1, u.width) }, (_, i) => {
                const along = u.side === "N" || u.side === "S" ? [i, 0] : [0, i];
                return `${String(u.at[0] + (along[0] ?? 0))},${String(u.at[1] + (along[1] ?? 0))}:${u.side}`;
              }),
            ),
        );
        const edges = walls.filter((e) => !holes.has(`${String(e.cell[0])},${String(e.cell[1])}:${e.side}`));
        const top = st.floorTop;
        const hs = T.wallHeights.filter((h) => h < st.wallHeight - T.wallTopMargin).map((h) => top + h);
        if (hs.length > 0) addRuns(s.id, li, "wall", edges, () => hs);
      });
    }

    // an object's decks: the sides of its own cells that face cells it does not own, less its gangway and stairs
    if (objectIds.size > 0) {
      const ownerAt = (x: number, y: number): string | null => {
        const c = grid.cell(x, y);
        const o = areaObject(c.area > 0 ? level.areas[c.area - 1]?.id : undefined);
        return o !== null && objectIds.has(o) ? o : null;
      };
      const byOwner = new Map<string, Edge[]>();
      for (let y = b.y; y < b.y + b.h; y++)
        for (let x = b.x; x < b.x + b.w; x++) {
          const o = ownerAt(x, y);
          if (o === null || !grid.cell(x, y).floor) continue;
          if (gangway.has(`${String(x)},${String(y)}`) || linkCells.has(`${String(x)},${String(y)}`))
            continue;
          for (const side of DIRS) {
            const [dx, dy] = SIDE_STEP[side];
            if (ownerAt(x + dx, y + dy) === o) continue;
            const k = `${String(x + dx)},${String(y + dy)}`;
            if (gangway.has(k) || linkCells.has(k)) continue;
            let l = byOwner.get(o);
            if (!l) byOwner.set(o, (l = []));
            l.push({ cell: [x, y], side });
          }
        }
      for (const [o, edges] of [...byOwner].sort((p, q) => (p[0] < q[0] ? -1 : 1)))
        addRuns(o, li, "rail", edges, (e) => T.railHeights.map((h) => grid.top(e.cell[0], e.cell[1]) + h));
    }
  }

  const objects: PlanObject[] = (opts.objects ?? []).map((o) => {
    // clockwise from plan north (plan north is -y), turned into the world by the frame
    const t = (o.heading * Math.PI) / 180;
    const w = frame.planVector(Math.sin(t), -Math.cos(t));
    return { id: o.id, heading: { x: w.x, y: 0, z: w.z } };
  });
  /** The planned cell at index `k` of a level's arrays (null out of bounds). */
  const cellOf = (l: LevelCells, k: number): PlanCell | null => {
    const bits = l.bits[k] ?? 0;
    if ((bits & BIT.inBounds) === 0) return null;
    const x = l.x0 + (k % l.w);
    const y = l.y0 + Math.floor(k / l.w);
    const m = frame.rectMin(x, y, 1, 1);
    const roof = l.roof[k] ?? -1;
    return {
      levelIndex: l.li,
      cell: [x, y],
      x0: m.x,
      z0: m.z,
      top: l.top[k] ?? 0,
      floor: (bits & BIT.floor) !== 0,
      open: (bits & BIT.open) !== 0,
      link: (bits & BIT.link) !== 0,
      roofedBy: roof >= 0 ? (roofIds[roof] ?? null) : null,
      roofedFloor: roof >= 0 ? (l.roofFloor[k] ?? 0) : 0,
    };
  };
  const levels = [...byLevel.values()];
  const cells: Iterable<PlanCell> = {
    *[Symbol.iterator]() {
      for (const l of levels)
        for (let k = 0; k < l.w * l.h; k++) {
          const c = cellOf(l, k);
          if (c) yield c;
        }
    },
  };
  return {
    cells,
    passages,
    boundaries,
    objects,
    mounted,
    organic,
    features,
    sunkByPlan,
    spans,
    bodies,
    levelBase,
    cellAt(li, x, z) {
      const l = byLevel.get(li);
      if (!l) return null;
      const [px, py] = frame.cellAt(x, z);
      const ix = px - l.x0;
      const iy = py - l.y0;
      if (ix < 0 || iy < 0 || ix >= l.w || iy >= l.h) return null;
      return cellOf(l, iy * l.w + ix);
    },
  };
}

/** A cell's yes/no facts, one bit each. */
const BIT = { inBounds: 1, floor: 2, open: 4, link: 8 } as const;

/** One level's planned cells over its bounds, row by row, in typed arrays. */
interface LevelCells {
  li: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  top: Float64Array;
  /** Index of the roofed building over the cell (-1: none). */
  roof: Int32Array;
  roofFloor: Float64Array;
}

/** The cells of a level a stair, ladder or stairwell stands in (core `resolvedLinkCells`). */
function linkCellsOf(resolved: ResolvedPlan, level: ResolvedLevel): Set<string> {
  const out = new Set<string>();
  for (const l of resolved.links)
    for (const [x, y] of resolvedLinkCells(l, level.id)) out.add(`${String(x)},${String(y)}`);
  return out;
}
