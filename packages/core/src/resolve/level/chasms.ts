/**
 * The chasm terrain op (part of step 4, terrain "over"): rifts, chasms and river channels cut into open floor.
 * Reads: the op (course, width, depth, floor, bridges), the cells' state and heights, the plan's own features (a
 * wandering channel keeps off them). Writes: cell heights, floors and flags along the cut, `channels` (the course of a
 * long rift or river), `falls` and `upperReach` (a stepped river's falls, pools and upper reaches), and `bridgeReqs`
 * (the op's bridges, laid later by resolve/level/bridges.ts). Also the river-course helpers that path ops share.
 */
import type { TerrainOp, Vec2 } from "../../contracts/plan";
import { PLAN_LIMITS } from "../../contracts/plan";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import { ValueNoise } from "../../gen/noise";
import { bandOffsets } from "../../gen/shapes";
import { elementSeed, subSeed } from "../../util/hash";
import { type ChasmGeometry, type ChasmSample, chasmGeometry, chasmSampleAt } from "../chasm";
import { type ChannelCell, type ReachPlan, planReaches } from "../falls";
import { materialOrdinal } from "../materials";
import { STILL_WATER, riverCourse } from "../water";
import type { ResolveGrid } from "./grid";

/** Generator 3: a long rift or river strays from the line between its ends by about this share of its length. */
const WANDER_SHARE = 0.2;
/** Samples (half a cell each) of the pool at the foot of a fall. */
const POOL_LENGTH = 7;
/** A pool is cut only into ground at most this far (a tile) above its level. */
const POOL_MAX_BANK_Q = 4;

/**
 * A river's inner points are drawn off the border, but never onto higher ground than the plan put them on (a brook at
 * the foot of a terrace stays at its foot): a moved point that would climb goes back where it was drawn.
 */
export function keepOffHighGround(work: ResolveGrid, drawn: readonly Vec2[], course: Vec2[]): Vec2[] {
  const hAt = (p: Vec2): number => {
    const i = work.idx(Math.round(p[0]), Math.round(p[1]));
    return i < 0 ? 0 : (work.height[i] as number);
  };
  const key = (p: Vec2): string => `${p[0]},${p[1]}`;
  const original = new Set(drawn.map(key));
  // inner points line up with the drawn points (extensions are only added at the ends)
  const offset = course.length > drawn.length && !original.has(key(course[0] as Vec2)) ? 1 : 0;
  return course.map((p, k) => {
    const d = drawn[k - offset];
    if (!d || original.has(key(p))) return p;
    return hAt(p) > hAt(d) ? ([d[0], d[1]] as Vec2) : p;
  });
}

/** The level's cells as a box (inclusive), for courses that run to the board edge. */
export function boardBox(work: ResolveGrid): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: work.bx, y0: work.by, x1: work.bx + work.w - 1, y1: work.by + work.h - 1 };
}

/**
 * Chasm op (§2.5): cuts open floor cells `depth` tiles down along a meandering course, optionally changes the
 * bottom's material, and queues its bridges for the bridge pass.
 */
export function applyChasm(work: ResolveGrid, op: Extract<TerrainOp, { op: "chasm" }>, path: string): void {
  const seed = elementSeed(work.plan.seed, op.id, op.seed);
  const clip = work.rasterClip();
  const wet0 = op.floor === "water_shallow" || op.floor === "water_deep";
  // a river channel crosses the map from one board edge to another (generator 2; still water keeps its course)
  const course =
    work.profile.riverCourses && wet0 && !STILL_WATER.test(op.id)
      ? keepOffHighGround(work, op.points, riverCourse(op.points, boardBox(work), op.width))
      : op.points;
  const wander = work.profile.wanderingChannels;
  // generator 3: a long rift, chasm or river strays visibly from the line between its ends (a fifth of its length)
  const geo = chasmGeometry(
    course,
    op.width,
    op.meander ?? 0.5,
    seed,
    {
      x0: clip.x0,
      y0: clip.y0,
      x1: clip.x1,
      y1: clip.y1,
    },
    wander && op.meander !== 0 && !STILL_WATER.test(op.id)
      ? { wander: WANDER_SHARE, avoid: explicitFeatureCells(work) }
      : {},
  );
  const wet = op.floor === "water_shallow" || op.floor === "water_deep";
  if (wander && geo.samples.length > 16 && !STILL_WATER.test(op.id))
    work.channels.push({
      id: op.id,
      kind: wet ? "river" : "rift",
      centre: geo.samples.filter((_, k) => k % 2 === 0).map((s) => [s.x, s.y] as Vec2),
      widths: geo.widths.filter((_, k) => k % 2 === 0).map((w) => Math.round(w * 10) / 10),
    });
  // a water channel needs room for TaleSpire's board-wide water plane (an imprecise slider): a tile deep leaves half
  // a tile between "bed covered" and "banks flooded"
  const depthQ = Math.round((wet ? Math.max(1, op.depth ?? 1) : (op.depth ?? 3)) * 4);
  if (wet && op.depth !== undefined && op.depth < 1)
    work.issue(
      "warning",
      "water_level",
      `chasm "${op.id}" is a water channel only ${op.depth} deep; it is cut 1 tile deep`,
      {
        path,
        elementId: op.id,
        hint: "water in TaleSpire is a board-wide plane: a channel at least 1 tile deep keeps it in the channel and off the banks",
      },
    );
  const cut = new Set<number>();
  let outside = 0;
  // ledges part-way down (deep chasms): rim cells where a noise field is high stop at about half depth, keeping the
  // ground they were cut from, so the walls step down in places instead of dropping sheer everywhere
  const geoSet = new Set(geo.cells.map(([x, y]) => `${x},${y}`));
  const shelfNoise = new ValueNoise(subSeed(seed, "shelf"));
  const shelfQ = depthQ >= 8 ? 2 * Math.round(depthQ / 4) : 0;
  // generator 3: a river runs at one level. Its bed follows the channel's low side (a lower quartile of the ground it
  // crosses), so a bank it clips on a terrace is cut down to that bed instead of raising the board-wide water surface
  let lowSide = Infinity;
  // a river that drops 2 tiles or more is split into reaches at different levels with a fall between them
  let reaches: ReachPlan | null = null;
  if (wet && wander && !STILL_WATER.test(op.id)) {
    const grounds: number[] = [];
    const chan: ChannelCell[] = [];
    for (const [x, y] of geo.cells) {
      const i = work.idx(x, y);
      if (i >= 0 && work.state[i] === CELL.OPEN) {
        grounds.push(work.height[i] as number);
        chan.push({ i, x, y });
      }
    }
    grounds.sort((m, n) => m - n);
    if (grounds.length > 0) lowSide = grounds[Math.floor((grounds.length - 1) * 0.25)] as number;
    reaches = planReaches(geo.samples, chan, geo.widths, (x, y) => {
      const i = work.idx(x, y);
      return i >= 0 && work.state[i] === CELL.OPEN ? (work.height[i] as number) : null;
    });
  }
  for (const [x, y] of geo.cells) {
    const i = work.idx(x, y);
    if (i < 0) {
      outside++;
      continue;
    }
    if (work.state[i] !== CELL.OPEN) continue;
    const cur = work.height[i] as number;
    const rim = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ].some(([nx, ny]) => !geoSet.has(`${nx},${ny}`));
    if (shelfQ > 0 && rim && shelfNoise.sample(x / 3, y / 3) > 0.62) {
      work.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, cur - shelfQ);
      cut.add(i);
      continue;
    }
    const level = reaches ? (reaches.low[reaches.reachOf.get(i) ?? 0] ?? lowSide) : lowSide;
    work.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(cur, level) - depthQ);
    if (reaches && (reaches.reachOf.get(i) ?? 0) < reaches.low.length - 1) work.upperReach.add(i);
    if (op.floor === "none") {
      work.flags[i] = ((work.flags[i] as number) | CELL_FLAG.NO_FLOOR) & ~(CELL_FLAG.WATER | CELL_FLAG.PATH);
      work.mat[i] = 0;
    } else if (op.floor !== undefined) {
      work.setMaterial(i, op.floor);
      work.flags[i] = (work.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.PATH);
    }
    cut.add(i);
  }
  if (cut.size === 0) {
    work.issue(
      "warning",
      "no_effect",
      `chasm "${op.id}" cut nothing: its course crosses no open floor${outside > 0 ? " inside the level" : ""}`,
      {
        path,
        elementId: op.id,
        hint: "run it through an area (a chasm only cuts floor that an area or ground has opened); list it in the level's terrain, which is applied after the areas",
      },
    );
    return;
  }
  (op.bridges ?? []).forEach((b, k) => {
    const bid = `${op.id}~b${k + 1}`;
    const s = chasmSampleAt(geo, b.at ?? 0.5);
    if (!s) return;
    // bridges run square across the chasm: N–S where the chasm runs mostly E–W, else E–W
    let vertical = Math.abs(s.tx) >= Math.abs(s.ty);
    const px = Math.floor(s.x);
    const py = Math.floor(s.y);
    if (wander) {
      // generator 3: a bridge takes the shortest span across the cut, square to the channel there (a wandering rift
      // can run either way at its sample): measure the cut cells in a line along each axis through the sample
      const spanAlong = (vert: boolean): number => {
        let n = 0;
        for (const dir of [-1, 1])
          for (let step = 0; step < 64; step++) {
            const i = work.idx(vert ? px : px + dir * (step + 1), vert ? py + dir * (step + 1) : py);
            if (i < 0 || !cut.has(i)) break;
            n++;
          }
        return n;
      };
      const sv = spanAlong(true);
      const sh = spanAlong(false);
      if (sv !== sh) vertical = sv < sh;
    }
    const width = b.width ?? 2;
    const [lo, hi] = bandOffsets(width);
    const cells: number[] = [];
    for (let o = lo; o <= hi; o++) {
      const sx = vertical ? px + o : px;
      const sy = vertical ? py : py + o;
      const start = work.idx(sx, sy);
      if (start < 0 || !cut.has(start)) continue;
      cells.push(start);
      for (const dir of [-1, 1]) {
        for (let step = 1; step < 64; step++) {
          const i = work.idx(vertical ? sx : sx + dir * step, vertical ? sy + dir * step : sy);
          if (i < 0 || !cut.has(i)) break;
          cells.push(i);
        }
      }
    }
    if (cells.length === 0) {
      work.issue(
        "warning",
        "no_effect",
        `bridge ${k + 1} of chasm "${op.id}" found no chasm cell to span at at=${b.at ?? 0.5}`,
        {
          path: `${path}/bridges/${k}`,
          elementId: op.id,
          hint: "move it (at 0..1 along the chasm) to where the chasm crosses open floor",
        },
      );
      return;
    }
    work.bridgeReqs.push({
      id: bid,
      elementId: op.id,
      path: `${path}/bridges/${k}`,
      cells: [...new Set(cells)].sort((a, c) => a - c),
      floorMat: materialOrdinal(b.floor ?? "flagstone"),
      deck: null,
      railing: b.railing === "none" ? null : b.railing,
      broken: [],
      crumble: b.crumble ?? 0,
      seed: subSeed(seed, `bridge${k}`),
      axis: vertical ? "v" : "h",
      ...(b.span !== undefined ? { span: b.span } : {}),
      ...(b.arch !== undefined ? { arch: b.arch } : {}),
    });
  });
  if (reaches) cutFalls(work, op, geo, reaches, geoSet, depthQ);
}

/** Cells under the plan's own features (with a one-cell margin): a wandering channel keeps off them when it can. */
function explicitFeatureCells(work: ResolveGrid): Set<string> {
  const out = new Set<string>();
  for (const f of work.level.features) {
    const [w, h] = rotatedSize(f.size ?? featureInfo(f.type).size, f.rot ?? 0);
    for (let y = f.at[1] - 1; y <= f.at[1] + h; y++)
      for (let x = f.at[0] - 1; x <= f.at[0] + w; x++) out.add(`${x},${y}`);
  }
  return out;
}

/**
 * Falls of a stepped river (generator 3): a pool wider than the channel at the foot of each, the fall recorded on
 * the resolved level (position, direction, width, surfaces and beds, lip and pool cells).
 */
function cutFalls(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "chasm" }>,
  geo: ChasmGeometry,
  reaches: ReachPlan,
  geoSet: Set<string>,
  depthQ: number,
): void {
  const n = geo.samples.length;
  const nearBridge = new Set<number>();
  for (const req of work.bridgeReqs)
    if (req.elementId === op.id)
      for (const c of req.cells) {
        nearBridge.add(c);
        for (const j of work.neighbours4(c)) if (j >= 0) nearBridge.add(j);
      }
  const elev = work.level.elevation;
  reaches.falls.forEach((fall, f) => {
    const lowQ = reaches.low[f + 1] as number;
    const from = fall.boundary;
    const to = Math.min(n - 1, from + POOL_LENGTH);
    const pool = new Set<number>();
    for (const [i, fp] of reaches.flowOf)
      if (reaches.reachOf.get(i) === f + 1 && fp >= from && fp <= to) pool.add(i);
    for (let j = from; j <= to; j++) {
      const k = reaches.flow[j] as number;
      const s = geo.samples[k] as ChasmSample;
      // widest in the middle of the pool, a cell and a bit wider than the channel at least
      const mid = 1 - Math.abs(j - (from + to) / 2) / Math.max(1, (to - from) / 2);
      const hw = (geo.widths[k] as number) / 2 + 1 + 0.8 * mid;
      const r = Math.ceil(hw) + 1;
      for (let y = Math.floor(s.y) - r; y <= Math.floor(s.y) + r; y++)
        for (let x = Math.floor(s.x) - r; x <= Math.floor(s.x) + r; x++) {
          const dx = x + 0.5 - s.x;
          const dy = y + 0.5 - s.y;
          if (dx * dx + dy * dy > hw * hw || geoSet.has(`${x},${y}`)) continue;
          const i = work.idx(x, y);
          if (i < 0 || pool.has(i) || nearBridge.has(i) || work.state[i] !== CELL.OPEN) continue;
          const fl = work.flags[i] as number;
          if ((fl & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.BRIDGE)) !== 0)
            continue;
          if (work.areas[(work.struct[i] as number) - 1]?.kind === "building") continue;
          const cur = work.height[i] as number;
          // a bank much higher than the pool would leave a tall bare face, and a pool must not eat into the bank of
          // another reach where the course doubles back: keep both
          if (cur - lowQ > POOL_MAX_BANK_Q) continue;
          if (work.neighbours4(i).some((j) => j >= 0 && (reaches.reachOf.get(j) ?? f + 1) !== f + 1))
            continue;
          work.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(cur, lowQ) - depthQ);
          if (op.floor !== undefined && op.floor !== "none") work.setMaterial(i, op.floor);
          work.flags[i] = (work.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.PATH);
          pool.add(i);
        }
    }
    if (f + 1 < reaches.low.length - 1) for (const i of pool) work.upperReach.add(i);
    const upper = reaches.low[f] as number;
    work.falls.push({
      id: `${op.id}~fall${f + 1}`,
      river: op.id,
      at: fall.at,
      side: fall.side,
      width: fall.lip.length,
      top: elev + upper / 4,
      bottom: elev + lowQ / 4,
      bedTop: elev + (upper - depthQ) / 4 + 0.5,
      bedBottom: elev + (lowQ - depthQ) / 4 + 0.5,
      drop: (upper - lowQ) / 4,
      lip: fall.lip.map((i) => work.cellXY(i) as Vec2),
      pool: [...pool].sort((a, b) => a - b).map((i) => work.cellXY(i) as Vec2),
    });
  });
}
