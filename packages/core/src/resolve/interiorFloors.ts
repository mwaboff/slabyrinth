/**
 * Interior floors, generator 4 (interior round, items 5-6, 2026-11-20). Pure helpers for the resolver
 * (`LevelWork.stepRoomFloors`) and the review (`floor_accent_tone`).
 *
 * A built interior reads as separate rooms when each room has its own floor and sits a step above the corridor. The
 * reference interior the owner admired has five floor families (a room is one family, the corridor another that ties
 * the complex together) and raises 13 of 16 rooms by a quarter or half tile. A plan written by the model usually names
 * the theme default floor on every room (`flagstone`), which tells the resolver nothing, so at generator 4 a room whose
 * floor is the theme default is floored from its purpose, and failing that from a rotation that differs from the rooms
 * and the corridor beside it. A floor the plan names on purpose (anything but the default) is kept.
 *
 * What a room is for comes from the one classifier (gen/roomPurpose.ts); the floors each purpose takes in each floor
 * family are in its table, and the family is the theme's interior character (resolve/themes.ts).
 */
import type { Material } from "../contracts/plan";
import type { FloorFamily, RoomPurpose } from "../contracts/resolved";
import { ROOM_PURPOSE_INFO } from "../gen/roomPurpose";

/** Floors that count as "built": a default of one of these is a candidate for being replaced by a purpose floor. */
export const BUILT_FLOORS: ReadonlySet<Material> = new Set<Material>([
  "flagstone",
  "stone_tile",
  "marble",
  "brick",
  "cobble",
  "wood_plank",
  "carpet",
]);

/**
 * The floor a room of `purpose` takes in a level of `family`: a material, "keep" for a corridor in all but name (it
 * keeps the corridor's floor and height), null when the purpose asks for none (the rotation decides).
 */
export function purposeFloor(purpose: RoomPurpose | undefined, family: FloorFamily): Material | "keep" | null {
  if (purpose === undefined) return null;
  const f = ROOM_PURPOSE_INFO[purpose].floor;
  return f === "keep" ? "keep" : f[family];
}

/** Rotation of the floors a room with no clear purpose may take in each family, in preference order. */
export const FAMILY_ROTATION: Readonly<Record<FloorFamily, readonly Material[]>> = {
  timber: ["wood_plank", "cobble"],
  stone: ["stone_tile", "cobble", "flagstone"],
};

/** Tone rank of a floor material (0 dark, 1 mid, 2 light): a guess from the pieces, not observed in game for all. */
export const MATERIAL_TONE: Readonly<Record<string, 0 | 1 | 2>> = {
  flagstone: 0,
  brick: 0,
  cobble: 0,
  dirt: 0,
  mud: 0,
  rock: 0,
  asphalt: 0,
  lava: 0,
  stone_tile: 1,
  wood_plank: 1,
  carpet: 1,
  concrete: 1,
  gravel: 1,
  bridge_wood: 1,
  grass: 1,
  swamp: 1,
  marble: 2,
  sand: 2,
  snow: 2,
  ice: 2,
};

export function toneOf(m: string | undefined): 0 | 1 | 2 | undefined {
  return m === undefined ? undefined : MATERIAL_TONE[m];
}

/**
 * The top of a dais or raised platform in a room: a top much lighter than the floor round it (marble over flagstone)
 * reads as a stark pale slab. The top takes the platform's own tier material, or the room's floor, when it is not
 * lighter than the room; returns the material to lay (the given one when it is already close in tone).
 */
export function accentTop(top: Material, room: Material | undefined, tier: Material | undefined): Material {
  const tt = toneOf(top);
  const rt = toneOf(room);
  if (tt === undefined || rt === undefined || tt <= rt) return top;
  const tierTone = toneOf(tier);
  if (tier !== undefined && tierTone !== undefined && tierTone <= rt) return tier;
  return room ?? top;
}
