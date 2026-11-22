/**
 * Lights of a room or passage (gen/rooms4): how many it asks for (`lightTarget`), and the lighting rounds that put each
 * one where the room is darkest: a flame on furniture, a wall torch, a floor light. `lightArea` lights a place nobody
 * dressed.
 */
import type { FeatureType, Side } from "../../contracts/plan";
import { featureInfo } from "../catalog";
import type { GeneratedPlacement, PlacementGrid, ScatterResult } from "../placementGrid";
import { EDGE_WALL, SIDES, SIDE_ROT, cellKey } from "../gridGeometry";
import type { LightLevel } from "../roomTraits";
import { ROOM_DRESS } from "./recipes";
import { lightPassage } from "./regimes";
import { type Placed, Room, clampTo, touchShift } from "./room";

/** What `light` asks for. */
export interface LightOpts {
  /** Lights the room wants (lightTarget). */
  target: number;
  /** No cell farther than this from a light (Infinity: an abandoned place keeps its dark pockets). */
  radius: number;
  /** Wall torches and floor lights only, nothing on the furniture. */
  torchOnly: boolean;
  /** The floor light of a big room, or none. */
  floor: "brazier" | "candles" | null;
  /** Generator 5: never more lights than this in the room (its kind's high end), dark corners or not. */
  max?: number;
  /** Generator 5: a wall light never closer than this (tiles) to another light: the wall lights' rhythm. */
  spacing?: number;
}

/** One lighting step: it lit the cell, it found nowhere to, or the level's feature cap is reached (stop). */
export type LightStep = "lit" | "none" | "full";

/**
 * Lights the room until every cell is within `radius` of a light and it has `target` lights. Each round finds the
 * darkest cell and lights it with the first of these that works: a flame on furniture near it (every second light),
 * a floor light when no wall is near enough for a torch, a wall torch, and a floor light after all.
 */
export function light(room: Room, opts: LightOpts): void {
  const torch = room.has("torch_wall");
  for (let guard = 0; guard < 40; guard++) {
    if (room.out.length >= room.remaining) {
      room.capped = true;
      return;
    }
    if (opts.max !== undefined && room.lights.length >= opts.max) return;
    const dark = darkestCell(room);
    if (dark === null) return;
    if (room.lights.length >= opts.target && dark.dist <= opts.radius) return;
    const [wx, wy] = dark.at;
    let r: LightStep = "none";
    if (!opts.torchOnly && room.lights.length % 2 === 0) r = lampOnFurniture(room, wx, wy);
    if (r === "full") return;
    // the wall spot is chosen every round (its draw keeps the seeded sequence), used only if nothing is lit yet
    const wall = torch ? nearestTorchSpot(room, wx, wy, opts.spacing) : null;
    if (r === "none" && (wall === null || wall.dist > ROOM_DRESS.torchReach))
      r = floorLight(room, wx, wy, opts.floor);
    if (r === "none" && wall !== null) r = wallTorch(room, wall.at);
    if (r === "none") r = floorLight(room, wx, wy, opts.floor);
    if (r !== "lit") return;
  }
}

/** The cell farthest from every light (the one the next light must reach), and that distance. */
function darkestCell(room: Room): { at: [number, number]; dist: number } | null {
  let worst: [number, number] | null = null;
  let worstD = -1;
  for (const [x, y] of room.cells) {
    let d = Infinity;
    for (const [lx, ly] of room.lights) d = Math.min(d, Math.hypot(lx - (x + 0.5), ly - (y + 0.5)));
    d += room.rng.next() * 0.01;
    if (d > worstD) {
      worstD = d;
      worst = [x, y];
    }
  }
  return worst === null ? null : { at: worst, dist: worstD };
}

/** A candle or a small lantern on the nearest piece of furniture within reach of (wx, wy) whose top takes one. */
function lampOnFurniture(room: Room, wx: number, wy: number): LightStep {
  const near = (q: Placed): number => Math.hypot(q.centre[0] - wx, q.centre[1] - wy);
  const sups = room.placed
    .filter(
      (q) =>
        !q.light &&
        featureInfo(q.type).topLight !== undefined &&
        near(q) <= ROOM_DRESS.lampReach &&
        !room.nearPost(q.centre[0], q.centre[1]),
    )
    .sort((a, b) => near(a) - near(b));
  for (const q of sups) {
    // a candle is the candles piece, a lantern the candelabra's lantern variant
    const lamp: FeatureType = featureInfo(q.type).topLight === "candle" ? "candles" : "candelabra";
    const variant = lamp === "candelabra" ? "lantern" : undefined;
    const ext = room.piece(q.type, q.variant);
    if (!ext || ext.mixed || ext.hMax - ext.h > ROOM_DRESS.heightSpread || !room.has(lamp, variant)) continue;
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
        q.centre[0] - (cx + 0.5) + (room.rng.next() - 0.5) * 0.3,
        q.centre[1] - (cy + 0.5) + (room.rng.next() - 0.5) * 0.3,
      ],
    };
    if (variant !== undefined) placement.variant = variant;
    if (!room.underCeiling(placement)) continue;
    if (!room.push(placement)) return "full";
    q.light = true;
    room.lights.push([cx, cy]);
    return "lit";
  }
  return "none";
}

/** May a wall torch hang on side `s` of (x, y): a tall wall, nothing hung there yet, nothing tall in front. */
export function torchFits(room: Room, x: number, y: number, s: Side): boolean {
  const g = room.grid;
  if (g.edge(x, y, s) !== EDGE_WALL || (g.wallHeight?.(x, y, s) ?? 2) < ROOM_DRESS.torchWall) return false;
  if (g.wallBuilt?.(x, y, s) === false) return false;
  const spot = cellKey(x, y) * 4 + SIDES.indexOf(s);
  if (room.hung.has(spot) || room.torched.has(spot)) return false;
  if (g.occupied(x, y) && !room.taken.has(cellKey(x, y))) return false;
  const under = room.placed.find(
    (q) =>
      x >= q.at[0] &&
      x < q.at[0] + q.size[0] &&
      y >= q.at[1] &&
      y < q.at[1] + q.size[1] &&
      q.type !== "clutter",
  );
  return under === undefined || under.height <= ROOM_DRESS.tall;
}

/** The wall spot for a torch nearest (wx, wy), door zones a little less welcome; with its distance. */
function nearestTorchSpot(
  room: Room,
  wx: number,
  wy: number,
  spacing?: number,
): { at: [number, number, Side]; dist: number } | null {
  let best: [number, number, Side] | null = null;
  let bestScore = Infinity;
  let bestDist = Infinity;
  for (const [x, y, s] of room.wallPairs) {
    if (!torchFits(room, x, y, s)) continue;
    // generator 5: wall lights keep their rhythm, never closer than `spacing` to another wall light
    if (spacing !== undefined && room.wallLights.some(([lx, ly]) => Math.hypot(lx - x, ly - y) < spacing))
      continue;
    const d = Math.hypot(x - wx, y - wy);
    const sc = d + room.rng.next() * 0.6 + (room.zone.has(cellKey(x, y)) ? 0.8 : 0);
    if (sc < bestScore) {
      bestScore = sc;
      bestDist = d;
      best = [x, y, s];
    }
  }
  return best === null ? null : { at: best, dist: bestDist };
}

/** A wall torch on the given spot. */
export function wallTorch(room: Room, [x, y, s]: [number, number, Side]): LightStep {
  const turn = SIDE_ROT[s];
  if (!room.push({ type: "torch_wall", at: [x, y], size: [1, 1], rot: turn, rotFine: turn, wall: s }))
    return "full";
  room.torched.add(cellKey(x, y) * 4 + SIDES.indexOf(s));
  room.lights.push([x, y]);
  room.wallLights.push([x, y]);
  return "lit";
}

/**
 * A floor light within 3 of (wx, wy), for the middle of a big room a torch cannot reach: a brazier that keeps the way
 * clear, or, where fire does not belong (a library, a bedroom, a store), a stand of candles that blocks nothing.
 */
function floorLight(room: Room, wx: number, wy: number, kind: LightOpts["floor"]): LightStep {
  if (kind === null || !room.has(kind)) return "none";
  const near = ([x, y]: readonly [number, number]): number => Math.hypot(x - wx, y - wy);
  // generator 5: a cell from whatever the level already holds (its outline may overhang its own cells)
  const apart = ([x, y]: readonly [number, number]): boolean => {
    if (room.opts.floorLightsApart !== true) return true;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (room.grid.inBounds(x + dx, y + dy) && room.grid.occupied(x + dx, y + dy)) return false;
    return true;
  };
  const spots = room.cells
    .filter((c) => room.free(c[0], c[1]) && !room.zone.has(cellKey(c[0], c[1])) && near(c) <= 3 && apart(c))
    .sort((a, b) => near(a) - near(b));
  if (kind === "candles") {
    const at = spots[0];
    if (!at) return "none";
    const candles: GeneratedPlacement = {
      type: "candles",
      at: [at[0], at[1]],
      size: [1, 1],
      rot: 0,
      rotFine: room.rng.int(24) * 15,
    };
    if (!room.push(candles)) return "full";
    room.used.add(cellKey(at[0], at[1]));
    room.lights.push([at[0], at[1]]);
    return "lit";
  }
  for (const [x, y] of spots.slice(0, 6)) {
    const after = room.keepsWay([[x, y]]);
    if (after === null) continue;
    const bext = room.piece("brazier");
    const fit = bext && !bext.tile ? touchShift(room.grid, [x, y], [1, 1], 0, bext, room.postAt) : [0, 0];
    // generator 5: a brazier too big for the cell beside a wall stands elsewhere, never in the wall
    if (fit === null && room.opts.floorLightsApart === true) continue;
    const shift = fit ?? [0, 0];
    const bp: GeneratedPlacement = { type: "brazier", at: [x, y], size: [1, 1], rot: 0, rotFine: 0 };
    bp.offset = [shift[0] as number, shift[1] as number];
    if (!room.push(bp)) return "full";
    room.taken.add(cellKey(x, y));
    room.blockCells++;
    room.reach = after;
    room.lights.push([x, y]);
    return "lit";
  }
  return "none";
}

/** Generator 5 lights by occupancy (gen/rooms4/occupancy.ts): the smallest lit place, a passage's light pitch. */
export const OCCUPANCY = {
  /** A lived-in room or passage of this many floor tiles or more has a light of its own. */
  smallestLit: 3,
  /** A passage gets one light per this many tiles of its length (the training builds: 1 per 6-10). */
  passageEvery: 8,
  /** Wall lights stand at least this far apart (tiles; the training builds: a 1.5-3 rhythm, denser by doors). */
  wallPitch: 1.5,
} as const;

/**
 * How many lights a place asks for: one per `every` floor tiles when lived in (about 9 in a dressed room), one per 50
 * (at least one) when abandoned. The one rule for a dressed room and an area that only gets lights.
 */
export function lightTarget(floor: number, abandoned: boolean, every = 9): number {
  if (abandoned) return floor >= 8 ? Math.max(1, Math.floor(floor / 50)) : 0;
  return floor >= 6 ? Math.max(1, Math.ceil(floor / every)) : 0;
}

/**
 * Lights only: a room or passage nobody dressed (no purpose in its words, or the plan furnished it itself) still gets
 * its torches, as many as lightTarget asks (one per `every` floor tiles: 12 in a room, 18 in a passage; an abandoned
 * place one per 50). Generator 5 (`occupancy`): a lived-in place down to 3 tiles gets at least one, and a passage one
 * per 8 tiles of its length (`length`) rather than of its floor.
 */
export function lightArea(
  grid: PlacementGrid,
  p: {
    areaIndex: number;
    areaCells: Array<[number, number]>;
    seed: number;
    remaining: number;
    every: number;
    abandoned: boolean;
    /** `passageLevel` (generator 5, lightRegimes): a passage lit at its doors or junctions at the scene's level. */
    occupancy?: { length?: number; passageLevel?: LightLevel };
  },
): ScatterResult {
  const room = new Room(
    grid,
    p.areaIndex,
    p.areaCells,
    p.seed,
    p.remaining,
    p.occupancy === undefined ? {} : { floorLightsApart: true, junctionPosts: true },
  );
  const n = room.cells.length;
  const smallest = p.occupancy === undefined ? 6 : OCCUPANCY.smallestLit;
  if (n < smallest || grid.piece4 === undefined) return { placements: [], capped: false };
  const length = p.occupancy?.length;
  const passageLevel = p.occupancy?.passageLevel;
  if (length !== undefined && passageLevel !== undefined) {
    lightPassage(room, { level: passageLevel, length, abandoned: p.abandoned });
    return { placements: room.out, capped: room.capped };
  }
  const target =
    p.occupancy === undefined || p.abandoned
      ? lightTarget(n, p.abandoned, p.every)
      : length !== undefined
        ? Math.max(1, Math.ceil(length / OCCUPANCY.passageEvery))
        : Math.max(1, Math.ceil(n / p.every));
  light(room, {
    target,
    radius: p.abandoned ? Infinity : ROOM_DRESS.areaLightRadius,
    torchOnly: true,
    floor: n >= ROOM_DRESS.areaFloorLightCells && !p.abandoned ? "brazier" : null,
  });
  return { placements: room.out, capped: room.capped };
}
