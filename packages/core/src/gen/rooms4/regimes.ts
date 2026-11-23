/**
 * Lighting regimes (generator 5, switch `lightRegimes`): a room's lights follow a light level and a regime, not one
 * density for every room.
 *
 * The level (gen/lightLevels.ts, dark 0 to flooded 4) says how many accents the room carries: its kind's default
 * (gen/roomTraits.ts `lighting`) moved by the scene's level and the room's own words, a step either way for variety,
 * held in the kind's range. The regime says where they go; one per room, drawn by weight from those its kind allows,
 * a regime a near room already drew weighing less (neighbours differ):
 *   surfaces    a light on the tables, desks and nightstands in use, the floor groups' first, no wall rhythm; a bright
 *               room adds standing lights beside its groups;
 *   threshold   a pair at the main door, little else;
 *   focal       a standing light beside the room's focal group (its anchor: the bar, the hearth, the altar) with its own
 *               surfaces lit, the perimeter dim;
 *   wallRhythm  wall lights at a pitch the level sets (the old way: one option, never the default);
 *   dimStore    one light at the door.
 * Prop lights are accents (gen/lightReach.ts: even the strongest throws about 1.5 tiles): a pool marks where people are.
 * A standing light is a piece meant to stand on a floor (a brazier, a lantern stand), never a candle, and never in a
 * lane, a door's landing or a kept standing room. A lived-in room of 3 tiles or more keeps a light; an abandoned one
 * keeps its dark. A passage is lit at its doors or its junctions, not at an even pitch, and never from its floor.
 */
import type { FeatureType, Side } from "../../contracts/plan";
import { subSeed } from "../../util/hash";
import { maxOf, minOf } from "../../util/lists";
import { createPrng } from "../../util/prng";
import { featureInfo } from "../catalog";
import { SIDES, cellKey } from "../gridGeometry";
import { type SceneLight, roomNudge } from "../lightLevels";
import { givesLight, lightOfPool } from "../lightReach";
import type { GeneratedPlacement } from "../placementGrid";
import type { RoomKind } from "../roomPurpose";
import { ROOM_TRAITS, type LightLevel, type LightRegime, type RoomTraits } from "../roomTraits";
import { type PlacedGroup, lightOn } from "./groups";
import { OCCUPANCY, light, lightTarget, torchFits, wallTorch } from "./lights";
import { doorPair } from "./occupancy";
import { type Placed, type Room, clampTo, touchShift } from "./room";

/** The measures the regimes light by. */
export const REGIMES = {
  /** Light pools per floor tile at each level (dark to flooded): a room's budget of accents. */
  poolsPerTile: [0, 1 / 30, 1 / 16, 1 / 10, 1 / 6] as const,
  /** Wall lights' pitch (tiles) in a wall-rhythm room at each level. */
  wallPitch: [6, 5, 3.5, 2.5, 1.5] as const,
  /** A passage's lights per tile of its length at each level. */
  passagePerTile: [1 / 30, 1 / 16, 1 / 10, 1 / 7, 1 / 4] as const,
  /** Rooms nearer than this (tiles, centre to centre) are neighbours: a regime one drew weighs `neighbourWeight`. */
  neighbourRadius: 10,
  neighbourWeight: 0.25,
  /** A standing light stands within this many cells of the pieces it lights. */
  standReach: 2,
  /** Passage lights stand at least this far apart (tiles). */
  passageSpacing: 3,
} as const;

/** What a room drew: its light level and regime (null: abandoned, kept dark). */
export interface RoomLightPlan {
  readonly level: LightLevel;
  readonly regime: LightRegime | null;
}

/** A room already lit on the level: where it is and what it drew. */
export interface LitNeighbour {
  readonly at: readonly [number, number];
  readonly regime: LightRegime;
}

const REGIME_ORDER: readonly LightRegime[] = ["surfaces", "threshold", "focal", "wallRhythm", "dimStore"];

const clampTo04 = (n: number, lo: number, hi: number): LightLevel =>
  Math.max(lo, Math.min(hi, Math.round(n))) as LightLevel;

/**
 * A room's level and regime: a pure draw from its kind, the scene, its words and its own seed, so the furnisher and a
 * reader (a test, a proof) draw the same. `neighbours`: rooms of the level drawn before it.
 */
export function drawLighting(p: {
  readonly kind: RoomKind;
  readonly scene: SceneLight;
  readonly words: ReadonlyArray<string | undefined>;
  readonly seed: number;
  readonly at: readonly [number, number];
  readonly neighbours: readonly LitNeighbour[];
  readonly abandoned: boolean;
  /**
   * Generator 5 (characterCascade): the room's level as its character resolved it (resolve/character.ts, by
   * `roomLightLevel`); its words and the scene are then not read again here.
   */
  readonly level?: LightLevel;
}): RoomLightPlan {
  const lit = ROOM_TRAITS[p.kind].lighting;
  const rng = createPrng(subSeed(p.seed, "lighting"));
  const base = clampTo04(lit.level + p.scene.level - 2, 0, 4);
  const r = rng.next();
  const variety = r < 0.2 ? -1 : r < 0.8 ? 0 : 1;
  const level = p.level ?? clampTo04(base + roomNudge(p.words, base) + variety, lit.range[0], lit.range[1]);
  if (p.abandoned) return { level: 0, regime: null };
  const allowed = REGIME_ORDER.filter((g) => (lit.regimes[g] ?? 0) > 0);
  // a dark room has its one light at the door, where its kind allows that
  if (level === 0 && allowed.includes("dimStore")) return { level, regime: "dimStore" };
  const weights = allowed.map((g) => {
    let w = lit.regimes[g] ?? 0;
    for (const nb of p.neighbours)
      if (nb.regime === g && Math.hypot(nb.at[0] - p.at[0], nb.at[1] - p.at[1]) < REGIMES.neighbourRadius)
        w *= REGIMES.neighbourWeight;
    return w;
  });
  let x = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < allowed.length; i++) {
    x -= weights[i] as number;
    if (x < 0) return { level, regime: allowed[i] as LightRegime };
  }
  return { level, regime: allowed[allowed.length - 1] ?? "surfaces" };
}

/**
 * A room's light level (generator 5, the character resolver's room rule): its kind's default shifted by how far the
 * scope around it (`parent`) sits from moderate, a step either way for variety (about 20 % each, the same draw
 * `drawLighting` makes from the room's seed), held in the kind's range. `named`: the level the room's own words name,
 * which wins unclamped ("Dim taproom" stays dim in a bright building).
 */
export function roomLightLevel(
  kind: RoomKind,
  parent: LightLevel,
  seed: number,
  named?: LightLevel,
): LightLevel {
  if (named !== undefined) return named;
  const lit = ROOM_TRAITS[kind].lighting;
  const r = createPrng(subSeed(seed, "lighting")).next();
  const variety = r < 0.2 ? -1 : r < 0.8 ? 0 : 1;
  return clampTo04(clampTo04(lit.level + parent - 2, 0, 4) + variety, lit.range[0], lit.range[1]);
}

/** A surface people sit or work at, or a nightstand: what a regime lights first. */
const SURFACE = (q: Placed): boolean =>
  q.wantsLight === true ||
  (featureInfo(q.type).seatsAt === true &&
    featureInfo(q.type).topLight === "candle" &&
    q.type !== "bar_counter");

/** A light on a surface: a lone candle on a low one (a nightstand), else the support's own light (gen/rooms4/groups). */
function lampOn(room: Room, q: Placed): boolean {
  if (q.light) return false;
  const ext = room.piece(q.type, q.variant);
  if (ext !== undefined && ext.hMax < 0.65 && room.has("candelabra", "candle")) {
    if (ext.mixed || ext.hMax - ext.h > 0.15) return false;
    const cx = clampTo(q.centre[0], q.at[0], q.size[0]);
    const cy = clampTo(q.centre[1], q.at[1], q.size[1]);
    const placement: GeneratedPlacement = {
      type: "candelabra",
      variant: "candle",
      at: [cx, cy],
      size: [1, 1],
      rot: 0,
      rotFine: room.rng.int(24) * 15,
      lift: ext.hMax,
      offset: [
        Math.max(-0.5, Math.min(0.5, q.centre[0] - (cx + 0.5))),
        Math.max(-0.5, Math.min(0.5, q.centre[1] - (cy + 0.5))),
      ],
    };
    if (!room.underCeiling(placement) || !room.push(placement)) return false;
    q.light = true;
    room.lights.push([cx, cy]);
    return true;
  }
  return lightOn(room, q);
}

/** Light up to `k` surfaces, those of `first` (the focal and floor groups) before the rest. */
function lightSurfaces(room: Room, k: number, first: readonly Placed[]): void {
  if (k <= 0) return;
  const rest = room.placed.filter((q) => !first.includes(q));
  let done = 0;
  for (const q of [...first, ...rest]) {
    if (done >= k) return;
    if (!q.light && SURFACE(q) && lampOn(room, q)) done++;
  }
}

/** A piece meant to stand on a floor and light round it, for this room, strongest first where the level asks. */
function standingPieces(
  room: Room,
  regime: LightRegime,
  level: LightLevel,
  ctx: { noFire: boolean; scene: SceneLight; sacred: boolean },
): Array<{ type: FeatureType; variant?: string }> {
  const lamp = { type: "brazier" as const, variant: "street_lantern" };
  const fire = { type: "brazier" as const };
  const torch = { type: "torch_floor" as const };
  const out: Array<{ type: FeatureType; variant?: string }> = [];
  // a focal glow is a fire where fire belongs (a red flame at an altar in a dungeon), else the lamp; a bright room's
  // groups get the strong lamp; a threshold a weak torch
  if (regime === "focal") {
    if (ctx.scene.colour && ctx.sacred) out.push({ type: "lava_glow" });
    if (!ctx.noFire) out.push(fire);
    out.push(lamp);
  } else if (regime === "threshold") {
    if (!ctx.noFire) out.push(torch);
    out.push(lamp);
  } else {
    if (level >= 3) out.push(lamp);
    if (!ctx.noFire) out.push(fire, torch);
    out.push(lamp);
  }
  return out.filter((c) => {
    const [x, y] = room.cells[0] ?? [0, 0];
    const pool = room.grid.lightPieces?.(c.type, x, y, c.variant);
    return (
      pool !== undefined &&
      givesLight(lightOfPool(pool.names, c.type)) &&
      lightOfPool(pool.names, c.type).reach >= 0.5
    );
  });
}

/**
 * A standing light beside the pieces `near` (within `standReach` cells of them): a free cell off every lane, landing
 * and kept standing room, not beside a doorway, the way kept; against a wall where it can. False when none fits.
 */
function standBeside(
  room: Room,
  near: readonly Placed[],
  piece: { type: FeatureType; variant?: string },
): boolean {
  if (near.length === 0) return false;
  const cells: Array<[number, number]> = [];
  for (const q of near)
    for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
      for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) cells.push([x, y]);
  const mid = room.meanOf(cells);
  const R = REGIMES.standReach;
  const byDoor = (x: number, y: number): boolean =>
    room.thresholds.some(([tx, ty]) => Math.abs(tx - x) <= 1 && Math.abs(ty - y) <= 1);
  const spots = room.cells
    .filter(([x, y]) => cells.some(([cx, cy]) => Math.max(Math.abs(cx - x), Math.abs(cy - y)) <= R))
    .filter(([x, y]) => room.free(x, y) && !room.zone.has(cellKey(x, y)) && !byDoor(x, y))
    .map(([x, y]) => {
      const walls = SIDES.filter((s) => room.grid.edge(x, y, s) !== 0).length;
      const d = Math.hypot(x + 0.5 - mid[0], y + 0.5 - mid[1]);
      return { at: [x, y] as [number, number], score: d - (walls > 0 ? 0.6 : 0) + room.rng.next() * 0.2 };
    })
    .sort((a, b) => a.score - b.score);
  const [ax, ay] = room.cells[0] ?? [0, 0];
  const pool = room.grid.lightPieces?.(piece.type, ax, ay, piece.variant);
  if (pool === undefined) return false;
  for (const { at } of spots.slice(0, 8)) {
    const after = room.keepsWay([at]);
    if (after === null) continue;
    const ext = { wMax: pool.wMax, dMax: pool.dMax };
    const fit = touchShift(room.grid, at, [1, 1], 0, ext, room.postAt);
    if (fit === null) continue;
    const p: GeneratedPlacement = { type: piece.type, at, size: [1, 1], rot: 0, rotFine: 0, offset: fit };
    if (piece.variant !== undefined) p.variant = piece.variant;
    if (room.grid.blocksWayIn?.(piece.type, at, [1, 1], piece.variant, { rotFine: 0, offset: fit }) === true)
      continue;
    if (!room.push(p)) return false;
    if (featureInfo(piece.type).blocking) {
      room.taken.add(cellKey(at[0], at[1]));
      room.blockCells++;
      room.reach = after;
    } else room.used.add(cellKey(at[0], at[1]));
    room.lights.push([at[0], at[1]]);
    return true;
  }
  return false;
}

/** Wall lights at `pitch` (tiles), darkest wall first, until the room has `target` lights. */
function wallRhythm(room: Room, target: number, pitch: number): void {
  light(room, { target, radius: Infinity, torchOnly: true, floor: null, spacing: pitch });
}

/** The pieces of a placed group. */
const piecesOf = (g: PlacedGroup | null | undefined): Placed[] => (g ? [...g.anchor, ...g.companions] : []);

/** Light a room by its level and regime (see the file header). */
export function lightByRegime(
  room: Room,
  t: RoomTraits,
  plan: RoomLightPlan,
  ctx: {
    readonly noFire: boolean;
    readonly scene: SceneLight;
    readonly sacred: boolean;
    readonly focus: PlacedGroup | null;
    readonly units: readonly PlacedGroup[];
  },
): void {
  const n = room.cells.length;
  if (plan.regime === null) {
    // an abandoned room keeps its dark: one light per 50 tiles at most, none under 8
    light(room, { target: lightTarget(n, true), radius: Infinity, torchOnly: true, floor: null });
    return;
  }
  const L = plan.level;
  const budget = Math.max(1, Math.round(n * REGIMES.poolsPerTile[L]));
  const focus = piecesOf(ctx.focus);
  const units = ctx.units.flatMap((g) => piecesOf(g));
  const stand = (near: readonly Placed[]): boolean => {
    for (const p of standingPieces(room, plan.regime as LightRegime, L, ctx))
      if (standBeside(room, near, p)) return true;
    return false;
  };
  switch (plan.regime) {
    case "surfaces": {
      lightSurfaces(room, budget, [...focus, ...units]);
      if (L >= 3) for (let i = 0; i < ctx.units.length; i += 2) stand(piecesOf(ctx.units[i]));
      if (L >= 4) wallRhythm(room, room.lights.length + Math.ceil(n / 8), REGIMES.wallPitch[L]);
      break;
    }
    case "threshold": {
      doorPair(room);
      if (L >= 2) lightSurfaces(room, budget - 2, [...focus, ...units]);
      if (L >= 3) stand(focus.length > 0 ? focus : units);
      break;
    }
    case "focal": {
      const target = focus.length > 0 ? focus : piecesOf(ctx.units[0]);
      stand(target);
      lightSurfaces(room, L >= 2 ? budget : 1, target);
      // the perimeter dim: a wall light or two far apart in a brighter room
      if (L >= 3) wallRhythm(room, room.lights.length + (L >= 4 ? 2 : 1), 4);
      break;
    }
    case "wallRhythm": {
      wallRhythm(room, budget, REGIMES.wallPitch[L]);
      if (L >= 2) lightSurfaces(room, Math.ceil(budget / 2), [...focus, ...units]);
      break;
    }
    case "dimStore": {
      doorPair(room, 1);
      break;
    }
  }
  // a lived-in room of 3 tiles or more keeps a light
  const unlit = (): boolean => room.lights.length === 0;
  if (unlit() && n >= OCCUPANCY.smallestLit) {
    lightSurfaces(room, 1, focus);
    if (unlit()) light(room, { target: 1, radius: Infinity, torchOnly: true, floor: null });
  }
}

/**
 * A passage's lights (generator 5, `lightRegimes`): at its doors or at its junctions and ends (a style drawn per
 * passage, so passages are not lit alike), as many as its length and the scene's level ask, wall lights only, never
 * on its floor. A passage is lived in unless abandoned (then generator 4's dark rule).
 */
export function lightPassage(room: Room, p: { level: LightLevel; length: number; abandoned: boolean }): void {
  const n = room.cells.length;
  if (p.abandoned) {
    light(room, { target: lightTarget(n, true), radius: Infinity, torchOnly: true, floor: null });
    return;
  }
  const want = Math.max(1, Math.ceil(p.length * REGIMES.passagePerTile[p.level]));
  const style = room.rng.chance(0.5) ? "doors" : "junctions";
  // its doorways (a door off it into a room), and its junctions: where it opens into another place without a door,
  // and its two ends
  const doorCells = new Set(room.doorPairs.map(([x, y]) => cellKey(x, y)));
  const doors = room.thresholds.filter(([x, y]) => doorCells.has(cellKey(x, y)));
  const xs = room.cells.map((c) => c[0]);
  const ys = room.cells.map((c) => c[1]);
  const alongX = maxOf(xs) - minOf(xs) >= maxOf(ys) - minOf(ys);
  const lo = alongX ? minOf(xs) : minOf(ys);
  const hi = alongX ? maxOf(xs) : maxOf(ys);
  const ends = room.cells.filter(([x, y]) => (alongX ? x : y) === lo || (alongX ? x : y) === hi);
  const junctions = [...room.thresholds.filter(([x, y]) => !doorCells.has(cellKey(x, y))), ...ends];
  const marks = style === "doors" ? [...doors, ...junctions] : [...junctions, ...doors];
  const spots: Array<[number, number, Side]> = [];
  for (const [mx, my] of marks)
    for (const pair of room.wallPairs)
      if (Math.abs(pair[0] - mx) + Math.abs(pair[1] - my) <= 1 && torchFits(room, pair[0], pair[1], pair[2]))
        spots.push(pair);
  let lit = 0;
  for (const s of spots) {
    if (lit >= want) break;
    if (room.lights.some(([lx, ly]) => Math.hypot(lx - s[0], ly - s[1]) < REGIMES.passageSpacing)) continue;
    if (!torchFits(room, s[0], s[1], s[2])) continue;
    if (wallTorch(room, s) !== "lit") return;
    lit++;
  }
  if (room.lights.length === 0) light(room, { target: 1, radius: Infinity, torchOnly: true, floor: null });
}
