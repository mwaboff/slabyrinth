/**
 * The ground-storey splitter (generator 5, switch `buildingRooms`): a building's ground floor split into the rooms of
 * its programme (gen/buildingProgramme.ts), each an ordinary room the level's room stage furnishes and lights.
 *
 * Steps:
 *   1. the programme: the building's kind from its words, then a programme its footprint holds (weighted draw); a
 *      small footprint is one room with zones (two rooms open to each other), a tiny one a single room;
 *   2. the layouts: the footprint as one rectangle, or two (an L or a T, cut along one grid line); the public room in
 *      a band across the street face or a column down the side the street door is on, the other rooms behind it or
 *      beside it in the programme's order (private furthest from the door), shares drawn within the programme's
 *      ranges and fitted to the grid; in two rectangles one room takes the wing without the street door;
 *   3. the checks every layout passes: each room holds its fewest cells and is at least 2 wide; the street door opens
 *      into the public room; the public room is the largest (unless the programme says otherwise); every chimney
 *      breast stands in a hearth room; no partition meets the outer wall inside a window or door, or at a door's jamb;
 *      every room is reached from the public room by interior doorways (a kitchen never opens into a bedroom);
 *   4. the draw among the layouts that pass, weighed down where a private room touches the street face or holds an
 *      outside door.
 * Any other footprint shape is one room. The result is rooms (cells) and interior doorways; resolve/structure.ts turns
 * them into synthetic areas and openings, so walls between rooms come from the ordinary edge rule.
 */
import type { OpeningKind, Side, Vec2 } from "../../contracts/plan";
import {
  type BuildingKind,
  type BuildingKindRow,
  PROGRAMME_SIZES,
  type Programme,
  ROOM_MIN_WIDTH,
  type ProgrammeRoom,
  type RoomRole,
  buildingKindRow,
  programmesFor,
} from "../../gen/buildingProgramme";
import { SIDE_STEP, SIDES } from "../../gen/gridGeometry";
import { isFrontDoor, isPassage, isSecret } from "../../gen/openingKinds";
import type { RoomKind } from "../../gen/roomPurpose";
import { maxOf, minOf, pushAll } from "../../util/lists";
import { createPrng, type Prng } from "../../util/prng";
import { type Rect, alongFace, boundsOf, key } from "./footprint";

/** What the splitter reads of a building. */
export interface GroundStorey {
  readonly id: string;
  readonly cells: ReadonlyArray<readonly [number, number]>;
  /** Its ground openings: face cell, side, kind and width. */
  readonly openings: ReadonlyArray<{
    readonly kind: OpeningKind;
    readonly at: readonly [number, number];
    readonly side: Side;
    readonly width: number;
  }>;
  /** The footprint cells behind its standing chimney breasts. */
  readonly hearths: ReadonlyArray<readonly [number, number]>;
  readonly kind: BuildingKind;
  readonly seed: number;
}

export interface GroundRoom {
  readonly name: string;
  readonly kind: RoomKind;
  readonly role: RoomRole;
  readonly cells: Vec2[];
  /** The other kinds it holds a zone of (gen/buildingProgramme.ts ProgrammeRoom.zones). */
  readonly zones?: readonly RoomKind[];
}

/** A programme room laid over its cells, as the splitter returns it. */
const groundRoom = (room: ProgrammeRoom, cells: ReadonlyArray<readonly [number, number]>): GroundRoom => ({
  name: room.name,
  kind: room.kind,
  role: room.role,
  cells: cells.map(([x, y]) => [x, y] as Vec2),
  ...(room.zones !== undefined ? { zones: room.zones } : {}),
});

/** An interior doorway: the cell on one side, the side it opens through, its kind and width. */
export interface GroundDoorway {
  readonly kind: "door" | "open";
  readonly at: Vec2;
  readonly side: Side;
  readonly width: number;
}

export interface GroundRooms {
  /** The programme drawn ("single" and "zones" for a tiny or small building). */
  readonly programme: string;
  /** The layout family ("band", "side", "wing+band", "wing+side", "whole"). */
  readonly layout: string;
  readonly rooms: readonly GroundRoom[];
  readonly doorways: readonly GroundDoorway[];
}

/** How the draw weighs a layout down. */
const PENALTY = {
  /** A private room on the street face. */
  privateOnStreet: 1,
  /** A private room holding an outside door. */
  privateOutsideDoor: 2,
} as const;

/** The least share of the floor the public room keeps (a shopfront before its workshop is the smallest). */
const MIN_PUBLIC_SHARE = 0.25;

/** A room laid out, before the checks: its programme row and cells. */
interface Laid {
  readonly room: ProgrammeRoom;
  readonly cells: Array<[number, number]>;
}

interface Candidate {
  readonly layout: string;
  readonly rooms: Laid[];
}

/**
 * Splits a ground storey; null when it has no street door to enter by. `own`: a programme row of another table (a
 * vessel's deck below, objects/vesselProgramme.ts) instead of the building kind's.
 */
export function splitGroundStorey(g: GroundStorey, own?: BuildingKindRow): GroundRooms | null {
  const door = streetDoor(g);
  if (!door) return null;
  const prng = createPrng(g.seed);
  const row = own ?? buildingKindRow(g.kind);
  const all = g.cells.map(([x, y]) => [x, y] as [number, number]);
  const whole = (room: ProgrammeRoom): GroundRooms => ({
    programme: "single",
    layout: "whole",
    rooms: [groundRoom(room, all)],
    doorways: [],
  });
  const rects = decompose(all);
  if (!rects || all.length < PROGRAMME_SIZES.single) return whole(row.single);
  const ctx = new SplitContext(g, door, rects);
  if (all.length >= PROGRAMME_SIZES.zones) {
    const held = own
      ? own.programmes.filter((p) => all.length >= p.minCells)
      : programmesFor(g.kind, all.length);
    for (const p of drawOrder(held, prng)) {
      const got = ctx.choose(p, prng, false);
      if (got) return got;
    }
  }
  const zones: Programme = { id: "zones", weight: 1, minCells: 0, rooms: row.zones };
  return ctx.choose(zones, prng, true) ?? whole(row.single);
}

/** The door the building is entered by from the street: a front door, else any open way in. */
function streetDoor(g: GroundStorey): GroundStorey["openings"][number] | undefined {
  const ways = g.openings.filter((o) => isPassage(o.kind) && !isSecret(o.kind));
  return ways.find((o) => isFrontDoor(o.kind)) ?? ways[0];
}

/** Programmes in a weighted draw order (each next one drawn from those left). */
function drawOrder(list: readonly Programme[], prng: Prng): Programme[] {
  const left = [...list];
  const out: Programme[] = [];
  while (left.length > 0) {
    const total = left.reduce((s, p) => s + p.weight, 0);
    let r = prng.next() * total;
    let k = 0;
    for (; k < left.length - 1; k++) {
      r -= (left[k] as Programme).weight;
      if (r < 0) break;
    }
    pushAll(out, left.splice(k, 1));
  }
  return out;
}

/**
 * The footprint as one rectangle, or as two cut along one grid line (an L or a T); null for any other shape.
 * Of two cuts that work (an L), the one that keeps the larger rectangle whole.
 */
export function decompose(cells: ReadonlyArray<readonly [number, number]>): Rect[] | null {
  const b = boundsOf(cells);
  const set = new Set(cells.map(([x, y]) => key(x, y)));
  const full = (r: Rect): boolean => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (!set.has(key(x, y))) return false;
    return true;
  };
  if (cells.length === b.w * b.h) return [b];
  // a part of the bounds as the rectangle its cells span (null when it has none or is not one)
  const part = (x0: number, y0: number, x1: number, y1: number): Rect | null => {
    const inside = cells.filter(([x, y]) => x >= x0 && x < x1 && y >= y0 && y < y1);
    if (inside.length === 0) return null;
    const r = boundsOf(inside);
    return inside.length === r.w * r.h && full(r) ? r : null;
  };
  let best: Rect[] | null = null;
  const consider = (a: Rect | null, c: Rect | null): void => {
    if (!a || !c || a.w * a.h + c.w * c.h !== cells.length) return;
    const big = Math.max(a.w * a.h, c.w * c.h);
    if (!best || big > maxOf(best.map((r) => r.w * r.h))) best = [a, c];
  };
  for (let y = b.y + 1; y < b.y + b.h; y++)
    consider(part(b.x, b.y, b.x + b.w, y), part(b.x, y, b.x + b.w, b.y + b.h));
  for (let x = b.x + 1; x < b.x + b.w; x++)
    consider(part(b.x, b.y, x, b.y + b.h), part(x, b.y, b.x + b.w, b.y + b.h));
  return best;
}

/** A rectangle seen from one of its faces: u along the face, v inward from it. */
class Frame {
  readonly W: number;
  readonly D: number;
  constructor(
    readonly r: Rect,
    readonly face: Side,
  ) {
    const alongX = face === "N" || face === "S";
    this.W = alongX ? r.w : r.h;
    this.D = alongX ? r.h : r.w;
  }
  /** The cells of the part u0..u1, v0..v1 (half-open). */
  cells(u0: number, u1: number, v0: number, v1: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) out.push(this.cell(u, v));
    return out;
  }
  cell(u: number, v: number): [number, number] {
    const { r } = this;
    switch (this.face) {
      case "N":
        return [r.x + u, r.y + v];
      case "S":
        return [r.x + u, r.y + r.h - 1 - v];
      case "W":
        return [r.x + v, r.y + u];
      case "E":
        return [r.x + r.w - 1 - v, r.y + u];
    }
  }
  /** The u of a cell of the rectangle. */
  u(c: readonly [number, number]): number {
    return this.face === "N" || this.face === "S" ? c[0] - this.r.x : c[1] - this.r.y;
  }
}

/** Integer sizes summing to `total`, each at least its `mins`, as near the weights as rounding allows (null if none fit). */
function fit(total: number, weights: readonly number[], mins: readonly number[]): number[] | null {
  if (mins.reduce((s, m) => s + m, 0) > total) return null;
  const sum = weights.reduce((s, w) => s + w, 0);
  const out = weights.map((w, i) => Math.max(mins[i] as number, Math.round((w / sum) * total)));
  let diff = total - out.reduce((s, n) => s + n, 0);
  // hand the rounding back to (or take it from) the largest parts first
  const order = out.map((_, i) => i).sort((a, b) => (weights[b] as number) - (weights[a] as number) || a - b);
  for (let guard = 0; diff !== 0 && guard < 64; guard++)
    for (const i of order) {
      if (diff === 0) break;
      const n = out[i] as number;
      if (diff > 0) {
        out[i] = n + 1;
        diff--;
      } else if (n > (mins[i] as number)) {
        out[i] = n - 1;
        diff++;
      }
    }
  return diff === 0 ? out : null;
}

/** All orders of a short list (the rooms behind the public room: at most four). */
function orders<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  const out: T[][] = [];
  list.forEach((x, i) => {
    for (const rest of orders([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

const ROLE_RANK: Readonly<Record<RoomRole, number>> = { public: 0, service: 1, private: 2 };

/** The rooms behind the public room in an order that keeps private rooms last (service ones in any order). */
function backOrders(rooms: readonly ProgrammeRoom[]): ProgrammeRoom[][] {
  return orders(rooms).filter((o) =>
    o.every((r, i) => i === 0 || ROLE_RANK[(o[i - 1] as ProgrammeRoom).role] <= ROLE_RANK[r.role]),
  );
}

class SplitContext {
  private readonly cellSet: Set<string>;
  /** Outer edge "x,y,side" → the index of the ground opening in it. */
  private readonly openingAt = new Map<string, number>();
  private readonly doorCells: Array<[number, number]>;

  constructor(
    private readonly g: GroundStorey,
    private readonly door: GroundStorey["openings"][number],
    private readonly rects: Rect[],
  ) {
    this.cellSet = new Set(g.cells.map(([x, y]) => key(x, y)));
    g.openings.forEach((o, i) => {
      for (let k = 0; k < o.width; k++) {
        const [x, y] = alongFace(o.at, o.side, k);
        this.openingAt.set(`${x},${y},${o.side}`, i);
      }
    });
    this.doorCells = [];
    for (let k = 0; k < door.width; k++) this.doorCells.push(alongFace(door.at, door.side, k));
  }

  /** A layout of the programme that passes every check, drawn among those that do; null when none does. */
  choose(p: Programme, prng: Prng, zones: boolean): GroundRooms | null {
    const shares = p.rooms.map((r) => r.share[0] + (r.share[1] - r.share[0]) * prng.next());
    const passed: Array<{ c: Candidate; doorways: GroundDoorway[]; weight: number }> = [];
    for (const c of this.layouts(p, shares)) {
      if (!this.sound(p, c, zones)) continue;
      const doorways = zones ? this.openAll(c) : this.connect(c, prng);
      if (!doorways) continue;
      passed.push({ c, doorways, weight: 1 / (1 + this.penalty(c)) ** 2 });
    }
    if (passed.length === 0) return null;
    const total = passed.reduce((s, x) => s + x.weight, 0);
    let r = prng.next() * total;
    let pick = passed[passed.length - 1] as (typeof passed)[number];
    for (const x of passed) {
      r -= x.weight;
      if (r < 0) {
        pick = x;
        break;
      }
    }
    return {
      programme: p.id,
      layout: pick.c.layout,
      rooms: pick.c.rooms.map((l) => groundRoom(l.room, l.cells)),
      doorways: pick.doorways,
    };
  }

  /** Every layout of the programme over the footprint's rectangles. */
  private layouts(p: Programme, shares: readonly number[]): Candidate[] {
    const [pub, ...rest] = p.rooms;
    const share = new Map<ProgrammeRoom, number>(p.rooms.map((r, i) => [r, shares[i] as number]));
    const home = this.rects.find((r) =>
      this.doorCells.every(([x, y]) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h),
    );
    if (!home) return [];
    if (this.rects.length === 1) return this.rectLayouts(home, pub, rest, share, "");
    const wing = this.rects.find((r) => r !== home) as Rect;
    const out: Candidate[] = [];
    // one room behind the public room takes the wing without the street door; the rest share the door's wing
    for (const inWing of rest) {
      const left = rest.filter((r) => r !== inWing);
      for (const c of this.rectLayouts(home, pub, left, share, "wing+"))
        out.push({ layout: c.layout, rooms: [...c.rooms, { room: inWing, cells: rectCellsOf(wing) }] });
    }
    return out;
  }

  /** Band and side layouts of the public room and the rooms behind it in one rectangle entered on the door's face. */
  private rectLayouts(
    r: Rect,
    pub: ProgrammeRoom,
    back: readonly ProgrammeRoom[],
    share: ReadonlyMap<ProgrammeRoom, number>,
    prefix: string,
  ): Candidate[] {
    const f = new Frame(r, this.door.side);
    if (back.length === 0)
      return [{ layout: `${prefix}whole`, rooms: [{ room: pub, cells: f.cells(0, f.W, 0, f.D) }] }];
    const s = (x: ProgrammeRoom): number => share.get(x) ?? 0;
    const pubShare = s(pub) / (s(pub) + back.reduce((t, x) => t + s(x), 0));
    const doorU = this.doorCells.map((c) => f.u(c));
    const uMin = minOf(doorU);
    const uMax = maxOf(doorU);
    const out: Candidate[] = [];
    const minW = (x: ProgrammeRoom): number => x.minWidth ?? ROOM_MIN_WIDTH;
    // the public room's depth (or width) as its share asks, rounded either way: the checks keep what fits
    const cuts = (n: number): number[] => [
      ...new Set([Math.round(pubShare * n), Math.floor(pubShare * n), Math.ceil(pubShare * n)]),
    ];
    for (const order of backOrders(back)) {
      // band: the public room across the street face, the others side by side behind it, private ones away from the door
      for (const depth of cuts(f.D)) {
        if (depth < 2 || f.D - depth < 2) continue;
        const widths = fit(
          f.W,
          order.map((x) => s(x)),
          order.map(minW),
        );
        if (widths) {
          const doorFirst = (uMin + uMax) / 2 < f.W / 2;
          // rooms run from the door's end to the far end, so the last (most private) is furthest from the door
          const run = (fromLow: boolean): Laid[] => {
            const rooms: Laid[] = [{ room: pub, cells: f.cells(0, f.W, 0, depth) }];
            let u = fromLow ? 0 : f.W;
            order.forEach((x, i) => {
              const w = widths[i] as number;
              const [u0, u1] = fromLow ? [u, u + w] : [u - w, u];
              rooms.push({ room: x, cells: f.cells(u0, u1, depth, f.D) });
              u = fromLow ? u1 : u0;
            });
            return rooms;
          };
          out.push({ layout: `${prefix}band`, rooms: run(doorFirst) });
          if (order.length > 1 && Math.abs((uMin + uMax) / 2 - (f.W - 1) / 2) < 1)
            out.push({ layout: `${prefix}band`, rooms: run(!doorFirst) });
        }
      }
      // side: the public room a column down the side the street door is on, the others one behind another beside it
      for (const width of cuts(f.W)) {
        if (width < 2 || f.W - width < 2) continue;
        const depths = fit(
          f.D,
          order.map((x) => s(x)),
          order.map(minW),
        );
        if (depths)
          for (const low of [true, false]) {
            const [p0, p1] = low ? [0, width] : [f.W - width, f.W];
            if (uMin < p0 || uMax >= p1) continue;
            const [o0, o1] = low ? [width, f.W] : [0, f.W - width];
            const rooms: Laid[] = [{ room: pub, cells: f.cells(p0, p1, 0, f.D) }];
            let v = 0;
            order.forEach((x, i) => {
              const d = depths[i] as number;
              rooms.push({ room: x, cells: f.cells(o0, o1, v, v + d) });
              v += d;
            });
            out.push({ layout: `${prefix}side`, rooms });
          }
      }
    }
    return out;
  }

  /**
   * The checks every layout passes (see the file header), doorways aside. Zones stand open to each other, one room with
   * no wall between them: the hearth may be in either, and no partition meets an opening.
   */
  private sound(p: Programme, c: Candidate, zones: boolean): boolean {
    const pub = c.rooms[0] as Laid;
    const total = c.rooms.reduce((s, l) => s + l.cells.length, 0);
    for (const l of c.rooms) {
      if (l.cells.length < l.room.minCells) return false;
      const b = boundsOf(l.cells);
      const narrowest = l.room.minWidth ?? ROOM_MIN_WIDTH;
      if (b.w < narrowest || b.h < narrowest) return false;
    }
    const roomOf = this.roomOf(c);
    if (this.doorCells.some(([x, y]) => roomOf.get(key(x, y)) !== 0)) return false;
    if ((p.publicLargest ?? true) && c.rooms.some((l) => l.cells.length > pub.cells.length)) return false;
    if (pub.cells.length < total * MIN_PUBLIC_SHARE) return false;
    if (zones) return true;
    // a chimney breast stands in a hearth room (the public room's stove where the programme has no hearth room)
    const anyHearth = c.rooms.some((l) => l.room.hearth === true);
    for (const [x, y] of this.g.hearths) {
      const k = roomOf.get(key(x, y));
      if (k === undefined || !(anyHearth ? c.rooms[k]?.room.hearth === true : k === 0)) return false;
    }
    return !this.partitionThroughOpening(roomOf);
  }

  /** Cell "x,y" → room index. */
  private roomOf(c: Candidate): Map<string, number> {
    const m = new Map<string, number>();
    c.rooms.forEach((l, i) => {
      for (const [x, y] of l.cells) m.set(key(x, y), i);
    });
    return m;
  }

  /**
   * Does a partition meet the outer wall inside an opening (the two outer edges either side of where it ends belong to
   * one window or door), or at a door's jamb?
   */
  private partitionThroughOpening(roomOf: ReadonlyMap<string, number>): boolean {
    const outer = (x: number, y: number, s: Side): number | null => {
      const [dx, dy] = SIDE_STEP[s];
      if (this.cellSet.has(key(x + dx, y + dy))) return null;
      return this.openingAt.get(`${x},${y},${s}`) ?? -1;
    };
    for (const k of this.cellSet) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const a = roomOf.get(k);
      for (const s of ["E", "S"] as const) {
        const [dx, dy] = SIDE_STEP[s];
        const b = roomOf.get(key(x + dx, y + dy));
        if (b === undefined || b === a) continue;
        // the partition between (x,y) and its neighbour ends at the faces perpendicular to it
        for (const perp of s === "E" ? (["N", "S"] as const) : (["W", "E"] as const)) {
          const oa = outer(x, y, perp);
          const ob = outer(x + dx, y + dy, perp);
          if (oa !== null && ob !== null && oa >= 0 && oa === ob) return true;
          for (const o of [oa, ob])
            if (
              o !== null &&
              o >= 0 &&
              isPassage((this.g.openings[o] as GroundStorey["openings"][number]).kind)
            )
              return true;
        }
      }
    }
    return false;
  }

  /** How much the draw weighs a layout down (see PENALTY). */
  private penalty(c: Candidate): number {
    let n = 0;
    const streetFace = this.door.side;
    for (const l of c.rooms) {
      if (l.room.role !== "private") continue;
      const cells = new Set(l.cells.map(([x, y]) => key(x, y)));
      const [dx, dy] = SIDE_STEP[streetFace];
      if (l.cells.some(([x, y]) => !this.cellSet.has(key(x + dx, y + dy)))) n += PENALTY.privateOnStreet;
      for (const o of this.g.openings)
        if (isPassage(o.kind) && o !== this.door && cells.has(key(o.at[0], o.at[1])))
          n += PENALTY.privateOutsideDoor;
    }
    return n;
  }

  /** Boundary edges between two rooms: the cell on room a's side and the side toward room b, in grid order. */
  private shared(c: Candidate, a: number, b: number): Array<{ at: [number, number]; side: Side }> {
    const roomOf = this.roomOf(c);
    const out: Array<{ at: [number, number]; side: Side }> = [];
    for (const [x, y] of (c.rooms[a] as Laid).cells)
      for (const s of SIDES) {
        const [dx, dy] = SIDE_STEP[s];
        if (roomOf.get(key(x + dx, y + dy)) === b) out.push({ at: [x, y], side: s });
      }
    return out;
  }

  /** Zones: every boundary edge between the two rooms open, in straight runs of at most three. */
  private openAll(c: Candidate): GroundDoorway[] | null {
    const edges = this.shared(c, 0, 1);
    if (edges.length === 0) return null;
    const out: GroundDoorway[] = [];
    for (const run of straightRuns(edges))
      for (let k = 0; k < run.length; k += 3) {
        const first = run[k] as { at: [number, number]; side: Side };
        out.push({ kind: "open", at: first.at, side: first.side, width: Math.min(3, run.length - k) });
      }
    return out;
  }

  /**
   * Interior doorways joining every room to the public room: straight to it where they share a wall, else through a
   * room already joined that is not private; never between two rooms one of which keeps the other's kind out. Null
   * when a room is left out.
   */
  private connect(c: Candidate, prng: Prng): GroundDoorway[] | null {
    const n = c.rooms.length;
    const joined = new Set<number>([0]);
    const out: GroundDoorway[] = [];
    const allowed = (a: number, b: number): boolean => {
      const ra = (c.rooms[a] as Laid).room;
      const rb = (c.rooms[b] as Laid).room;
      return !(ra.noDoorTo?.includes(rb.kind) || rb.noDoorTo?.includes(ra.kind));
    };
    const outsideDoorCells = new Set(
      this.g.openings.filter((o) => isPassage(o.kind)).map((o) => key(o.at[0], o.at[1])),
    );
    const clearOfDoors = (e: { at: [number, number]; side: Side }): boolean => {
      const [dx, dy] = SIDE_STEP[e.side];
      return (
        !outsideDoorCells.has(key(e.at[0], e.at[1])) && !outsideDoorCells.has(key(e.at[0] + dx, e.at[1] + dy))
      );
    };
    // where a doorway may stand on the wall between two rooms: off the corners (never at the end of a run, where a wall
    // meets it: a door leaf there runs into that wall), one in from an end first, never at an outside door's landing
    const spots = (a: number, b: number): Array<{ at: [number, number]; side: Side }> => {
      for (const run of straightRuns(this.shared(c, a, b)).sort((p, q) => q.length - p.length)) {
        if (run.length < 3) continue;
        const inner = run.slice(1, -1).filter(clearOfDoors);
        const near = inner.filter((e) => e === run[1] || e === run[run.length - 2]);
        if (near.length > 0) return near;
        if (inner.length > 0) return inner;
      }
      return [];
    };
    for (let round = 0; round < n && joined.size < n; round++)
      for (let i = 1; i < n; i++) {
        if (joined.has(i)) continue;
        // the public room first, then the rooms joined so far in order
        for (const via of [...joined].sort((p, q) => p - q)) {
          // never through a private room (a pantry reached across the bedroom)
          if (!allowed(i, via) || (c.rooms[via] as Laid).room.role === "private") continue;
          const at = spots(via, i);
          if (at.length === 0) continue;
          const spot = prng.pick(at);
          const room = (c.rooms[i] as Laid).room;
          const kind = room.doorway ?? (room.role === "private" ? "door" : "open");
          out.push({ kind, at: spot.at, side: spot.side, width: 1 });
          joined.add(i);
          break;
        }
      }
    return joined.size === n ? out : null;
  }
}

/** The cells of a rectangle, row by row. */
function rectCellsOf(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

/** Boundary edges grouped into straight runs (one line, consecutive cells), each run in increasing order. */
function straightRuns(
  edges: ReadonlyArray<{ at: [number, number]; side: Side }>,
): Array<Array<{ at: [number, number]; side: Side }>> {
  const sorted = [...edges].sort(
    (p, q) =>
      p.side.localeCompare(q.side) ||
      (p.side === "N" || p.side === "S"
        ? p.at[1] - q.at[1] || p.at[0] - q.at[0]
        : p.at[0] - q.at[0] || p.at[1] - q.at[1]),
  );
  const runs: Array<Array<{ at: [number, number]; side: Side }>> = [];
  for (const e of sorted) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    const alongX = e.side === "N" || e.side === "S";
    if (
      prev &&
      prev.side === e.side &&
      (alongX
        ? prev.at[1] === e.at[1] && prev.at[0] + 1 === e.at[0]
        : prev.at[0] === e.at[0] && prev.at[1] + 1 === e.at[1])
    )
      last.push(e);
    else runs.push([e]);
  }
  return runs;
}

/** Exported for tests. */
export const _internal = { fit, straightRuns };
