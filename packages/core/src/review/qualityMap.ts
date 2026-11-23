/**
 * The quality meter over a whole build (review/qualityMetrics.ts defines every metric once): the slab tier over the
 * realized pieces (review/qualitySlab.ts) and the map tier, which reads the resolved map beside them: loose props by
 * the walls, the walking lane between a room's doors, focal against calm detail, lights per floor tile, lit outside
 * doors, band courses at floor lines; with the per-room figures behind them.
 *
 * Engineer-facing: the CLI's `quality` command and the generator-5 golden baseline print it; the review's notes
 * (review/qualityNotes.ts) give the model only what it can act on with plan words. Pure: the orientation the pieces
 * were realized with is a parameter (the bundled one by default, as realize uses).
 */
import type { OrientationCalibration, PaletteCatalog, PlacementSet } from "../contracts/compiler";
import type { MapPlan, Side, Vec2 } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  EDGE,
  type ResolvedArea,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedOpening,
  type ResolvedPlan,
  type ResolvedStructure,
} from "../contracts/resolved";
import { WorldFrame, placedBox, realize, verifyBuild, type RealizedSet } from "../compile/index";
import { LIGHT_FEATURES, featureInfo } from "../gen/catalog";
import { SIDES, SIDE_STEP } from "../gen/gridGeometry";
import { isPassage } from "../gen/openingKinds";
import { loadOrientation } from "../palette/load";
import { LevelGrid } from "../resolve/levelGrid";
import { maxOf } from "../util/lists";
import { QUALITY_METRICS, type QualityMetricId, targetText, withinTarget } from "./qualityMetrics";
import type { ResolvePalettes } from "../palette/resolve";
import { lightGiver, roomMeantDim } from "./lights";
import { roomMeter } from "./qualityRooms";
import { slabMeter, type MeterPiece } from "./qualitySlab";

/** One room's figures (areas of kind room with walkable floor). */
export interface RoomQuality {
  levelId: string;
  id: string;
  name: string;
  floor: number;
  loose: number;
  /** Loose props within a tile of a wall or boundary / loose props (null: none). */
  nearWall: number | null;
  lane: number;
  /** Lane cells under a blocking feature / lane cells (null: fewer than two walkable openings). */
  laneBlocked: number | null;
  /** Light features per walkable cell. */
  lights: number;
}

export interface QualityReport {
  /** Every metric's value (null: nothing to measure on this build). */
  values: Record<QualityMetricId, number | null>;
  rooms: RoomQuality[];
}

/** The fixed numbers of the map tier's definitions. */
export const MAP_METER = {
  /** Area kinds whose features are judged as an interior's loose props and lights. */
  interiorKinds: ["room", "corridor"] as readonly string[],
  /** Focal contrast: block size (cells), walkable cells a block needs, the floor under the median, blocks needed. */
  block: 3,
  blockMinCells: 3,
  minBlockDensity: 1 / 9,
  minBlocks: 4,
  /** Band course: tallest piece that counts, reach round the floor line, proud and depth from the face. */
  bandHeight: 0.6,
  bandReach: 0.25,
  bandProud: 0.02,
  bandDepth: 0.6,
} as const;

const B = MAP_METER;

/** The pieces of a build as the slab tier reads them (markers left out): role feature is loose dressing. */
export function meterPieces(set: PlacementSet, levelId?: string): MeterPiece[] {
  const out: MeterPiece[] = [];
  for (const L of set.levels) {
    if (levelId !== undefined && L.levelId !== levelId) continue;
    for (const p of L.placements) {
      if (p.role === "marker") continue;
      const size = set.placed?.get(p)?.geom.size;
      out.push({
        ...(size !== undefined ? { size: { x: size.x, z: size.z } } : {}),
        asset: p.asset,
        y: p.y,
        rot: p.rot,
        box: placedBox(set, p),
        tile: set.placed?.get(p)?.geom.originAt === "minCorner",
        loose: p.role === "feature",
      });
    }
  }
  return out;
}

/** A feature that stands loose on the floor (what the wall-band rule is about). */
export function isLooseFeature(f: ResolvedFeature): boolean {
  const i = featureInfo(f.type);
  return (
    f.gmOnly !== true &&
    !i.wallMounted &&
    i.ceilingMounted !== true &&
    i.natural !== true &&
    i.bandRock !== true &&
    i.road !== true &&
    i.smallThing !== true &&
    i.landmark !== true
  );
}

const cellsOf = (f: ResolvedFeature): Vec2[] => {
  const out: Vec2[] = [];
  for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
    for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) out.push([x, y]);
  return out;
};

const walkable = (L: ResolvedLevel, i: number): boolean =>
  L.cells.state[i] === CELL.OPEN &&
  ((L.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) === 0;

/** Is cell (x, y) within a tile of a wall or of a cell that is not open (the level's edge included)? */
export function nearBoundary(grid: LevelGrid, x: number, y: number): boolean {
  for (const s of SIDES) {
    const [dx, dy] = SIDE_STEP[s];
    for (let k = 0; k <= 1; k++) {
      const cx = x + dx * k;
      const cy = y + dy * k;
      if (grid.wallOn(cx, cy, s) || !grid.cell(cx + dx, cy + dy).open) return true;
    }
  }
  return false;
}

/** The walkable cell on `area`'s side of the middle of an opening, or undefined when it is not that area's. */
export function openingCell(o: ResolvedOpening, area: string): Vec2 | undefined {
  const mid = Math.floor(o.width / 2);
  const [sx, sy] = o.start;
  if (o.orientation === "h") {
    if (o.sides[0] === area) return [sx + mid, sy - 1];
    if (o.sides[1] === area) return [sx + mid, sy];
  } else {
    if (o.sides[0] === area) return [sx - 1, sy + mid];
    if (o.sides[1] === area) return [sx, sy + mid];
  }
  return undefined;
}

/** The cells on both sides of every edge of an opening. */
function openingCells(o: ResolvedOpening): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < o.width; i++)
    if (o.orientation === "h") out.push([o.start[0] + i, o.start[1] - 1], [o.start[0] + i, o.start[1]]);
    else out.push([o.start[0] - 1, o.start[1] + i], [o.start[0], o.start[1] + i]);
  return out;
}

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * A room's walking lane: for each pair of its walkable openings, one shortest 4-connected path between their inner
 * cells over the room's walkable cells (never through a wall edge), chosen step by step nearest the straight line
 * between the doors. `avoid` cells are impassable (to ask whether a free path exists). Returns the lane cells and the
 * pairs with no path.
 */
export function roomLane(
  grid: LevelGrid,
  cells: ReadonlySet<string>,
  doors: readonly Vec2[],
  avoid: ReadonlySet<string> = new Set(),
): { lane: Set<string>; cut: number } {
  const lane = new Set<string>();
  let cut = 0;
  const steps = (x: number, y: number): Vec2[] =>
    SIDES.filter((s) => grid.edgeKind(x, y, s) !== EDGE.WALL)
      .map((s): Vec2 => [x + SIDE_STEP[s][0], y + SIDE_STEP[s][1]])
      .filter(([nx, ny]) => cells.has(key(nx, ny)) && !avoid.has(key(nx, ny)));
  for (let i = 0; i < doors.length; i++)
    for (let j = i + 1; j < doors.length; j++) {
      const a = doors[i] as Vec2;
      const b = doors[j] as Vec2;
      if (avoid.has(key(a[0], a[1])) || avoid.has(key(b[0], b[1]))) {
        cut++;
        continue;
      }
      // distances from b
      const dist = new Map<string, number>([[key(b[0], b[1]), 0]]);
      const queue: Vec2[] = [b];
      for (let q = 0; q < queue.length; q++) {
        const [x, y] = queue[q] as Vec2;
        const d = dist.get(key(x, y)) as number;
        for (const n of steps(x, y))
          if (!dist.has(key(n[0], n[1]))) {
            dist.set(key(n[0], n[1]), d + 1);
            queue.push(n);
          }
      }
      if (!dist.has(key(a[0], a[1]))) {
        cut++;
        continue;
      }
      // walk from a, each step to a neighbour one closer, the one nearest the segment a-b
      const off = (p: Vec2): number => {
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const l2 = vx * vx + vy * vy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
        return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
      };
      let at: Vec2 = a;
      lane.add(key(a[0], a[1]));
      for (let d = dist.get(key(a[0], a[1])) as number; d > 0; d--) {
        const next = steps(at[0], at[1])
          .filter((n) => dist.get(key(n[0], n[1])) === d - 1)
          .sort((p, q) => off(p) - off(q))[0] as Vec2;
        at = next;
        lane.add(key(at[0], at[1]));
      }
    }
  return { lane, cut };
}

/** The walkable cells of each area of a level, by area index (cells.area is index + 1). */
function areaCells(L: ResolvedLevel): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const W = L.bounds.w;
  for (let i = 0; i < L.cells.area.length; i++) {
    const a = L.cells.area[i] as number;
    if (a === 0 || !walkable(L, i)) continue;
    const s = out.get(a - 1) ?? new Set<string>();
    s.add(key(L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)));
    out.set(a - 1, s);
  }
  return out;
}

const isInterior = (a: ResolvedArea | undefined): boolean =>
  a !== undefined && B.interiorKinds.includes(a.kind);

/** Is any of a building's ground openings lit: a door light or a light feature within one cell of a door cell? */
function doorLit(o: ResolvedOpening, s: ResolvedStructure, lights: readonly Vec2[]): boolean {
  const near = (p: Vec2, q: Vec2): boolean => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) <= 1;
  const cells = openingCells(o);
  return cells.some((c) => s.lights.some((l) => near(l.at, c)) || lights.some((l) => near(l, c)));
}

/** The walkable ground openings of a building and whether each is lit (intact buildings only: ruins are dark). */
export function buildingDoors(
  L: ResolvedLevel,
  s: ResolvedStructure,
  gives: (f: ResolvedFeature) => boolean = (f) => LIGHT_FEATURES.has(f.type),
): Array<{ opening: ResolvedOpening; lit: boolean }> {
  if (s.kind !== "building" || (s.condition !== undefined && s.condition !== "intact")) return [];
  const lights = L.features.filter(gives).flatMap(cellsOf);
  const ids = new Set(s.openingIds);
  return L.openings
    .filter((o) => ids.has(o.id) && isPassage(o.kind))
    .map((o) => ({ opening: o, lit: doorLit(o, s, lights) }));
}

interface Tally {
  n: number;
  of: number;
}
const ratio = (t: Tally): number | null => (t.of > 0 ? t.n / t.of : null);

/** Band course coverage over a level's buildings of two storeys or more (edges with a band / edges). */
function bandTally(L: ResolvedLevel, set: PlacementSet, frame: WorldFrame, t: Tally): void {
  const placements = set.levels.find((l) => l.levelId === L.id)?.placements ?? [];
  for (const s of L.structures ?? []) {
    if (s.kind !== "building") continue;
    const lines: Array<{ cells: readonly Vec2[]; floorTop: number }> = [];
    if (s.volumes && s.volumes.length > 0)
      for (const v of s.volumes)
        v.storeys.forEach((q, k) => {
          if (k > 0) lines.push({ cells: q.cells, floorTop: q.floorTop });
        });
    else
      s.storeys.forEach((q, k) => {
        if (k > 0) lines.push({ cells: s.cells, floorTop: q.floorTop });
      });
    if (lines.length === 0) continue;
    // its own pieces, and the detail recipes' instances dressing it
    const hosted = new Set((L.arrangements ?? []).filter((a) => a.host === s.id).map((a) => a.id));
    const boxes = placements
      .filter(
        (p) =>
          p.source.elementId === s.id ||
          (p.source.elementId ?? "").startsWith(`${s.id}~`) ||
          hosted.has(p.source.elementId ?? ""),
      )
      .map((p) => placedBox(set, p))
      .filter((b) => b.max.y - b.min.y <= B.bandHeight);
    for (const line of lines) {
      const fp = new Set(line.cells.map(([x, y]) => key(x, y)));
      for (const [x, y] of line.cells)
        for (const side of SIDES) {
          const [dx, dy] = SIDE_STEP[side];
          if (fp.has(key(x + dx, y + dy))) continue;
          t.of++;
          if (edgeBanded(frame, x, y, side, line.floorTop, boxes)) t.n++;
        }
    }
  }
}

/** Does a flat box span the floor line at the middle of the face on `side` of cell (x, y), proud of the face? */
function edgeBanded(
  frame: WorldFrame,
  x: number,
  y: number,
  side: Side,
  floorTop: number,
  boxes: ReadonlyArray<{
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  }>,
): boolean {
  const [dx, dy] = SIDE_STEP[side];
  // the middle of the face in plan, and one step out, in world
  const mx = x + 0.5 + dx * 0.5;
  const my = y + 0.5 + dy * 0.5;
  const mid = frame.point(mx, my);
  const out = frame.point(mx + dx, my + dy);
  const normal: "x" | "z" = dx !== 0 ? "x" : "z";
  const along: "x" | "z" = normal === "x" ? "z" : "x";
  const sign = Math.sign(out[normal] - mid[normal]);
  return boxes.some((b) => {
    if (b.max.y < floorTop - B.bandReach || b.min.y > floorTop + B.bandReach) return false;
    if (b.min[along] > mid[along] || b.max[along] < mid[along]) return false;
    // proud of the face outwards, and at the face (not a thing out in the street)
    const outer = sign > 0 ? b.max[normal] - mid[normal] : mid[normal] - b.min[normal];
    const inner = sign > 0 ? b.min[normal] - mid[normal] : mid[normal] - b.max[normal];
    return outer >= B.bandProud && inner <= B.bandDepth && outer <= B.bandDepth + 1;
  });
}

const percentile = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
};

export interface QualityOptions {
  /** The orientation the build was realized with (default: the bundled one, as realize uses). */
  orientation?: OrientationCalibration;
  /** The plan's entry level (MapPlan.entryLevel), for the layout rows' walk back to it. */
  entryLevel?: string;
  /** The palettes it was built with: generator 5 counts only lights whose pieces give light (review/lights.ts). */
  palettes?: ResolvePalettes;
}

/** The whole quality meter of a realized build of a resolved plan. */
export function qualityMeter(
  resolved: ResolvedPlan,
  set: PlacementSet,
  opts: QualityOptions = {},
): QualityReport {
  const slab = slabMeter(meterPieces(set));
  const gives = lightGiver(resolved, opts.palettes);
  const orientation = opts.orientation ?? loadOrientation().orientation;
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const frame = new WorldFrame(orientation, hg);
  const near: Tally = { n: 0, of: 0 };
  const laneT: Tally = { n: 0, of: 0 };
  const lightT: Tally = { n: 0, of: 0 };
  const doorT: Tally = { n: 0, of: 0 };
  const bandT: Tally = { n: 0, of: 0 };
  const densities: number[] = [];
  let loosePieces = 0;
  const rooms: RoomQuality[] = [];

  for (const L of resolved.levels) {
    const grid = new LevelGrid(L);
    const byArea = areaCells(L);
    const W = L.bounds.w;
    const areaOf = (id: string | undefined): ResolvedArea | undefined => L.areas.find((a) => a.id === id);

    // loose props by the walls, and lights, in interiors (generator 5: lights that give light, in rooms not meant dim)
    for (const f of L.features) {
      const a = areaOf(f.area);
      if (!isInterior(a)) continue;
      if (gives(f) && !roomMeantDim(a)) lightT.n++;
      if (!isLooseFeature(f)) continue;
      near.of++;
      if (cellsOf(f).some(([x, y]) => nearBoundary(grid, x, y))) near.n++;
    }
    L.areas.forEach((a, ai) => {
      if (isInterior(a) && !roomMeantDim(a)) lightT.of += byArea.get(ai)?.size ?? 0;
    });

    // rooms: lanes between their openings, and the per-room figures
    const blocked = new Set(
      L.features
        .filter((f) => f.blocking && !featureInfo(f.type).wallMounted)
        .flatMap((f) => cellsOf(f).map(([x, y]) => key(x, y))),
    );
    L.areas.forEach((a, ai) => {
      if (a.kind !== "room") return;
      const cells = byArea.get(ai);
      if (!cells || cells.size === 0) return;
      const doors = L.openings
        .filter((o) => isPassage(o.kind))
        .map((o) => openingCell(o, a.id))
        .filter((c): c is Vec2 => c !== undefined && cells.has(key(c[0], c[1])));
      const lane = doors.length >= 2 ? roomLane(grid, cells, doors).lane : new Set<string>();
      const hit = [...lane].filter((c) => blocked.has(c)).length;
      laneT.n += hit;
      laneT.of += lane.size;
      const mine = L.features.filter((f) => f.area === a.id);
      const loose = mine.filter(isLooseFeature);
      const by = loose.filter((f) => cellsOf(f).some(([x, y]) => nearBoundary(grid, x, y))).length;
      rooms.push({
        levelId: L.id,
        id: a.id,
        name: a.name ?? a.id,
        floor: cells.size,
        loose: loose.length,
        nearWall: loose.length > 0 ? by / loose.length : null,
        lane: lane.size,
        laneBlocked: lane.size > 0 ? hit / lane.size : null,
        lights: mine.filter(gives).length / cells.size,
      });
    });

    // outside doors lit
    for (const s of L.structures ?? [])
      for (const d of buildingDoors(L, s, gives)) {
        doorT.of++;
        if (d.lit) doorT.n++;
      }

    bandTally(L, set, frame, bandT);

    // focal against calm: loose pieces per walkable cell in 3 × 3 blocks
    const bw = Math.ceil(L.bounds.w / B.block);
    const bh = Math.ceil(L.bounds.h / B.block);
    const floorN = new Array<number>(bw * bh).fill(0);
    const pieceN = new Array<number>(bw * bh).fill(0);
    const blockOf = (lx: number, ly: number): number =>
      Math.floor(ly / B.block) * bw + Math.floor(lx / B.block);
    for (let i = 0; i < L.cells.state.length; i++)
      if (walkable(L, i)) {
        const k = blockOf(i % W, Math.floor(i / W));
        floorN[k] = (floorN[k] as number) + 1;
      }
    for (const p of set.levels.find((l) => l.levelId === L.id)?.placements ?? []) {
      if (p.role !== "feature") continue;
      const b = placedBox(set, p);
      // world to plan: WorldFrame.point is its own inverse about hg
      const at = frame.point((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2);
      const lx = Math.floor(at.x) - L.bounds.x;
      const ly = Math.floor(at.z) - L.bounds.y;
      if (lx < 0 || ly < 0 || lx >= L.bounds.w || ly >= L.bounds.h) continue;
      const k = blockOf(lx, ly);
      pieceN[k] = (pieceN[k] as number) + 1;
      loosePieces++;
    }
    floorN.forEach((f, k) => {
      if (f >= B.blockMinCells) densities.push((pieceN[k] as number) / f);
    });
  }

  const focal =
    loosePieces > 0 && densities.length >= B.minBlocks
      ? maxOf(densities) / Math.max(percentile(densities, 0.5), B.minBlockDensity)
      : null;
  return {
    values: {
      ...slab,
      props_near_wall: ratio(near),
      lane_blocked: ratio(laneT),
      focal_contrast: focal,
      lights_per_floor_tile: ratio(lightT),
      doors_lit: ratio(doorT),
      band_coverage: ratio(bandT),
      ...roomMeter(resolved, set, frame, opts.entryLevel, gives),
    },
    rooms,
  };
}

/**
 * The quality meter of a plan's build as it is pasted: realize, then verify's repairs (dropped and nudged pieces,
 * duplicates removed), then the meter. Costs one realize and one verify; `realized` hands in a fresh realize of this
 * plan (with the same orientation) that the caller is done with, and saves the realize: verify repairs it in place.
 */
export function qualityOfBuild(
  plan: MapPlan,
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: QualityOptions & { realized?: RealizedSet } = {},
): QualityReport {
  const orientation = opts.orientation ?? loadOrientation().orientation;
  const set = opts.realized ?? realize(resolved, palettes, { orientation });
  verifyBuild(resolved, set, palettes, { plan, flipZ: orientation.flipZ });
  return qualityMeter(resolved, set, {
    orientation,
    palettes,
    ...(plan.entryLevel !== undefined ? { entryLevel: plan.entryLevel } : {}),
  });
}

/** The report as baseline lines: `<name> <metric> <value>`, one per metric, in table order. */
export function qualityLines(name: string, report: QualityReport): string[] {
  return QUALITY_METRICS.map((d) => `${name} ${d.id} ${qualityValue(report.values[d.id])}`);
}

/** A value as the report prints it: 3 decimals at most, "–" for nothing measured. */
export function qualityValue(v: number | null): string {
  if (v === null) return "–";
  return String(Math.round(v * 1000) / 1000);
}

/** The report as a compact table: metric, value, target, a mark when outside it, tier and hard. */
export function qualityTable(report: QualityReport): string {
  const rows = QUALITY_METRICS.map((d) => {
    const v = report.values[d.id];
    return [
      d.id,
      qualityValue(v),
      targetText(d.id),
      withinTarget(d.id, v) ? "" : "OUT",
      d.tier,
      d.hard ? "hard*" : "",
    ];
  });
  const head = ["metric", "value", "target", "", "tier", ""];
  const all = [head, ...rows];
  const width = head.map((_, k) => maxOf(all.map((r) => (r[k] as string).length)));
  const line = (r: readonly string[]): string =>
    r
      .map((c, k) => (k === 1 ? c.padStart(width[k] as number) : c.padEnd(width[k] as number)))
      .join("  ")
      .trimEnd();
  const out = [line(head), ...rows.map(line)];
  if (report.rooms.length > 0) {
    out.push("", "room                      floor  loose  by walls  lane  blocked  lights/tile");
    for (const r of report.rooms)
      out.push(
        [
          `${r.levelId}/${r.id}`.padEnd(25).slice(0, 25),
          String(r.floor).padStart(5),
          String(r.loose).padStart(6),
          qualityValue(r.nearWall).padStart(9),
          String(r.lane).padStart(5),
          qualityValue(r.laneBlocked).padStart(8),
          qualityValue(r.lights).padStart(12),
        ].join(" "),
      );
  }
  out.push("", "hard*: a rule for the recipe output that claims it, never enforced on whole builds yet");
  return out.join("\n");
}
