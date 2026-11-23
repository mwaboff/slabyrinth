/**
 * Floor groups and station rows (generator 5, switch `floorGroups`): what stands in a room away from its walls, from
 * its kind's floor plans (gen/roomTraits.ts `floor`). Each unit is an anchor with its companions (a table and the seats
 * facing it, a bed and its nightstand), placed by the anchor-and-companion mechanism (gen/rooms4/groups.ts `tryGroup`),
 * whole or not at all, never cutting a free cell off from the doors.
 *
 *   groups    tables with seats in the middle, centres `pitch` apart, staggered in a lived-in room and in line in a tidy
 *             one; a ring a tile wide round each group is kept clear (the lane between groups and along the walls), and
 *             a lane from every door to each group; the units are drawn by weight (the odd one out), some turned a
 *             quarter, so no two groups are stamps of one another, and the first unit differs between rooms of a kind;
 *   rows      units in strict lines before the room's focus (the anchor group), facing it, an aisle between columns;
 *   wallRows  units along each long wall at `pitch`, the aisle down the middle kept clear;
 *   island    free-standing units on the long axis with a tile clear all round (a work table, a middle row of stock).
 *
 * The units and their seats take at most `share` of the floor; a room under `minCells` keeps what it has.
 */
import type { Side } from "../../contracts/plan";
import { featureInfo } from "../catalog";
import { EDGE_WALL, INWARD, SIDES, cellKey, stepSide } from "../gridGeometry";
import type { FloorPlan, FloorUnit, GroupSpec, RoomTraits } from "../roomTraits";
import { maxOf, minOf, pushAll } from "../../util/lists";
import {
  ALONG,
  type AnchorCand,
  type Frame,
  type PlacedGroup,
  anchorAt,
  frameCell,
  keepClear,
  keepLane,
  placeableSpec,
  tryGroup,
  wallSpots,
} from "./groups";
import type { Spec } from "./recipes";
import type { Room } from "./room";

type XY = [number, number];

/** What the floor placer put down: the units, for the lights that read them. */
export interface FloorResult {
  readonly units: PlacedGroup[];
}

const NONE: ReadonlySet<string> = new Set();

/** The group a floor unit is placed as (free-standing, its seats on the faces). */
const groupOf = (u: FloorUnit): GroupSpec => ({
  name: u.name,
  anchor: u.anchor,
  place: "axis",
  companions: u.companions,
  keep: 0,
  ...(u.light === true ? { light: true } : {}),
});

/** The room's box: its long-axis side (a frame on "N" runs along x), its size across and along. */
function box(room: Room): { long: Side; across: number; along: number } {
  const xs = room.cells.map((c) => c[0]);
  const ys = room.cells.map((c) => c[1]);
  const w = maxOf(xs) - minOf(xs) + 1;
  const h = maxOf(ys) - minOf(ys) + 1;
  return w >= h ? { long: "N", across: h, along: w } : { long: "W", across: w, along: h };
}

/** A unit drawn by weight; `avoid` (a unit just used) loses most of its weight, so neighbours differ. */
function drawUnit(room: Room, units: FloorPlan["units"], avoid?: FloorUnit): FloorUnit {
  const w = units.map((u) => (u === avoid && units.length > 1 ? u.weight * 0.35 : u.weight));
  let r = room.rng.next() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < units.length; i++) {
    r -= w[i] as number;
    if (r < 0) return units[i] as FloorUnit;
  }
  return units[0];
}

/**
 * A free-standing spot: the frame on `side` with the anchor's back row at row 1 (row 0 and row D+1 take its seats),
 * the anchor and its seat rows free and off the cleared zone, its ends the room's and unblocked, and a margin `m` round
 * it unblocked where it is the room's (a wall may stand there: a group may back its seats onto a wall, never touch a
 * piece).
 */
function freeSpot(room: Room, spec: Spec, side: Side, cell: XY, m: number): AnchorCand | null {
  const info = featureInfo(spec.type);
  const base = spec.size ?? info.size;
  const L = base[0] * (spec.run ?? 1);
  const D = base[1];
  const n = INWARD[side] as XY;
  const f: Frame = { side, u: ALONG[side], n, origin: [cell[0] - n[0], cell[1] - n[1]], k: 1, L, D };
  let walled = 0;
  for (let i = -1 - m; i <= L + m; i++)
    for (let j = -m; j <= D + 1 + m; j++) {
      const [x, y] = frameCell(f, i, j);
      const k = cellKey(x, y);
      const core = i >= 0 && i < L && j >= 0 && j <= D + 1;
      const ends = !core && i >= -1 && i <= L && j >= 0 && j <= D + 1;
      if (!room.inRoom.has(k)) {
        if (core || ends) return null;
        walled++;
        continue;
      }
      if (room.blocked(x, y)) return null;
      // the anchor and the rows its seats take stay off the doors' landings and the kept standing room
      if (core && (room.zone.has(k) || !room.free(x, y))) return null;
    }
  // free-standing: walls on one side of it at most
  if (walled > L + 2 * m + 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = -1; i <= L; i++)
    for (const j of [0, D + 1]) {
      const c = frameCell(f, i, j);
      xs.push(c[0]);
      ys.push(c[1]);
    }
  if (room.crossesWall([minOf(xs), minOf(ys)], [maxOf(xs) - minOf(xs) + 1, maxOf(ys) - minOf(ys) + 1]))
    return null;
  const a = anchorAt(room, spec, f, false);
  if (a === null) return null;
  return { frame: f, cand: { ...a, corner: false }, score: 0 };
}

/** The cells of a placed group's pieces. */
function groupCells(g: PlacedGroup): XY[] {
  const out: XY[] = [];
  for (const q of [...g.anchor, ...g.companions])
    for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
      for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) out.push([x, y]);
  return out;
}

/** The middle of a placed group (its pieces' centres). */
function middle(g: PlacedGroup): XY {
  const ps = [...g.anchor, ...g.companions].map((q) => q.centre);
  return [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];
}

/**
 * The ring a tile wide round a group, kept clear (the lane between groups and along the walls), and a lane from each
 * doorway of the room to it.
 */
function keepRound(room: Room, g: PlacedGroup): void {
  const mine = new Set(groupCells(g).map(([x, y]) => cellKey(x, y)));
  const ring: XY[] = [];
  for (const k of mine) {
    const x = Math.floor(k / 32768) - 16384;
    const y = (k % 32768) - 16384;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const c: XY = [x + dx, y + dy];
        const ck = cellKey(c[0], c[1]);
        if (mine.has(ck) || !room.inRoom.has(ck) || room.blocked(c[0], c[1])) continue;
        room.zone.add(ck);
        ring.push(c);
      }
  }
  // a lane from every doorway
  for (const s of doorways(room)) keepLane(room, ring, s);
}

/**
 * The way through from doorway `a` to doorway `b`, kept clear: a shortest walk over the room's floor (walls only in the
 * way), each step the one nearest the straight line between them, as a person crossing the room walks it.
 */
function keepThrough(room: Room, a: XY, b: XY): void {
  const dist = new Map<number, number>([[cellKey(b[0], b[1]), 0]]);
  const queue: XY[] = [b];
  const steps = ([x, y]: XY): XY[] =>
    SIDES.filter((s) => room.grid.edge(x, y, s) !== EDGE_WALL)
      .map((s) => stepSide(x, y, s))
      .filter(([nx, ny]) => room.inRoom.has(cellKey(nx, ny)));
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q] as XY;
    const d = dist.get(cellKey(c[0], c[1])) as number;
    for (const nb of steps(c))
      if (!dist.has(cellKey(nb[0], nb[1]))) {
        dist.set(cellKey(nb[0], nb[1]), d + 1);
        queue.push(nb);
      }
  }
  const da = dist.get(cellKey(a[0], a[1]));
  if (da === undefined) return;
  const off = (p: XY): number => {
    const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  };
  let at = a;
  room.zone.add(cellKey(a[0], a[1]));
  for (let d = da; d > 0; d--) {
    const next = steps(at)
      .filter((nb) => dist.get(cellKey(nb[0], nb[1])) === d - 1)
      .sort((p, q) => off(p) - off(q))[0];
    if (next === undefined) return;
    at = next;
    room.zone.add(cellKey(at[0], at[1]));
  }
}

/** One threshold cell per run of door cells: the room's doorways. */
function doorways(room: Room): XY[] {
  const starts: XY[] = [];
  for (const t of room.thresholds)
    if (!starts.some((s) => Math.abs(s[0] - t[0]) + Math.abs(s[1] - t[1]) <= 2)) starts.push(t);
  return starts;
}

/** The floor plans of a room's kind, in order. `focus`: the anchor group (rows face it). */
export function placeFloor(
  room: Room,
  t: RoomTraits,
  focus: PlacedGroup | null,
  memo: { first: number },
): FloorResult {
  const units: PlacedGroup[] = [];
  const n = room.cells.length;
  if (t.floor.some((plan) => n >= plan.minCells)) {
    // the way through between the room's doorways stays open: nothing stands on it
    const ds = doorways(room);
    for (let i = 0; i < ds.length; i++)
      for (let j = i + 1; j < ds.length; j++) keepThrough(room, ds[i] as XY, ds[j] as XY);
  }
  for (const plan of t.floor) {
    if (n < plan.minCells) continue;
    const b = box(room);
    if (plan.minWidth !== undefined && b.across < plan.minWidth) continue;
    const placed =
      plan.mode === "groups"
        ? placeGroups(room, t, plan, memo.first)
        : plan.mode === "rows"
          ? placeRows(room, t, plan, focus)
          : plan.mode === "wallRows"
            ? placeWallRows(room, t, plan, b.long)
            : placeIsland(room, t, plan, b.long);
    pushAll(units, placed);
  }
  return { units };
}

/**
 * Cells a unit takes (what `share` counts): a free-standing group its anchor and the seat rows either side, a row unit
 * its anchor and the standing row in front.
 */
const unitArea = (spec: Spec, free: boolean): number => {
  const base = spec.size ?? featureInfo(spec.type).size;
  return base[0] * (spec.run ?? 1) * (base[1] + (free ? 2 : 1));
};

function placeGroups(room: Room, t: RoomTraits, plan: FloorPlan, first: number): PlacedGroup[] {
  const out: PlacedGroup[] = [];
  const n = room.cells.length;
  const b = box(room);
  const across: Side = b.long === "N" ? "W" : "N";
  const tidy = t.order === "tidy";
  let used = 0;
  let last: FloorUnit | undefined;
  let turnedAny = false;
  for (let guard = 0; guard < 12; guard++) {
    // the first group of a room is the unit sibling rooms have not led with; then drawn by weight
    const unit =
      out.length === 0
        ? (plan.units[first % plan.units.length] as FloorUnit)
        : drawUnit(room, plan.units, last);
    const spec = placeableSpec(room, unit.anchor);
    if (spec === null) {
      last = unit;
      continue;
    }
    if (used + unitArea(spec, true) > plan.share * n) break;
    // some groups turned a quarter (one at least among three), the rest along the long axis
    const turn = room.rng.chance(plan.turned ?? 0) || (!turnedAny && out.length === 2);
    const side = turn ? across : b.long;
    const centres = out.map(middle);
    const spots: AnchorCand[] = [];
    for (const c of room.cells) {
      const s = freeSpot(room, spec, side, c, 1);
      if (s === null) continue;
      const mid = room.meanOf(s.cand.cells);
      const d =
        centres.length === 0 ? 0 : minOf(centres.map((q) => Math.hypot(q[0] - mid[0], q[1] - mid[1])));
      if (centres.length > 0 && d < plan.pitch[0]) continue;
      let score = room.rng.next() * 0.4;
      if (centres.length === 0)
        score -= 0.5 * Math.hypot(mid[0] - room.centroid[0], mid[1] - room.centroid[1]);
      else {
        score -= Math.abs(d - (plan.pitch[0] + plan.pitch[1]) / 2);
        // tidy rooms set their groups in line; lived-in ones stagger them
        const nearest = centres.reduce((a, q) =>
          Math.hypot(q[0] - mid[0], q[1] - mid[1]) < Math.hypot(a[0] - mid[0], a[1] - mid[1]) ? q : a,
        );
        const inLine = Math.abs(nearest[0] - mid[0]) < 0.5 || Math.abs(nearest[1] - mid[1]) < 0.5;
        score += inLine === tidy ? 0.3 : -0.3;
      }
      spots.push({ ...s, score });
    }
    const g = spots.length === 0 ? null : tryGroup(room, groupOf(unit), spec, spots, t.family, NONE);
    last = unit;
    if (g === null) continue;
    if (turn) turnedAny = true;
    used += unitArea(spec, true);
    keepRound(room, g);
    out.push(g);
  }
  return out;
}

function placeRows(room: Room, t: RoomTraits, plan: FloorPlan, focus: PlacedGroup | null): PlacedGroup[] {
  if (focus === null) return [];
  const out: PlacedGroup[] = [];
  const unit = plan.units[0];
  const spec = placeableSpec(room, unit.anchor);
  if (spec === null) return out;
  const base = spec.size ?? featureInfo(spec.type).size;
  const L = base[0] * (spec.run ?? 1);
  const D = base[1];
  const f0 = focus.frame;
  // the rows face the focus: their frame runs as the focus's, the seat on the far side of each desk
  const side = f0.side;
  const u = f0.u;
  const nn = f0.n;
  const ref = frameCell(f0, 0, f0.k + f0.D);
  const span = (v: XY): number[] => room.cells.map((c) => (c[0] - ref[0]) * v[0] + (c[1] - ref[1]) * v[1]);
  const [uLo, uHi] = [minOf(span(u)), maxOf(span(u))];
  const nHi = maxOf(span(nn));
  const n = room.cells.length;
  let used = 0;
  // past the focus's standing room, rows a desk and a seat deep; columns a desk wide with an aisle between
  for (let a = 1; a + D <= nHi; a += D + 1)
    for (let bU = uLo; bU + L - 1 <= uHi; bU += L + 1) {
      if (used + unitArea(spec, false) > plan.share * n) return out;
      const cell: XY = [ref[0] + u[0] * bU + nn[0] * a, ref[1] + u[1] * bU + nn[1] * a];
      const f: Frame = { side, u, n: nn, origin: cell, k: 0, L, D };
      let ok = true;
      for (let i = 0; i < L && ok; i++)
        for (let j = 0; j <= D && ok; j++) {
          const [x, y] = frameCell(f, i, j);
          if (!room.inRoom.has(cellKey(x, y)) || !room.free(x, y) || room.zone.has(cellKey(x, y))) ok = false;
        }
      if (!ok) continue;
      const cand = anchorAt(room, spec, f, false);
      if (cand === null) continue;
      const g = tryGroup(
        room,
        groupOf(unit),
        spec,
        [{ frame: f, cand: { ...cand, corner: false }, score: 0 }],
        t.family,
        NONE,
      );
      if (g === null) continue;
      // a desk in a row stands free: nothing behind it to keep the things on it off
      for (const q of g.anchor) q.unbacked = true;
      used += unitArea(spec, false);
      // the seat's standing room stays clear
      keepClear(room, g, 0);
      out.push(g);
    }
  return out;
}

function placeWallRows(room: Room, t: RoomTraits, plan: FloorPlan, long: Side): PlacedGroup[] {
  const out: PlacedGroup[] = [];
  // each long wall takes half the share
  const budget = (plan.share * room.cells.length) / 2;
  let last: FloorUnit | undefined;
  for (const side of long === "N" ? (["N", "S"] as const) : (["W", "E"] as const)) {
    const along = (c: XY): number => c[0] * ALONG[side][0] + c[1] * ALONG[side][1];
    // walk the wall from one end: the next unit starts `pitch` past the last one's start
    let cursor = -Infinity;
    let used = 0;
    for (let guard = 0; guard < 40; guard++) {
      const unit = cursor === -Infinity ? plan.units[0] : drawUnit(room, plan.units, last);
      const spec = placeableSpec(room, unit.anchor);
      last = unit;
      if (spec === null) continue;
      if (used + unitArea(spec, false) > budget) break;
      const spots = wallSpots(room, spec, "farWall", 0)
        .filter((s) => s.frame.side === side && along(s.frame.origin) >= cursor)
        .sort((a, b) => along(a.frame.origin) - along(b.frame.origin))
        .map((s, i) => ({ ...s, score: -i }));
      const nearest = spots[0];
      if (nearest === undefined) break;
      const g = tryGroup(room, groupOf(unit), spec, [nearest], t.family, NONE);
      if (g === null) {
        // the next stretch of wall
        cursor = along(nearest.frame.origin) + 1;
        continue;
      }
      const base = spec.size ?? featureInfo(spec.type).size;
      cursor = along(g.frame.origin) + Math.max(base[0] * (spec.run ?? 1), plan.pitch[0]);
      used += unitArea(spec, false);
      // the aisle before the row stays clear
      keepClear(room, g, 1);
      out.push(g);
    }
  }
  return out;
}

function placeIsland(room: Room, t: RoomTraits, plan: FloorPlan, long: Side): PlacedGroup[] {
  const out: PlacedGroup[] = [];
  const n = room.cells.length;
  let used = 0;
  let last: FloorUnit | undefined;
  for (let guard = 0; guard < 8; guard++) {
    const unit = out.length === 0 ? plan.units[0] : drawUnit(room, plan.units, last);
    last = unit;
    const spec = placeableSpec(room, unit.anchor);
    if (spec === null) continue;
    if (used + unitArea(spec, true) > plan.share * n) break;
    const centres = out.map(middle);
    const spots: AnchorCand[] = [];
    for (const c of room.cells) {
      const s = freeSpot(room, spec, long, c, 1);
      if (s === null) continue;
      const mid = room.meanOf(s.cand.cells);
      if (centres.some((q) => Math.hypot(q[0] - mid[0], q[1] - mid[1]) < plan.pitch[0] + 1)) continue;
      // on the long axis, near the middle
      const off = long === "N" ? Math.abs(mid[1] - room.centroid[1]) : Math.abs(mid[0] - room.centroid[0]);
      spots.push({
        ...s,
        score:
          -off * 2 -
          0.2 * Math.hypot(mid[0] - room.centroid[0], mid[1] - room.centroid[1]) +
          room.rng.next() * 0.2,
      });
    }
    if (spots.length === 0) break;
    const g = tryGroup(room, groupOf(unit), spec, spots, t.family, NONE);
    if (g === null) break;
    used += unitArea(spec, true);
    keepRound(room, g);
    out.push(g);
  }
  return out;
}
