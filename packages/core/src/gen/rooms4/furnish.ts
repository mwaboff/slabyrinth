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
import { ROOM_TRAITS, type Companion, type PieceChoice, type RoomTraits } from "../roomTraits";
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

export function furnishRoom(grid: PlacementGrid, p: RoomDressParams, kind: RoomKind): ScatterResult | null {
  const profile = gridProfile(grid);
  const t = profile.lightRegimes ? standingLightsOnly(ROOM_TRAITS[kind]) : ROOM_TRAITS[kind];
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining, {
    ...(grid.windowOn ? { windowOn: (x: number, y: number, s) => grid.windowOn?.(x, y, s) === true } : {}),
    compactDoorsBelow: COMPACT_DOORS_BELOW,
    floorLightsApart: true,
    junctionPosts: true,
    // the kind's order, never the building's condition
    ...(profile.placementOrder ? { order: t.order } : {}),
    // a seat or a bed keeps a free cell beside it, so nothing placed after it boxes it in
    ...(profile.floorGroups ? { standingRoom: true } : {}),
  });
  if (room.cells.length < SMALLEST_FURNISHED || room.wallPairs.length === 0) return null;

  // 1. the anchor group: the table's first that no sibling room of this kind has drawn (the first room of a kind gets
  // the preferred group; once all are drawn, any), then the others in order
  const memo = `kind:${kind}`;
  const drawn = grid.roomMemory?.get(memo) ?? [];
  const all = t.groups.map((_, i) => i).filter((i) => t.groups[i]?.fallback !== true);
  const fresh = all.filter((i) => !drawn.includes(i));
  const first = fresh[0] ?? room.rng.pick(all);
  grid.roomMemory?.set(memo, [...drawn, first]);
  const fallbacks = t.groups.map((_, i) => i).filter((i) => t.groups[i]?.fallback === true);
  const have = new Set(p.have ?? []);
  const minimum = new Set(t.minimum);
  const landings = new Set(room.zone);
  let group: PlacedGroup | null = null;
  let stand: Array<[number, number]> = [];
  for (const gi of [first, ...all.filter((i) => i !== first), ...fallbacks]) {
    const g = t.groups[gi];
    if (g === undefined || have.has(g.anchor.type)) continue;
    group = placeGroup(room, g, t.family, minimum);
    if (group !== null) {
      // 2. standing room before it, and (below) the way from the door to it
      stand = keepClear(room, group, g.keep);
      break;
    }
  }
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
  if (group !== null) keepLane(room, stand);

  // 3. a rug under the group (or, with none, near the middle of the room)
  if (t.rug) {
    if (group !== null) rugUnder(room, group, landings);
    else addRug(room);
  }

  // 4. the wall lining, up to the kind's fill and its props per 10 tiles
  const n = room.cells.length;
  const maxBlock = Math.max(2, Math.round(n * t.fill * FILL_GAIN * Math.min(2, Math.max(0.2, p.density))));
  const maxProps = (t.props10[1] * n) / 10;
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
      units: floorUnits,
    });
    const keptClear = room.cells.filter(([x, y]) => room.zone.has(cellKey(x, y)));
    return { placements: room.out, capped: room.capped, keptClear };
  }
  if (!p.abandoned && group !== null)
    for (const q of [...group.anchor, ...group.companions])
      if (q.wantsLight === true && !q.light) lightOn(room, q);
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
