/**
 * Anchor-and-companion groups (generator 5, switch `companionGroups`): one mechanism, driven by the room-kind table
 * (gen/roomTraits.ts), for "a bed with its nightstand and chest", "a counter with stools and a back store", "a desk
 * with its chair", "a forge with its anvil and quench".
 *
 * A group is an anchor placed by its rule (`AnchorPlace`) and companions placed in the anchor's frame: `u` runs along
 * the anchor, `n` from its back (a wall, or the staff lane of a free-standing anchor) to its open face. A companion
 * takes a slot (head, front, back, wall behind, flank), a gap to the anchor's real outline, a facing and a count. The
 * anchor and the companions of the room's minimum set are placed whole or not at all; the others where they fit. A
 * group never takes a door's landing, and keeps every free cell reachable from the doors; afterwards the room keeps
 * standing room in front of the group and a lane from the main door to it (`keepClear`, `keepLane`).
 */
import type { Rotation, Side } from "../../contracts/plan";
import { featureInfo, rotatedSize } from "../catalog";
import type { GeneratedPlacement } from "../placementGrid";
import { EDGE_WALL, INWARD, SIDES, SIDE_ROT, cellKey, footprintCells, stepSide } from "../gridGeometry";
import type {
  AnchorPlace,
  Companion,
  CompanionSlot,
  GroupSpec,
  LiningSpec,
  PieceChoice,
} from "../roomTraits";
import { SURFACE_LOAD } from "../surfaces";
import { maxOf, minOf, pushAll } from "../../util/lists";
import type { Family, Spec } from "./recipes";
import { type Placed, type Room, clampTo, touchShift } from "./room";
import { type Cand, commitCand, placeWall } from "./wall";

type XY = [number, number];

/** The measures groups are placed by (tiles). */
export const GROUPS = {
  /** A piece no taller than this may stand against a window (a desk, a bed, a table); taller ones never do. */
  windowSill: 1.25,
  /** An anchor that faces the door stands this far from it where the room allows (in view of the entrance). */
  doorView: [3, 7] as const,
  /** How many of the best spots for an anchor are tried. */
  tries: 8,
  /** A companion takes one cell: its piece's outline is at most this long either way. */
  cellFit: 1.06,
} as const;

/**
 * An anchor's frame: `origin` is the cell of the back row (row 0, against the wall) at the anchor's first tile, `u` the
 * step along it, `n` the step into the room; the anchor's cells are i in [0, L), j in [k, k + D).
 */
export interface Frame {
  side: Side;
  u: XY;
  n: XY;
  origin: XY;
  /** Rows between the back wall and the anchor (0: it stands against the wall). */
  k: number;
  L: number;
  D: number;
}

const ALONG: Readonly<Record<Side, XY>> = { N: [1, 0], S: [1, 0], E: [0, 1], W: [0, 1] };

/** The cell at (i, j) of a frame. */
export const frameCell = (f: Frame, i: number, j: number): XY => [
  f.origin[0] + f.u[0] * i + f.n[0] * j,
  f.origin[1] + f.u[1] * i + f.n[1] * j,
];

const dot = (p: readonly [number, number], v: readonly [number, number]): number => p[0] * v[0] + p[1] * v[1];
const neg = (v: XY): XY => [-v[0], -v[1]];

/** The side of a cell a unit step points through. */
const sideOf = (v: readonly [number, number]): Side =>
  v[0] > 0 ? "E" : v[0] < 0 ? "W" : v[1] > 0 ? "S" : "N";

/** The turn (15° steps) of a piece whose front faces direction `v` (rot 0 faces south, as the realizer turns it). */
function turnToward(v: readonly [number, number]): { rot: Rotation; rotFine: number } {
  const deg = (Math.atan2(-v[0], v[1]) * 180) / Math.PI;
  const rotFine = (((Math.round(deg / 15) * 15) % 360) + 360) % 360;
  const rot = ((Math.round(rotFine / 90) * 90) % 360) as Rotation;
  return { rot, rotFine };
}

/** The frame of pieces the wall placer stood against the wall on `side` (a lining item with companions). */
export function wallFrame(pieces: readonly Placed[], side: Side): Frame {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pieces) {
    x0 = Math.min(x0, p.at[0]);
    y0 = Math.min(y0, p.at[1]);
    x1 = Math.max(x1, p.at[0] + p.size[0] - 1);
    y1 = Math.max(y1, p.at[1] + p.size[1] - 1);
  }
  const origin: XY = side === "S" ? [x0, y1] : side === "E" ? [x1, y0] : [x0, y0];
  const across = side === "N" || side === "S";
  return {
    side,
    u: ALONG[side],
    n: INWARD[side] as XY,
    origin,
    k: 0,
    L: across ? x1 - x0 + 1 : y1 - y0 + 1,
    D: across ? y1 - y0 + 1 : x1 - x0 + 1,
  };
}

/** A spot for an anchor: its frame, the wall placer's candidate (pieces, turn, cells) and how good it is. */
interface AnchorCand {
  frame: Frame;
  cand: Cand;
  score: number;
}

/** The spec as the wall placer would place it: its stacking variant where it carries things, else the theme's own. */
function placeableSpec(room: Room, spec: Spec): Spec | null {
  const stackVariant = SURFACE_LOAD[spec.type]?.stackVariant;
  if (
    stackVariant !== undefined &&
    spec.variant === undefined &&
    spec.top !== "none" &&
    room.has(spec.type, stackVariant)
  )
    return { ...spec, variant: stackVariant };
  if (spec.variant !== undefined && !room.has(spec.type, spec.variant)) {
    const alt: Spec = { ...spec, stack: false };
    delete alt.variant;
    return room.has(alt.type) ? alt : null;
  }
  return room.has(spec.type, spec.variant) ? spec : null;
}

/** The smallest rectangle of cells that holds these cells. */
function rectOf(list: readonly XY[]): { at: XY; size: XY } {
  const xs = list.map((c) => c[0]);
  const ys = list.map((c) => c[1]);
  const at: XY = [minOf(xs), minOf(ys)];
  return { at, size: [maxOf(xs) - at[0] + 1, maxOf(ys) - at[1] + 1] };
}

/** The anchor's pieces and cells in a frame, or null when they do not fit there. */
function anchorAt(room: Room, spec: Spec, f: Frame, pushToWall: boolean): Omit<Cand, "corner"> | null {
  const info = featureInfo(spec.type);
  const base = spec.size ?? info.size;
  const run = spec.run ?? 1;
  const ext = room.piece(spec.type, spec.variant);
  const rot = SIDE_ROT[f.side];
  const cells: XY[] = [];
  for (let i = 0; i < f.L; i++)
    for (let j = f.k; j < f.k + f.D; j++) {
      const [x, y] = frameCell(f, i, j);
      if (!room.free(x, y) || (info.blocking && room.zone.has(cellKey(x, y)))) return null;
      cells.push([x, y]);
    }
  if (!room.oneHeight(cells)) return null;
  const whole = rectOf(cells);
  if (room.crossesWall(whole.at, whole.size)) return null;
  const pieces: Cand["pieces"] = [];
  for (let r = 0; r < run; r++) {
    const own: XY[] = [];
    for (let i = r * base[0]; i < (r + 1) * base[0]; i++)
      for (let j = f.k; j < f.k + f.D; j++) own.push(frameCell(f, i, j));
    const pr = rectOf(own);
    const psize = rotatedSize(base, rot);
    const shift: XY | null =
      ext === undefined || ext.tile || !pushToWall
        ? [0, 0]
        : touchShift(room.grid, pr.at, psize, rot, ext, room.postAt);
    if (shift === null) return null;
    // nothing blocking reaches over the cells in front of a way in (it would be refused when committed)
    if (
      info.blocking &&
      room.grid.blocksWayIn?.(spec.type, pr.at, psize, spec.variant, { rotFine: rot, offset: shift })
    )
      return null;
    pieces.push({ at: pr.at, size: psize, shift });
  }
  return { pieces, side: f.side, rot, cells };
}

/** How good a spot is for an anchor placed by `place` (higher is better), with a seeded jitter. */
function scoreSpot(
  room: Room,
  f: Frame,
  cells: readonly XY[],
  place: AnchorPlace,
  atWindow: boolean,
): number {
  const mid = room.meanOf(cells);
  const toDoor: XY = [room.entry[0] - mid[0], room.entry[1] - mid[1]];
  const dEntry = Math.hypot(toDoor[0], toDoor[1]);
  let score = room.rng.next();
  if (place === "facingDoor" || place === "free") {
    // its face turned to the door, 3 to 7 tiles off it
    const facing = dEntry > 0 ? dot(f.n, toDoor) / dEntry : 0;
    const [lo, hi] = GROUPS.doorView;
    score += facing * 1.2 + (dEntry >= lo && dEntry <= hi ? 0.8 : -0.15 * Math.min(Math.abs(dEntry - 5), 4));
  } else score += dEntry * 0.35;
  if (place === "window" && atWindow) score += 2;
  return score;
}

/** Spots against a wall (k = 0) or free of it with k rows behind (a staff lane, a store row against the wall). */
function wallSpots(room: Room, spec: Spec, place: AnchorPlace, k: number): AnchorCand[] {
  const info = featureInfo(spec.type);
  const base = spec.size ?? info.size;
  const L = base[0] * (spec.run ?? 1);
  const D = base[1];
  // a low anchor may stand at a window (a desk under the light); a tall one never stands across one
  const low = (room.piece(spec.type, spec.variant)?.hMax ?? 2) <= GROUPS.windowSill;
  const out: AnchorCand[] = [];
  const backs = k === 0 && low ? [...room.wallPairs, ...room.windowPairs] : room.wallPairs;
  for (const [x, y, s] of backs) {
    const f: Frame = { side: s, u: ALONG[s], n: INWARD[s] as XY, origin: [x, y], k, L, D };
    let ok = true;
    let atWindow = false;
    // the back row backs onto the wall (a low piece onto a window too) along the anchor's whole length
    for (let i = 0; i < L && ok; i++) {
      const [cx, cy] = frameCell(f, i, 0);
      if (!room.inRoom.has(cellKey(cx, cy))) ok = false;
      else if (k === 0 && low && room.windowAt(cx, cy, s)) atWindow = true;
      else if (room.grid.edge(cx, cy, s) !== EDGE_WALL) ok = false;
    }
    if (!ok) continue;
    // the rows behind a free-standing anchor are the room's, free, and stay walkable (a lane, a store row)
    for (let i = 0; i < L && ok; i++)
      for (let j = 0; j < k && ok; j++) {
        const [cx, cy] = frameCell(f, i, j);
        if (!room.free(cx, cy) || room.zone.has(cellKey(cx, cy))) ok = false;
      }
    // and its face opens onto the room
    for (let i = 0; i < L && ok && k > 0; i++) {
      const [cx, cy] = frameCell(f, i, k + D);
      if (!room.inRoom.has(cellKey(cx, cy))) ok = false;
    }
    if (!ok) continue;
    if (k > 0) {
      const all: XY[] = [];
      for (let i = 0; i < L; i++) for (let j = 0; j < k + D; j++) all.push(frameCell(f, i, j));
      const r = rectOf(all);
      if (room.crossesWall(r.at, r.size)) continue;
    }
    const a = anchorAt(room, spec, f, k === 0);
    if (a === null) continue;
    const cand: Cand = { ...a, corner: room.cornerPairs.has(cellKey(x, y)) };
    out.push({ frame: f, cand, score: scoreSpot(room, f, a.cells, place, atWindow) });
  }
  return out;
}

/** Spots on the room's long axis, free-standing with a tile clear all round (a dining table, a chart table). */
function axisSpots(room: Room, spec: Spec): AnchorCand[] {
  const info = featureInfo(spec.type);
  const base = spec.size ?? info.size;
  const L = base[0] * (spec.run ?? 1);
  const D = base[1];
  const box = rectOf(room.cells);
  const side: Side = box.size[0] >= box.size[1] ? "N" : "W";
  const u = ALONG[side];
  const n = INWARD[side] as XY;
  const out: AnchorCand[] = [];
  for (const [x, y] of room.cells) {
    const f: Frame = { side, u, n, origin: [x - n[0], y - n[1]], k: 1, L, D };
    // the ring a tile wide round it: the room's, nothing standing, no wall through it
    let ok = true;
    const ring: XY[] = [];
    for (let i = -1; i <= L && ok; i++)
      for (let j = 0; j <= D + 1 && ok; j++) {
        const [cx, cy] = frameCell(f, i, j);
        if (!room.inRoom.has(cellKey(cx, cy)) || room.blocked(cx, cy)) ok = false;
        ring.push([cx, cy]);
      }
    if (!ok) continue;
    const r = rectOf(ring);
    if (room.crossesWall(r.at, r.size)) continue;
    const a = anchorAt(room, spec, f, false);
    if (a === null) continue;
    const mid = room.meanOf(a.cells);
    const score = -Math.hypot(mid[0] - room.centroid[0], mid[1] - room.centroid[1]) + room.rng.next() * 0.3;
    out.push({ frame: f, cand: { ...a, corner: false }, score });
  }
  return out;
}

/** The cells of a slot in the frame, in the order they are filled. */
function slotCells(f: Frame, slot: CompanionSlot): XY[] {
  const row = (j: number): XY[] => {
    // middle out, so one seat at a long table sits at its middle
    const order = Array.from({ length: f.L }, (_, i) => i).sort(
      (a, b) => Math.abs(a - (f.L - 1) / 2) - Math.abs(b - (f.L - 1) / 2) || a - b,
    );
    return order.map((i) => frameCell(f, i, j));
  };
  switch (slot) {
    case "head":
      return [frameCell(f, -1, f.k), frameCell(f, f.L, f.k)];
    case "front":
      return row(f.k + f.D);
    case "back":
      return f.k >= 1 ? row(f.k - 1) : [];
    case "wallBehind":
      return f.k >= 2 ? row(0) : [];
    case "flank":
      return [frameCell(f, -1, f.k + f.D), frameCell(f, f.L, f.k + f.D)];
  }
}

/** The step from a slot's cell toward the anchor (the side no wall may stand on between them). */
function towardAnchor(f: Frame, slot: CompanionSlot, cell: XY): XY {
  const i = dot([cell[0] - f.origin[0], cell[1] - f.origin[1]], f.u);
  if (slot === "head") return i < 0 ? f.u : neg(f.u);
  if (slot === "front" || slot === "flank") return neg(f.n);
  return f.n;
}

/** A companion chosen for a cell, before it is committed. */
interface Pick {
  comp: Companion;
  piece: PieceChoice;
  cell: XY;
  placement: GeneratedPlacement;
  centre: XY;
  blocking: boolean;
  height: number;
}

/** Where the anchor's pieces stand (centres) and how far they reach, from a candidate not yet committed. */
function anchorReach(
  room: Room,
  spec: Spec,
  cand: Cand,
  f: Frame,
): { n: number; halfN: number; uMin: number; uMax: number; length: number } {
  const ext = room.piece(spec.type, spec.variant);
  const halfU = (ext?.wMax ?? 1) / 2;
  const halfN = (ext?.dMax ?? 1) / 2;
  const centres = cand.pieces.map(
    (p) => [p.at[0] + p.size[0] / 2 + p.shift[0], p.at[1] + p.size[1] / 2 + p.shift[1]] as XY,
  );
  const us = centres.map((c) => dot(c, f.u));
  // the length a row of seats has along it: the real pieces, end to end, never more than their cells
  const length = Math.min(f.L, (ext?.w ?? 1) * cand.pieces.length);
  return {
    n: dot(centres[0] as XY, f.n),
    halfN,
    uMin: minOf(us) - halfU,
    uMax: maxOf(us) + halfU,
    length,
  };
}

/** Seats along an anchor stand no closer together than this (tiles): the low end of the measured pitch is 0.65. */
const SEAT_PITCH = 0.8;

/**
 * The piece a companion is in this room's theme: the first of its stand-ins the theme has that fits the one cell a
 * companion takes (a theme whose counter is a long workbench has no counter to stand beside a stove).
 */
function companionPiece(room: Room, c: Companion): PieceChoice | undefined {
  return c.pieces.find((p) => {
    const ext = room.piece(p.type, p.variant);
    return ext !== undefined && ext.wMax <= GROUPS.cellFit && ext.dMax <= GROUPS.cellFit;
  });
}

/** The companions of one kind the frame's slot takes: their cells, pieces and poses (none committed). */
function pickCompanion(
  room: Room,
  f: Frame,
  reach: ReturnType<typeof anchorReach>,
  c: Companion,
  virtual: Set<number>,
  baseHeight: XY,
): Pick[] {
  if (c.chance !== undefined && !room.rng.chance(c.chance)) return [];
  if (companionPiece(room, c) === undefined) return [];
  let cells = slotCells(f, c.slot);
  if (c.slot === "head" || c.slot === "flank") cells = room.rng.shuffle(cells);
  const want =
    c.count === "perTile"
      ? Math.min(cells.length, Math.max(1, Math.floor(reach.length / SEAT_PITCH + 1e-9)))
      : c.count;
  const out: Pick[] = [];
  for (const cell of cells) {
    if (out.length >= want) break;
    const k = cellKey(cell[0], cell[1]);
    if (virtual.has(k) || !room.free(cell[0], cell[1])) continue;
    const toward = towardAnchor(f, c.slot, cell);
    if (room.grid.edge(cell[0], cell[1], sideOf(toward)) === EDGE_WALL) continue;
    if (!room.oneHeight([cell, baseHeight])) continue;
    // the first of its pieces that fits this cell (a small crate where a barrel is too big beside a thick wall)
    for (const piece of c.pieces) {
      const pick = poseAt(room, f, reach, c, piece, cell, toward, want);
      if (pick === null) continue;
      virtual.add(k);
      out.push(pick);
      break;
    }
  }
  return out;
}

/** A companion piece posed in its cell (facing, against its walls, at its gap to the anchor); null where it does not fit. */
function poseAt(
  room: Room,
  f: Frame,
  reach: ReturnType<typeof anchorReach>,
  c: Companion,
  piece: PieceChoice,
  cell: XY,
  toward: XY,
  want: number,
): Pick | null {
  const ext = room.piece(piece.type, piece.variant);
  if (ext === undefined || ext.wMax > GROUPS.cellFit || ext.dMax > GROUPS.cellFit) return null;
  const info = featureInfo(piece.type);
  const blocking = info.blocking && !info.wallMounted;
  if (blocking && room.zone.has(cellKey(cell[0], cell[1]))) return null;
  // its facing, and its half sizes along the anchor and across it
  const face: XY = c.facing === "anchor" ? toward : c.facing === "away" ? neg(toward) : f.n;
  const turn = turnToward(face);
  const alongN = Math.abs(dot(face, f.n)) >= Math.abs(dot(face, f.u));
  const halfU = (alongN ? ext.wMax : ext.dMax) / 2;
  const halfN = (alongN ? ext.dMax : ext.wMax) / 2;
  // against the walls it has (as any wall piece), then the gap to the anchor along the slot's axis; a piece too big
  // for its cell between the walls and posts it has does not stand there
  const pushed = ext.tile ? null : touchShift(room.grid, cell, [1, 1], turn.rot, ext, room.postAt);
  if (!ext.tile && pushed === null) return null;
  let centre: XY = [cell[0] + 0.5 + (pushed?.[0] ?? 0), cell[1] + 0.5 + (pushed?.[1] ?? 0)];
  const setAlong = (axis: XY, at: number): void => {
    const d = at - dot(centre, axis);
    centre = [centre[0] + axis[0] * d, centre[1] + axis[1] * d];
  };
  if (c.slot === "front" || c.slot === "back") {
    setAlong(
      f.n,
      c.slot === "front" ? reach.n + reach.halfN + c.gap + halfN : reach.n - reach.halfN - c.gap - halfN,
    );
    // one seat at a long piece sits at its middle (a desk's chair)
    if (want === 1) setAlong(f.u, (reach.uMin + reach.uMax) / 2);
  } else if (c.slot === "head") {
    const i = dot([cell[0] - f.origin[0], cell[1] - f.origin[1]], f.u);
    setAlong(f.u, i < 0 ? reach.uMin - c.gap - halfU : reach.uMax + c.gap + halfU);
  }
  const clamp = (v: number): number => Math.max(-0.5, Math.min(0.5, Math.round(v * 100) / 100));
  const offset: XY = [clamp(centre[0] - cell[0] - 0.5), clamp(centre[1] - cell[1] - 0.5)];
  const placement: GeneratedPlacement = {
    type: piece.type,
    at: [cell[0], cell[1]],
    size: [1, 1],
    rot: turn.rot,
    rotFine: turn.rotFine,
    offset,
  };
  if (piece.variant !== undefined) placement.variant = piece.variant;
  const pose = { rotFine: turn.rotFine, offset };
  if (blocking && room.grid.blocksWayIn?.(piece.type, placement.at, placement.size, piece.variant, pose))
    return null;
  return {
    comp: c,
    piece,
    cell,
    placement,
    centre: [cell[0] + 0.5 + offset[0], cell[1] + 0.5 + offset[1]],
    blocking,
    height: ext.hMax,
  };
}

/** Does a companion in this slot stand against the wall behind the anchor's back row? */
const backedSlot = (f: Frame, slot: CompanionSlot): boolean =>
  slot === "wallBehind" || (slot === "head" && f.k === 0);

/** Commit chosen companions: placements, the cells they take, and what the later steps read of them. */
function commitPicks(room: Room, f: Frame, picks: readonly Pick[]): Placed[] {
  const placed: Placed[] = [];
  for (const p of picks) {
    if (!room.push(p.placement)) break;
    const k = cellKey(p.cell[0], p.cell[1]);
    if (p.blocking) {
      room.taken.add(k);
      room.blockCells++;
    } else room.used.add(k);
    const q: Placed = {
      type: p.piece.type,
      at: [p.cell[0], p.cell[1]],
      size: [1, 1],
      centre: p.centre,
      side: f.side,
      family: p.comp.top ?? "none",
      height: p.height,
      light: false,
      ...(p.piece.variant !== undefined ? { variant: p.piece.variant } : {}),
      ...(p.comp.light === true ? { wantsLight: true } : {}),
      // only a piece in the anchor's back row against a wall has a wall behind it
      ...(backedSlot(f, p.comp.slot) ? {} : { unbacked: true }),
    };
    room.placed.push(q);
    placed.push(q);
  }
  return placed;
}

/** A placed group: its frame, the anchor's pieces and the companions'. */
export interface PlacedGroup {
  frame: Frame;
  anchor: Placed[];
  companions: Placed[];
}

/**
 * Place a group: the anchor at the best spot its rule gives where the anchor and the companions of the minimum set all
 * fit and the way from the doors is kept; failing that, the anchor alone where it fits (a room too small for the whole
 * group still gets its anchor). The other companions go where they fit. Null when the anchor fits nowhere.
 */
export function placeGroup(
  room: Room,
  g: GroupSpec,
  family: Family,
  minimum: ReadonlySet<string>,
): PlacedGroup | null {
  const spec = placeableSpec(room, g.anchor);
  if (spec === null) return null;
  const info = featureInfo(spec.type);
  const behind = g.companions.some((c) => c.slot === "wallBehind") ? 2 : 1;
  let spots =
    g.place === "axis"
      ? axisSpots(room, spec)
      : g.place === "free"
        ? wallSpots(room, spec, g.place, behind)
        : wallSpots(room, spec, g.place, 0);
  // a free-standing anchor with no room to stand free stands against the wall it would face from
  if (spots.length === 0 && g.place === "free") spots = wallSpots(room, spec, "facingDoor", 0);
  if (spots.length === 0 && g.place === "axis") spots = wallSpots(room, spec, "farWall", 0);
  const placed = tryGroup(room, g, spec, spots, family, minimum);
  if (placed !== null || (spec.run ?? 1) !== 1) return placed;
  // a piece wider than a corner cell's clear width (the corner posts take half of it) takes a cell more along the wall
  const base = spec.size ?? info.size;
  const wide: Spec = { ...spec, size: [base[0] + 1, base[1]] };
  const place = g.place === "axis" || g.place === "free" ? "farWall" : g.place;
  return tryGroup(room, g, wide, wallSpots(room, wide, place, 0), family, minimum);
}

/** The group at the best of these spots where it fits (see placeGroup); null when it fits at none. */
function tryGroup(
  room: Room,
  g: GroupSpec,
  spec: Spec,
  all: AnchorCand[],
  family: Family,
  minimum: ReadonlySet<string>,
): PlacedGroup | null {
  const info = featureInfo(spec.type);
  const spots = all.sort((a, b) => b.score - a.score).slice(0, GROUPS.tries);
  const hasPiece = (c: Companion): boolean => companionPiece(room, c) !== undefined;
  for (const whole of [true, false])
    for (const spot of spots) {
      const f = spot.frame;
      const virtual = new Set(spot.cand.cells.map(([x, y]) => cellKey(x, y)));
      const reach = anchorReach(room, spec, spot.cand, f);
      const first = spot.cand.cells[0] as XY;
      let picks: Pick[] = [];
      let missing = false;
      for (const c of g.companions) {
        const got = pickCompanion(room, f, reach, c, virtual, first);
        if (got.length === 0 && minimum.has(c.name) && hasPiece(c)) missing = true;
        pushAll(picks, got);
      }
      if (whole && missing) continue;
      const anchorBlocks = info.blocking && !info.wallMounted ? spot.cand.cells : [];
      let after = room.keepsWay([...anchorBlocks, ...picks.filter((p) => p.blocking).map((p) => p.cell)]);
      if (after === null && !whole) {
        picks = [];
        after = room.keepsWay(anchorBlocks);
      }
      if (after === null) continue;
      const anchor = commitCand(room, spec, spot.cand, family, null);
      if (anchor === null) return null;
      // one light on the anchor per two tiles of its run (a desk lamp, candles along a bar)
      if (g.light === true)
        for (let i = 0; i < anchor.length; i += 2) (anchor[i] as Placed).wantsLight = true;
      // a free-standing anchor has no wall behind it
      if (f.k > 0) for (const q of anchor) q.unbacked = true;
      const companions = commitPicks(room, f, picks);
      room.reach = room.walk(new Set());
      return { frame: f, anchor, companions };
    }
  return null;
}

/** A wall-lining item, with the companions it brings (a bunk its chest) where they fit. */
export function placeLining(room: Room, spec: LiningSpec, family: Family): Placed[] | null {
  const placed = placeWall(room, spec, { family });
  if (placed === null) return null;
  if (spec.light === true) for (let i = 0; i < placed.length; i += 2) (placed[i] as Placed).wantsLight = true;
  const comps = spec.companions ?? [];
  if (comps.length === 0 || placed.length === 0) return placed;
  const f = wallFrame(placed, (placed[0] as Placed).side);
  const cand: Cand = {
    pieces: placed.map((q) => ({
      at: q.at,
      size: q.size,
      shift: [q.centre[0] - q.at[0] - q.size[0] / 2, q.centre[1] - q.at[1] - q.size[1] / 2],
    })),
    side: f.side,
    rot: SIDE_ROT[f.side],
    corner: false,
    cells: [],
  };
  const reach = anchorReach(room, spec, cand, f);
  const virtual = new Set<number>();
  for (const c of comps)
    for (const p of pickCompanion(room, f, reach, c, virtual, placed[0]?.at as XY)) {
      if (p.blocking) {
        const after = room.keepsWay([p.cell]);
        if (after === null) continue;
        room.reach = after;
      }
      commitPicks(room, f, [p]);
    }
  return placed;
}

/** Standing room in front of a group: `rows` rows past its face (and past the seats on it) stay clear of blockers. */
export function keepClear(room: Room, g: PlacedGroup, rows: number): XY[] {
  const f = g.frame;
  const seated = g.companions.some((q) => {
    const j = dot([q.at[0] - f.origin[0], q.at[1] - f.origin[1]], f.n);
    return j === f.k + f.D;
  });
  const j0 = f.k + f.D + (seated ? 1 : 0);
  const out: XY[] = [];
  const keep = (x: number, y: number, target = true): void => {
    if (!room.inRoom.has(cellKey(x, y)) || room.blocked(x, y)) return;
    room.zone.add(cellKey(x, y));
    if (target) out.push([x, y]);
  };
  for (let i = 0; i < f.L; i++) for (let j = j0; j < j0 + rows; j++) keep(...frameCell(f, i, j));
  // and the cells beside its open end, the side a bed is got into and a bench is reached from
  if (rows > 0) for (const i of [-1, f.L]) keep(...frameCell(f, i, f.k + f.D - 1));
  // a free-standing anchor's staff lane behind it, and its two ends, stay open (the keeper reaches the seat behind)
  for (let j = 0; j < f.k; j++) for (let i = -1; i <= f.L; i++) keep(...frameCell(f, i, j), false);
  return out;
}

/**
 * The way from the main door (the doorway nearest the room's entry) to the group: the shortest walk through free
 * cells to its standing room, kept clear of blockers and widened to two tiles where the room allows.
 */
export function keepLane(room: Room, targets: readonly XY[]): XY[] {
  if (room.thresholds.length === 0 || targets.length === 0) return [];
  const goal = new Set(targets.map(([x, y]) => cellKey(x, y)));
  let start = room.thresholds[0] as XY;
  for (const t of room.thresholds)
    if (
      Math.hypot(t[0] + 0.5 - room.entry[0], t[1] + 0.5 - room.entry[1]) <
      Math.hypot(start[0] + 0.5 - room.entry[0], start[1] + 0.5 - room.entry[1])
    )
      start = t;
  const open = (x: number, y: number): boolean => room.inRoom.has(cellKey(x, y)) && !room.blocked(x, y);
  if (!open(start[0], start[1])) return [];
  const prev = new Map<number, number>([[cellKey(start[0], start[1]), -1]]);
  const at = new Map<number, XY>([[cellKey(start[0], start[1]), start]]);
  const queue: XY[] = [start];
  let end: XY | null = null;
  for (let h = 0; h < queue.length && end === null; h++) {
    const [x, y] = queue[h] as XY;
    if (goal.has(cellKey(x, y))) end = [x, y];
    for (const s of SIDES) {
      if (room.grid.edge(x, y, s) === EDGE_WALL) continue;
      const [nx, ny] = stepSide(x, y, s);
      const k = cellKey(nx, ny);
      if (!open(nx, ny) || prev.has(k)) continue;
      prev.set(k, cellKey(x, y));
      at.set(k, [nx, ny]);
      queue.push([nx, ny]);
    }
  }
  if (end === null) return [];
  const path: XY[] = [];
  for (let k = cellKey(end[0], end[1]); k !== -1; k = prev.get(k) ?? -1) path.push(at.get(k) as XY);
  path.reverse();
  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i] as XY;
    room.zone.add(cellKey(x, y));
    // widen: the neighbour across the way nearer the middle of the room
    const next = path[Math.min(i + 1, path.length - 1)] as XY;
    const prevC = path[Math.max(i - 1, 0)] as XY;
    const dir: XY = [next[0] - prevC[0], next[1] - prevC[1]];
    const across: XY[] =
      dir[0] !== 0
        ? [
            [x, y - 1],
            [x, y + 1],
          ]
        : [
            [x - 1, y],
            [x + 1, y],
          ];
    const side = across
      .filter(([ax, ay]) => open(ax, ay) && room.grid.edge(x, y, sideOf([ax - x, ay - y])) !== EDGE_WALL)
      .sort(
        (a, b) =>
          Math.hypot(a[0] + 0.5 - room.centroid[0], a[1] + 0.5 - room.centroid[1]) -
          Math.hypot(b[0] + 0.5 - room.centroid[0], b[1] + 0.5 - room.centroid[1]),
      )[0];
    if (side) room.zone.add(cellKey(side[0], side[1]));
  }
  return path;
}

/**
 * A rug under the group: the free 2×2 (or one under the group's own pieces) nearest its middle drawn toward its face
 * (under a bed's foot half, under the seats round a table). It blocks nothing, so it may lie on the lane and the
 * standing room; it keeps off the door landings (`landings`: the room's cleared zone before the group's were added).
 */
export function rugUnder(room: Room, g: PlacedGroup, landings: ReadonlySet<number>): void {
  if (!room.has("rug")) return;
  const mine = new Set([...g.anchor, ...g.companions].map((q) => cellKey(q.at[0], q.at[1])));
  for (const q of g.anchor) for (const [x, y] of footprintCells(q.at, q.size)) mine.add(cellKey(x, y));
  const pts = [...g.anchor, ...g.companions].map((q) => q.centre);
  const mid: XY = [
    pts.reduce((a, p) => a + p[0], 0) / pts.length + g.frame.n[0] * 0.5,
    pts.reduce((a, p) => a + p[1], 0) / pts.length + g.frame.n[1] * 0.5,
  ];
  let best: XY[] = [];
  let bestD = Infinity;
  for (const [x, y] of room.cells) {
    const block = footprintCells([x, y], [2, 2]);
    const ok = block.every(([cx, cy]) => {
      const k = cellKey(cx, cy);
      return (
        room.inRoom.has(k) && !landings.has(k) && !room.used.has(k) && (mine.has(k) || room.free(cx, cy))
      );
    });
    if (!ok || room.crossesWall([x, y], [2, 2]) || !room.oneHeight(block)) continue;
    const d = Math.hypot(x + 1 - mid[0], y + 1 - mid[1]) + room.rng.next() * 0.2;
    if (d < bestD) {
      bestD = d;
      best = block;
    }
  }
  // a rug only where it lies under or against the group
  if (best.length === 0 || bestD > 2.5) return;
  if (!room.push({ type: "rug", at: best[0] as XY, size: [2, 2], rot: 0, rotFine: 0 })) return;
  for (const [x, y] of best) room.used.add(cellKey(x, y));
}

/**
 * A light on a piece's top: candles (a lantern where its top takes a lantern), at its real top height, near its middle.
 * False when the theme has no light for it, the top is uneven, or the ceiling is too low.
 */
export function lightOn(room: Room, q: Placed): boolean {
  const lamp = featureInfo(q.type).topLight === "lantern" ? "candelabra" : "candles";
  const variant = lamp === "candelabra" ? "lantern" : undefined;
  const ext = room.piece(q.type, q.variant);
  if (!ext || ext.mixed || ext.hMax - ext.h > 0.15 || !room.has(lamp, variant)) return false;
  const cx = clampTo(q.centre[0], q.at[0], q.size[0]);
  const cy = clampTo(q.centre[1], q.at[1], q.size[1]);
  const placement: GeneratedPlacement = {
    type: lamp,
    at: [cx, cy],
    size: [1, 1],
    rot: 0,
    rotFine: room.rng.int(24) * 15,
    lift: ext.hMax,
    offset: [
      Math.max(-0.5, Math.min(0.5, q.centre[0] - (cx + 0.5) + (room.rng.next() - 0.5) * 0.2)),
      Math.max(-0.5, Math.min(0.5, q.centre[1] - (cy + 0.5) + (room.rng.next() - 0.5) * 0.2)),
    ],
  };
  if (variant !== undefined) placement.variant = variant;
  if (!room.underCeiling(placement) || !room.push(placement)) return false;
  q.light = true;
  room.lights.push([cx, cy]);
  return true;
}
