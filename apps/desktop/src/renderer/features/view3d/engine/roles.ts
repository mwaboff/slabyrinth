/**
 * Placement roles as the viewer reads them: each chunk names its pieces' roles in its own table (the placement's role
 * as realize set it, View3dChunk.roles); the viewer numbers them scene-wide by core's fixed role order, so a role
 * filter is one bit mask the shader and the picker read, never a list of pieces.
 */
import { ROLE_ORDER } from "@slabyrinth/core/compile";
import type { PlacementRole } from "@slabyrinth/core/contracts/compiler";

/** Scene-wide number of a role: 1 + its place in core's role order; 0 for none or a role this viewer does not know. */
export function roleNumber(role: string): number {
  const i = (ROLE_ORDER as readonly string[]).indexOf(role);
  return i < 0 ? 0 : i + 1;
}

/** The bit mask of hidden roles (bit n: role number n hidden). */
export function roleMask(hidden: ReadonlySet<PlacementRole>): number {
  let m = 0;
  for (const r of hidden) {
    const n = roleNumber(r);
    if (n > 0) m |= 1 << n;
  }
  return m >>> 0;
}

/** Each role in plain words, for what a click shows. */
export const ROLE_WORDS: Readonly<Record<PlacementRole, string>> = {
  floor: "Floor",
  fill: "Ground fill",
  wall: "Wall",
  wall_post: "Wall post",
  opening: "Door, window or gate",
  link: "Stairs or ladder",
  feature: "Object",
  ledge: "Ledge",
  marker: "Marker",
};

/** A role's plain words (the raw name for one this viewer does not know; null for none). */
export function roleWords(role: string | null): string | null {
  if (role === null) return null;
  return (ROLE_WORDS as Readonly<Record<string, string>>)[role] ?? role;
}
