/**
 * Furnishing a room from its kind (generator 5, switch `companionGroups`), from its row of the room-kind table
 * (gen/roomTraits.ts). The steps, in order:
 *   1. the anchor group: the anchor by its rule, with its companions (gen/rooms4/groups.ts); a sibling room of the kind
 *      draws another group first; a room too small for the whole group gets its minimum set;
 *   2. standing room in front of the group and the lane from the main door to it, kept clear; generator 5 (switch
 *      floorGroups) first puts down what stands away from the walls (gen/rooms4/floor.ts), so the lane bends round it;
 *   3. a rug under the group;
 *   4. the wall lining (items with their own companions), up to the kind's fill and props per 10 tiles;
 *   5. small things on the furniture, a shelf plank (set by the kind's order: gen/rooms4/order.ts);
 *   6. lights: by the room's light level and regime (gen/rooms4/regimes.ts, switch lightRegimes); else the group's own
 *      (a nightstand's candle, the desk lamp), then the room's lighting rule (by occupancy, gen/rooms4/occupancy.ts, or
 *      generator 4's).
 * A room down to SMALLEST_FURNISHED floor cells is furnished: its doors keep a landing only, not the wide clearance of a
 * big room, so the anchor (a cot, a desk) has floor to stand on.
 */
import { cellKey } from "../gridGeometry";
import { gridProfile, type PlacementGrid, type ScatterResult } from "../placementGrid";
import { ROOM_PURPOSE_INFO, type RoomKind } from "../roomPurpose";
import type { FeatureType } from "../../contracts/plan";
import type { ResolvedCharacter } from "../../contracts/resolved";
import {
  ROOM_TRAITS,
  type Companion,
  type PieceChoice,
  type RoomOrder,
  type RoomTraits,
} from "../roomTraits";
import { SURFACE_LOAD } from "../surfaces";
import type { RoomDressParams } from "./dress";
import { keepClear, keepLane, lightOn, placeGroup, placeLining, rugUnder, type PlacedGroup } from "./groups";
import { placeFloor } from "./floor";
import { light, lightTarget } from "./lights";
import { lightByOccupancy } from "./occupancy";
import { lightByRegime } from "./regimes";
import { FILL_GAIN, ROOM_DRESS, pickSpec, type Spec } from "./recipes";
import { Room } from "./room";
import { addRug, addShelf, addToppers } from "./things";

/** Kinds whose focal light may be coloured in a scene that takes coloured light (a red flame at an altar). */
const SACRED_KINDS: ReadonlySet<RoomKind> = new Set<RoomKind>(["shrine", "crypt", "throne_room", "treasury"]);

/** The smallest room (floor cells) that is furnished: a cell of a cell row holds its sleeper and its light. */
export const SMALLEST_FURNISHED = 3;
/** A room of fewer floor cells keeps only a landing at each door (gen/rooms4/room.ts RoomOpts). */
const COMPACT_DOORS_BELOW = 9;
/** The light level (bright) from which a group whose companion carries a light keeps a cell for a standing light. */
const BEDSIDE_LEVEL = 3;

/** A candle is a light for a table top: one standing on a floor reads as a flame dropped there. */
const FLOOR_CANDLE = (type: FeatureType): boolean => type === "candelabra" || type === "candles";
/** What stands on a floor instead: a floor torch, else a brazier. */
const STANDING_LIGHT: readonly PieceChoice[] = [{ type: "torch_floor" }, { type: "brazier" }];

/**
 * Generator 5 (lightRegimes): the kind's row with every candle meant to stand on the floor (a candle stand beside an
 * altar, one in a lounge's corner) made a standing light, or left out of the lining.
 */
function standingLightsOnly(t: RoomTraits): RoomTraits {
  const comp = (c: Companion): Companion =>
    c.pieces.some((q) => FLOOR_CANDLE(q.type)) ? { ...c, pieces: STANDING_LIGHT } : c;
  return {
    ...t,
    groups: t.groups.map((g) => ({
      ...g,
      companions: g.companions.map(comp),
    })) as unknown as RoomTraits["groups"],
    lining: t.lining.filter((s) => !FLOOR_CANDLE(s.type)),
  };
}

/** Where in its kind's props per 10 tiles a room stops, by wealth (poor .. lavish): 0 the low end, 1 the high. */
export const WEALTH_PROPS = { poor: 0.25, modest: 1, wealthy: 1, lavish: 1 } as const;
const ORDERS: readonly RoomOrder[] = ["tidy", "lived", "working", "messy"];

/** The kind's props per 10 tiles a room of this character stops at. */
export function propsPer10(t: RoomTraits, c: ResolvedCharacter | undefined): number {
  const share = c === undefined ? 1 : WEALTH_PROPS[c.wealth];
  return t.props10[0] + (t.props10[1] - t.props10[0]) * share;
}

/**
 * The kind's order moved at most one step by character: messier in a ramshackle or ruined room or a weathered poor one,
 * tidier in a wealthy or lavish intact one.
 */
export function characterOrder(order: RoomOrder, c: ResolvedCharacter | undefined): RoomOrder {
  if (c === undefined) return order;
  const rich = c.wealth === "wealthy" || c.wealth === "lavish";
  const step =
    c.condition === "ramshackle" ||
    c.condition === "ruined" ||
    (c.condition === "weathered" && c.wealth === "poor")
      ? 1
      : rich && c.condition === "intact"
        ? -1
        : 0;
  return ORDERS[Math.max(0, Math.min(ORDERS.length - 1, ORDERS.indexOf(order) + step))] as RoomOrder;
}

/** The room's anchor group and its zones' groups, as placed (see furnishRoom, step 1). */
interface Anchored {
  readonly group: PlacedGroup | null;
  /** The zones' groups (a sleeping corner's bed), in order. */
  readonly zoneGroups: readonly PlacedGroup[];
  /** A zone whose kind has a group got none. */
  readonly missingZone: boolean;
  /** The standing room before each group, a lane from the main door is kept to each (step 2). */
  readonly stands: ReadonlyArray<Array<[number, number]>>;
  /** The room's cleared zone before the groups' standing room was added: the door landings a rug keeps off. */
  readonly landings: ReadonlySet<number>;
}

/** The first group of a kind's row that fits, from `first`, then the others in order, then its fallbacks (a cot). */
function firstGroup(
  room: Room,
  t: RoomTraits,
  first: number,
  have: ReadonlySet<FeatureType>,
): { group: PlacedGroup; keep: number } | null {
  const all = t.groups.map((_, i) => i).filter((i) => t.groups[i]?.fallback !== true);
  const fallbacks = t.groups.map((_, i) => i).filter((i) => t.groups[i]?.fallback === true);
  const minimum = new Set(t.minimum);
  for (const gi of [first, ...all.filter((i) => i !== first), ...fallbacks]) {
    const g = t.groups[gi];
    if (g === undefined || have.has(g.anchor.type)) continue;
    const group = placeGroup(room, g, t.family, minimum);
    if (group !== null) return { group, keep: g.keep };
  }
  return null;
}

/** A zone's row: its groups with the companions of its minimum set only (a sleeping corner's bed and its stand). */
function zoneTraits(t: RoomTraits): RoomTraits {
  const minimum = new Set(t.minimum);
  return {
    ...t,
    groups: t.groups.map((g) => ({
      ...g,
      companions: g.companions.filter((c) => minimum.has(c.name)),
    })) as unknown as RoomTraits["groups"],
  };
}

/**
 * Step 1: the room's anchor group and each zone's (its kind's first group that fits, minimum companions only), each
 * with standing room; the zones first when `zonesFirst` (a sleeping corner takes its wall, the hearth's work line fits
 * round it).
 */
function anchorGroups(
  room: Room,
  t: RoomTraits,
  first: number,
  have: ReadonlySet<FeatureType>,
  zones: readonly RoomKind[],
  zonesFirst: boolean,
): Anchored {
  const landings = new Set(room.zone);
  const stands: Array<Array<[number, number]>> = [];
  let own: ReturnType<typeof firstGroup> = null;
  const placeOwn = (): void => {
    own = firstGroup(room, t, first, have);
    // 2. standing room before it, and (below) the way from the door to it
    if (own !== null) stands.push(keepClear(room, own.group, own.keep));
  };
  if (!zonesFirst) placeOwn();
  const zoneGroups: PlacedGroup[] = [];
  let missingZone = false;
  for (const z of zones) {
    const got = firstGroup(room, zoneTraits(ROOM_TRAITS[z]), 0, have);
    if (got === null) {
      missingZone = true;
      continue;
    }
    zoneGroups.push(got.group);
    stands.push(keepClear(room, got.group, got.keep));
  }
  if (zonesFirst) placeOwn();
  const placed = own as ReturnType<typeof firstGroup>;
  return { group: placed?.group ?? null, zoneGroups, missingZone, stands, landings };
}

export function furnishRoom(grid: PlacementGrid, p: RoomDressParams, kind: RoomKind): ScatterResult | null {
  const profile = gridProfile(grid);
  const t = profile.lightRegimes ? standingLightsOnly(ROOM_TRAITS[kind]) : ROOM_TRAITS[kind];
  const roomWith = (compactDoorsBelow: number): Room =>
    new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining, {
      ...(grid.windowOn ? { windowOn: (x: number, y: number, s) => grid.windowOn?.(x, y, s) === true } : {}),
      compactDoorsBelow,
      floorLightsApart: true,
      junctionPosts: true,
      // the kind's order (generator 5, characterCascade: one step messier where it is run down, one tidier where it is
      // rich and kept; loose things only, never structure)
      ...(profile.placementOrder ? { order: characterOrder(t.order, p.character) } : {}),
      // a seat or a bed keeps a free cell beside it, so nothing placed after it boxes it in
      ...(profile.floorGroups ? { standingRoom: true } : {}),
      ...(profile.freeCounters ? { freeCounters: true } : {}),
      ...(profile.freeCounters && p.mainDoor !== undefined ? { mainDoor: p.mainDoor } : {}),
      // a bright room's bed keeps the cell at its head for its standing light (its light is part of the group)
      ...(profile.bedsideLights && (p.lighting?.plan.level ?? 0) >= BEDSIDE_LEVEL
        ? { bedsideLights: true }
        : {}),
    });
  let room = roomWith(COMPACT_DOORS_BELOW);
  if (room.cells.length < SMALLEST_FURNISHED || room.wallPairs.length === 0) return null;

  // 1. the anchor group: the table's first that no sibling room of this kind has drawn (the first room of a kind gets
  // the preferred group; once all are drawn, any), then the others in order
  const memo = `kind:${kind}`;
  const drawn = grid.roomMemory?.get(memo) ?? [];
  const all = t.groups.map((_, i) => i).filter((i) => t.groups[i]?.fallback !== true);
  const fresh = all.filter((i) => !drawn.includes(i));
  const first = fresh[0] ?? room.rng.pick(all);
  grid.roomMemory?.set(memo, [...drawn, first]);
  const have = new Set(p.have ?? []);
  // generator 5 (sleepingCorners): the zones of a one-room dwelling (a sleeping corner beside the hearth), each its
  // kind's anchor group after the room's own
  const zones = profile.sleepingCorners ? (p.zones ?? []).filter((z) => z !== kind) : [];
  // generator 5 (anchorLandings): a room whose anchor (or a zone's) finds no spot outside its doors' full clearance
  // keeps only a landing at each door, as a small room does, so a small bedroom still gets its bed; with zones, the
  // zones are also tried first. The first way that places every group wins, else the first that places the anchor.
  const ways: Array<{ compact: number; zonesFirst: boolean }> = [
    { compact: COMPACT_DOORS_BELOW, zonesFirst: false },
  ];
  if (zones.length > 0) ways.push({ compact: COMPACT_DOORS_BELOW, zonesFirst: true });
  if (profile.anchorLandings && room.cells.length >= COMPACT_DOORS_BELOW)
    for (const zonesFirst of zones.length > 0 ? [false, true] : [false])
      ways.push({ compact: Infinity, zonesFirst });
  let anchored: Anchored | null = null;
  let fallback: { room: Room; anchored: Anchored } | null = null;
  for (const [i, way] of ways.entries()) {
    const r = i === 0 ? room : roomWith(way.compact);
    const got = anchorGroups(r, t, first, have, zones, way.zonesFirst);
    if (got.group !== null && !got.missingZone) {
      room = r;
      anchored = got;
      break;
    }
    if (fallback === null || (fallback.anchored.group === null && got.group !== null))
      fallback = { room: r, anchored: got };
  }
  if (anchored === null && fallback !== null) {
    room = fallback.room;
    anchored = fallback.anchored;
  }
  if (anchored === null) return null;
  const { group, landings } = anchored;
  // 2b. generator 5 (floorGroups): what stands away from the walls (tables in the middle, rows, aisles), placed before
  // the lane to the anchor is drawn so the lane bends round them (the way stays open: keepsWay); the first unit differs
  // between rooms of the kind
  let floorUnits: PlacedGroup[] = [];
  if (profile.floorGroups && t.floor.length > 0) {
    const fmemo = `floor:${kind}`;
    const seen = grid.roomMemory?.get(fmemo) ?? [];
    grid.roomMemory?.set(fmemo, [...seen, seen.length]);
    floorUnits = placeFloor(room, t, group, { first: seen.length }).units;
  }
  for (const stand of anchored.stands) keepLane(room, stand);

  // 3. a rug under the group (or, with none, near the middle of the room)
  if (t.rug) {
    if (group !== null) rugUnder(room, group, landings);
    else addRug(room, true);
  }

  // 4. the wall lining, up to the kind's fill and its props per 10 tiles
  const n = room.cells.length;
  const maxBlock = Math.max(2, Math.round(n * t.fill * FILL_GAIN * Math.min(2, Math.max(0.2, p.density))));
  const maxProps = (propsPer10(t, p.character) * n) / 10;
  let fails = 0;
  let guard = 0;
  const counts = new Map<Spec, number>();
  while (room.blockCells < maxBlock && room.out.length < maxProps && fails < 18 && guard++ < 80) {
    const spec = pickSpec(room.rng, t.lining);
    if (spec === null) break;
    if (spec.max !== undefined && (counts.get(spec) ?? 0) >= spec.max) {
      fails++;
      continue;
    }
    if (placeLining(room, spec, t.family) === null) {
      fails++;
      continue;
    }
    counts.set(spec, (counts.get(spec) ?? 0) + 1);
  }

  // 5. things on the furniture, a shelf plank
  const specs: Spec[] = [...t.groups.map((g) => g.anchor), ...t.lining];
  for (const q of room.placed.slice()) {
    const rule = SURFACE_LOAD[q.type];
    if (!rule || q.family === "none") continue;
    const spec = specs.find((s) => s.type === q.type);
    if (room.rng.chance(rule.chance ?? ROOM_DRESS.topChance))
      addToppers(room, q, q.family, rule, spec?.stack === true && room.rng.chance(0.7));
  }
  if (t.shelf) addShelf(room);

  // 6. lights: generator 5 (lightRegimes) by the room's level and regime; else the group's own first, then the room's
  // rule; an abandoned place keeps its dark
  const noFire = ROOM_PURPOSE_INFO[t.host].noFire;
  if (profile.lightRegimes && p.lighting !== undefined) {
    lightByRegime(room, t, p.lighting.plan, {
      noFire,
      scene: p.lighting.scene,
      sacred: SACRED_KINDS.has(kind),
      focus: group,
      // (a zone's group, a sleeping corner's bed, is lit as a floor unit is)
      units: [...anchored.zoneGroups, ...floorUnits],
    });
    const keptClear = room.cells.filter(([x, y]) => room.zone.has(cellKey(x, y)));
    return { placements: room.out, capped: room.capped, keptClear };
  }
  if (!p.abandoned)
    for (const g of [...(group !== null ? [group] : []), ...anchored.zoneGroups])
      for (const q of [...g.anchor, ...g.companions]) if (q.wantsLight === true && !q.light) lightOn(room, q);
  if (profile.occupancyLights) lightByOccupancy(room, t, { abandoned: p.abandoned, noFire });
  else {
    const floor = room.cells.length;
    light(room, {
      target: lightTarget(floor, p.abandoned),
      radius: p.abandoned ? Infinity : ROOM_DRESS.roomLightRadius,
      torchOnly: p.abandoned,
      floor:
        floor >= ROOM_DRESS.roomFloorLightCells && !p.abandoned ? (noFire ? "candles" : "brazier") : null,
    });
  }
  // what was kept clear, for the detail recipes after it (ResolvedLevel.keptClear)
  const keptClear = room.cells.filter(([x, y]) => room.zone.has(cellKey(x, y)));
  return { placements: room.out, capped: room.capped, keptClear };
}
