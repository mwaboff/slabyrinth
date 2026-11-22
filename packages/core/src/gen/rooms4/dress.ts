/**
 * Dressing a room from its purpose's recipe (generator 4): anchor, wall run, things on the furniture, shelf, rug,
 * lights. The steps are listed in `dressRoom`, in order. Generator 5 (switch `companionGroups`) furnishes from the
 * room-kind table instead (gen/rooms4/furnish.ts).
 */
import type { FeatureType } from "../../contracts/plan";
import { gridProfile, type PlacementGrid, type ScatterResult } from "../placementGrid";
import { ROOM_PURPOSE_INFO, type FurnishedPurpose, type RoomKind } from "../roomPurpose";
import { SURFACE_LOAD } from "../surfaces";
import type { SceneLight } from "../lightLevels";
import { furnishRoom } from "./furnish";
import type { RoomLightPlan } from "./regimes";
import { light, lightTarget } from "./lights";
import { FILL_GAIN, ROOM_DRESS, ROOM_RECIPES_4, pickSpec, type Spec, type Variant } from "./recipes";
import { Room } from "./room";
import { addRug, addShelf, addToppers } from "./things";
import { placeWall, seat } from "./wall";

export interface RoomDressParams {
  purpose: FurnishedPurpose;
  abandoned: boolean;
  areaIndex: number;
  areaCells: Array<[number, number]>;
  /** 1 = the recipe's own density (a dress op's density / 0.5). */
  density: number;
  seed: number;
  remaining: number;
  /** Explicit features of the plan already in the area: an anchor of one of these types is not doubled. */
  have?: readonly FeatureType[];
  /** Generator 5: what the room is furnished as (gen/roomPurpose.ts RoomClass.kind); the purpose when absent. */
  kind?: RoomKind;
  /** Generator 5 (lightRegimes): the room's light level and regime (gen/rooms4/regimes.ts drawLighting), the scene's. */
  lighting?: { plan: RoomLightPlan; scene: SceneLight };
}

/**
 * Dress a room from the recipe of its purpose. Null when it cannot (the theme has no pieces to dress with, or the room
 * has no wall), so the caller keeps its other way.
 */
export function dressRoom(grid: PlacementGrid, p: RoomDressParams): ScatterResult | null {
  if (grid.piece4 === undefined) return null;
  if (gridProfile(grid).companionGroups) return furnishRoom(grid, p, p.kind ?? p.purpose);
  const recipe = ROOM_RECIPES_4[p.purpose];
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining);
  if (room.cells.length < 4 || room.wallPairs.length === 0) return null;

  // the variant: one a sibling room of this purpose has not drawn, when there is one
  const used = grid.roomMemory?.get(p.purpose) ?? [];
  const free = recipe.variants.map((_, i) => i).filter((i) => !used.includes(i));
  const pool = free.length > 0 ? free : recipe.variants.map((_, i) => i);
  const vi = room.rng.pick(pool);
  grid.roomMemory?.set(p.purpose, [...used, vi]);
  const variant = recipe.variants[vi] as Variant;

  const n = room.cells.length;
  const maxBlock = Math.max(
    2,
    Math.round(n * recipe.fill * FILL_GAIN * Math.min(2, Math.max(0.2, p.density))),
  );
  const have = new Set(p.have ?? []);

  // 1. the anchor, on the wall away from the door
  const anchors = variant.anchors
    .map((a) => ({ a, k: a.weight * (0.4 + room.rng.next()) }))
    .sort((x, y) => y.k - x.k)
    .map((e) => e.a)
    .filter((a) => !have.has(a.type));
  for (const a of anchors) {
    const placed = placeWall(room, a, { far: true, family: variant.family });
    if (placed) {
      if (a.seats) seat(room, placed, a.seats);
      break;
    }
  }
  // 2. the wall run: furniture along the walls, corners first, the middle left clear
  let fails = 0;
  let guard = 0;
  const counts = new Map<Spec, number>();
  while (room.blockCells < maxBlock && fails < 18 && guard++ < 80) {
    const spec = pickSpec(room.rng, variant.wall);
    if (spec === null) break;
    if (spec.max !== undefined && (counts.get(spec) ?? 0) >= spec.max) {
      fails++;
      continue;
    }
    const placed = placeWall(room, spec, { family: variant.family });
    if (!placed) {
      fails++;
      continue;
    }
    counts.set(spec, (counts.get(spec) ?? 0) + 1);
    if (spec.seats) seat(room, placed, spec.seats);
  }

  // 3. things on the furniture
  for (const q of room.placed.slice()) {
    const rule = SURFACE_LOAD[q.type];
    if (!rule || q.family === "none") continue;
    const spec = [...variant.anchors, ...variant.wall].find((s) => s.type === q.type);
    if (room.rng.chance(rule.chance ?? ROOM_DRESS.topChance))
      addToppers(room, q, q.family, rule, spec?.stack === true && room.rng.chance(0.7));
  }
  if (variant.shelf === true) addShelf(room);

  // 4. a rug
  if (variant.rug === true) addRug(room);

  // 5. lights
  const floor = room.cells.length;
  light(room, {
    target: lightTarget(floor, p.abandoned),
    // an abandoned place keeps its dark pockets: one light, then no more
    radius: p.abandoned ? Infinity : ROOM_DRESS.roomLightRadius,
    torchOnly: p.abandoned,
    floor:
      floor >= ROOM_DRESS.roomFloorLightCells && !p.abandoned
        ? ROOM_PURPOSE_INFO[p.purpose].noFire
          ? "candles"
          : "brazier"
        : null,
  });
  return { placements: room.out, capped: room.capped };
}
