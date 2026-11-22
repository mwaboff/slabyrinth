/**
 * The wall placer (gen/rooms4): wall-backed spots for a piece or a run of pieces, the choice among them (far from the
 * door for an anchor; beside what stands, in corners, off the door for the rest), and seats on a piece's open side.
 */
import type { FeatureType, Rotation, Side } from "../../contracts/plan";
import { pushAll } from "../../util/lists";
import { featureInfo, rotatedSize } from "../catalog";
import type { GeneratedPlacement } from "../placementGrid";
import {
  EDGE_WALL,
  FACE_ROT,
  OPPOSITE,
  SIDES,
  SIDE_ROT,
  cellKey,
  footprintCells,
  stepSide,
  wallFootprint,
} from "../gridGeometry";
import { SURFACE_LOAD } from "../surfaces";
import type { Family, Spec } from "./recipes";
import { type Placed, type Room, touchShift } from "./room";

/** A wall-backed spot for a piece or a run: its pieces and their shifts, the wall side, turn and cells. */
export interface Cand {
  pieces: Array<{ at: [number, number]; size: [number, number]; shift: [number, number] }>;
  side: Side;
  rot: Rotation;
  corner: boolean;
  cells: Array<[number, number]>;
}

/** Candidate wall-backed positions for a run of pieces of `base` size [along, depth]. */
export function candidates(
  room: Room,
  type: FeatureType,
  base: readonly [number, number],
  run: number,
  cornerOnly: boolean,
  variant?: string,
): Cand[] {
  const out: Cand[] = [];
  const blocking = featureInfo(type).blocking;
  const ext = room.piece(type, variant);
  for (const [x, y, s] of room.wallPairs) {
    const corner = room.cornerPairs.has(cellKey(x, y));
    if (cornerOnly && !corner) continue;
    const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
    const total: [number, number] = [base[0] * run, base[1]];
    const rot = SIDE_ROT[s];
    const size = rotatedSize(total, rot);
    const at = wallFootprint(x, y, s, total);
    const cells = footprintCells(at, size);
    let ok = true;
    for (let i = 0; i < total[0] && ok; i++) {
      const ax = x + along[0] * i;
      const ay = y + along[1] * i;
      if (!room.inRoom.has(cellKey(ax, ay)) || room.grid.edge(ax, ay, s) !== EDGE_WALL) ok = false;
    }
    if (!ok) continue;
    for (const [cx, cy] of cells) {
      if (!room.free(cx, cy) || (blocking && room.zone.has(cellKey(cx, cy)))) {
        ok = false;
        break;
      }
    }
    if (!ok || !room.oneHeight(cells) || room.crossesWall(at, size)) continue;
    const pieces: Cand["pieces"] = [];
    for (let k = 0; k < run && ok; k++) {
      const sx = x + along[0] * k * base[0];
      const sy = y + along[1] * k * base[0];
      const pat = wallFootprint(sx, sy, s, base);
      const psize = rotatedSize(base, rot);
      // where it stands: against its wall(s), clear of the next cell; a piece too big for its walls is no candidate
      const shift: [number, number] | null =
        ext === undefined || ext.tile ? [0, 0] : touchShift(room.grid, pat, psize, rot, ext);
      if (shift === null) ok = false;
      else pieces.push({ at: pat, size: psize, shift });
    }
    if (!ok) continue;
    out.push({ pieces, side: s, rot, corner, cells });
  }
  return out;
}

/** Is the cell on the wall side `s` close to a placed piece (a run of furniture along the wall). */
export function nextToPlaced(room: Room, c: Cand): boolean {
  return c.cells.some(([x, y]) => SIDES.some((s) => room.taken.has(cellKey(...stepSide(x, y, s)))));
}

/** Choose and place one wall item of the spec; returns the pieces placed or null. */
export function placeWall(room: Room, spec: Spec, opts: { far?: boolean; family: Family }): Placed[] | null {
  // a support that carries things is its stacking variant where the load table names one (the small crate: the large
  // crate's top is a taller piece than the height we lift to)
  const stackVariant = SURFACE_LOAD[spec.type]?.stackVariant;
  if (
    stackVariant !== undefined &&
    spec.variant === undefined &&
    spec.top !== "none" &&
    room.has(spec.type, stackVariant)
  )
    spec = { ...spec, variant: stackVariant };
  const info = featureInfo(spec.type);
  // a preferred variant the theme lacks (a straw bed, a small crate) gives way to the theme's own; stacking needs it
  if (spec.variant !== undefined && !room.has(spec.type, spec.variant)) {
    const alt: Spec = { ...spec, stack: false };
    delete alt.variant;
    return placeWall(room, alt, opts);
  }
  if (!room.has(spec.type, spec.variant)) return null;
  const base = spec.size ?? info.size;
  const run = spec.run ?? 1;
  const all = candidates(room, spec.type, base, run, spec.corner === true, spec.variant);
  if (all.length === 0) return null;
  const scored = all.map((c) => {
    const mid = room.meanOf(c.cells);
    const dEntry = Math.hypot(mid[0] - room.entry[0], mid[1] - room.entry[1]);
    let score = room.rng.next();
    if (opts.far === true) score += dEntry * 0.35;
    else {
      if (nextToPlaced(room, c)) score += 0.35;
      if (c.corner) score += spec.corner === true ? 0.6 : 0.25;
      if (dEntry < 3) score -= 0.3;
    }
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const pool = opts.far === true ? scored.slice(0, 4) : scored.slice(0, 7);
  for (const { c } of room.rng.shuffle(pool)) {
    const blocking = info.blocking && !info.wallMounted;
    let after: Set<number> | null = null;
    if (blocking) {
      after = room.keepsWay(c.cells);
      if (after === null) continue;
    }
    return commitCand(room, spec, c, opts.family, after);
  }
  return null;
}

/** Place the pieces of a chosen spot and mark its cells taken (blocking) or used. */
export function commitCand(
  room: Room,
  spec: Spec,
  c: Cand,
  family: Family,
  after: Set<number> | null,
): Placed[] | null {
  const info = featureInfo(spec.type);
  const placed: Placed[] = [];
  const ext = room.piece(spec.type, spec.variant);
  const variant = spec.variant;
  for (const pc of c.pieces) {
    // a tile (a bar counter block) stands exactly on its cell; a prop is pushed against the wall it backs onto
    const shift = pc.shift;
    const g: GeneratedPlacement = {
      type: spec.type,
      at: pc.at,
      size: pc.size,
      rot: c.rot,
      rotFine: c.rot,
    };
    // always explicit: the resolver's own 0.45 push off a wall must not apply to a piece placed exactly
    g.offset = shift;
    if (variant !== undefined) g.variant = variant;
    if (!room.push(g)) break;
    // a role whose variants are some tiles and some props has no one top height or centre: nothing stands on it
    const fam =
      ext?.mixed === true
        ? "none"
        : spec.top === undefined
          ? (SURFACE_LOAD[spec.type]?.family ?? family)
          : spec.top;
    placed.push({
      type: spec.type,
      at: pc.at,
      size: pc.size,
      centre: [pc.at[0] + pc.size[0] / 2 + shift[0], pc.at[1] + pc.size[1] / 2 + shift[1]],
      side: c.side,
      family: fam,
      height: ext?.hMax ?? 1,
      light: false,
      ...(variant !== undefined ? { variant } : {}),
    });
  }
  if (placed.length === 0) return null;
  for (const [x, y] of c.cells) {
    if (info.blocking && !info.wallMounted) {
      room.taken.add(cellKey(x, y));
      room.blockCells++;
    } else room.used.add(cellKey(x, y));
  }
  if (after) room.reach = after;
  pushAll(room.placed, placed);
  return placed;
}

/** Seats for a run of pieces: `seat.n` in all, spread over them. */
export function seat(
  room: Room,
  pieces: readonly Placed[],
  seatSpec: { type: FeatureType; n: number },
): void {
  const each = Math.max(1, Math.ceil(seatSpec.n / Math.max(1, pieces.length)));
  for (const pl of pieces) addSeats(room, pl, { type: seatSpec.type, n: each });
}

/** Seats on the open side of a piece, facing it. */
export function addSeats(room: Room, p: Placed, seatSpec: { type: FeatureType; n: number }): void {
  if (!room.has(seatSpec.type)) return;
  const open = OPPOSITE[p.side];
  const cells: Array<[number, number]> = [];
  const [x0, y0] = p.at;
  const [w, h] = p.size;
  if (open === "S") for (let x = x0; x < x0 + w; x++) cells.push([x, y0 + h]);
  else if (open === "N") for (let x = x0; x < x0 + w; x++) cells.push([x, y0 - 1]);
  else if (open === "E") for (let y = y0; y < y0 + h; y++) cells.push([x0 + w, y]);
  else for (let y = y0; y < y0 + h; y++) cells.push([x0 - 1, y]);
  let placed = 0;
  for (const [x, y] of room.rng.shuffle(cells)) {
    if (placed >= seatSpec.n) break;
    if (!room.free(x, y) || room.zone.has(cellKey(x, y))) continue;
    if (room.grid.edge(x, y, p.side) === EDGE_WALL) continue;
    const after = room.keepsWay([[x, y]]);
    if (after === null) continue;
    const turn = FACE_ROT[p.side];
    const g: GeneratedPlacement = { type: seatSpec.type, at: [x, y], size: [1, 1], rot: turn, rotFine: turn };
    const sext = room.piece(seatSpec.type);
    const shift = sext && !sext.tile ? (touchShift(room.grid, [x, y], [1, 1], turn, sext) ?? [0, 0]) : [0, 0];
    g.offset = [shift[0] as number, shift[1] as number];
    if (!room.push(g)) return;
    room.taken.add(cellKey(x, y));
    room.blockCells++;
    room.reach = after;
    room.placed.push({
      type: seatSpec.type,
      at: [x, y],
      size: [1, 1],
      centre: [x + 0.5 + (shift[0] as number), y + 0.5 + (shift[1] as number)],
      side: p.side,
      family: "none",
      height: room.piece(seatSpec.type)?.h ?? 0.5,
      light: false,
    });
    placed++;
  }
}
