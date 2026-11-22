/**
 * Interior floors, generator 4 (switches `roomFloors`, `accentTops`). Pure helpers for the resolver
 * (resolve/level/rooms.ts `stepRoomFloors`) and the review (`floor_accent_tone`).
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
import type { Material, ThemeId } from "../contracts/plan";
import type { FloorFamily, RoomPurpose } from "../contracts/resolved";
import { ROOM_PURPOSE_INFO } from "../gen/roomPurpose";
import { TONE_RANK, type Tone } from "../palette/tones";
import type { PaletteView } from "../palette/view";
import { materialInfo } from "./materials";

/**
 * The floor a room of `purpose` takes in a level of `family`: a material, "keep" for a corridor in all but name (it
 * keeps the corridor's floor and height), null when the purpose asks for none (the rotation decides).
 */
export function purposeFloor(
  purpose: RoomPurpose | undefined,
  family: FloorFamily,
): Material | "keep" | null {
  if (purpose === undefined) return null;
  const f = ROOM_PURPOSE_INFO[purpose].floor;
  return f === "keep" ? "keep" : f[family];
}

/** Rotation of the floors a room with no clear purpose may take in each family, in preference order. */
export const FAMILY_ROTATION: Readonly<Record<FloorFamily, readonly Material[]>> = {
  timber: ["wood_plank", "cobble"],
  stone: ["stone_tile", "cobble", "flagstone"],
};

/** How pale a floor is, as a rank (0 dark, 1 mid, 2 light); undefined when nothing knows. */
export type ToneOf = (m: Material | undefined) => number | undefined;

/**
 * How pale a theme's floor of `material` is (generator 4): the tone its palette's pieces carry (PaletteView.floorTone),
 * else the material's guess (resolve/materials.ts MATERIAL_INFO `tone`), as a rank. A user palette whose flagstone is
 * pale makes flagstone pale here, so the accent rule and the review follow the pieces.
 */
export function floorTone(view: Pick<PaletteView, "floorTone">, theme: ThemeId): ToneOf {
  return (m) => {
    if (m === undefined) return undefined;
    const t: Tone | undefined = view.floorTone(theme, m) ?? materialInfo(m).tone;
    return t === undefined ? undefined : TONE_RANK[t];
  };
}

/**
 * The top of a dais or raised platform in a room: a top much lighter than the floor round it (marble over flagstone)
 * reads as a stark pale slab. The top takes the platform's own tier material, or the room's floor, when it is not
 * lighter than the room; returns the material to lay (the given one when it is already close in tone).
 */
export function accentTop(
  top: Material,
  room: Material | undefined,
  tier: Material | undefined,
  toneOf: ToneOf,
): Material {
  const tt = toneOf(top);
  const rt = toneOf(room);
  if (tt === undefined || rt === undefined || tt <= rt) return top;
  const tierTone = toneOf(tier);
  if (tier !== undefined && tierTone !== undefined && tierTone <= rt) return tier;
  return room ?? top;
}
