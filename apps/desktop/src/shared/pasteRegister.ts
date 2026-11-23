/**
 * Whether a build's slabs can be pasted in line. TaleSpire puts the middle of a pasted slab's bounding box under the
 * cursor, so the slabs of a split build land in place only because every one carries the same two alignment pillars
 * (core compile/chunk.ts). A split build made without them (alignment "none", or no pillar asset in the palettes)
 * lands every slab centred on the cursor, piled on each other (owner, 0.3.0, a 512 × 512 map in 18 slabs).
 * Main refuses to send such a build to the add-on and the build page says so; both ask this one function.
 */
import { MARKER_ROLE } from "@slabyrinth/core";
import type { BuildRecord } from "./project";

export const OUT_OF_LINE_MESSAGE =
  "This build is split into several slabs but has no alignment pillars, so TaleSpire would put every slab's middle under the cursor and pile them on each other. Build again to add the pillars.";

/** True when the build is more than one slab and its slabs carry no alignment pillars. */
export function pastesOutOfLine(
  record: Pick<BuildRecord, "settings" | "levels" | "unmatchedAssets">,
): boolean {
  const slabs = record.levels.reduce((n, l) => n + l.chunks.length, 0);
  if (slabs <= 1) return false;
  return record.settings.markers === "none" || record.unmatchedAssets.some((u) => u.role === MARKER_ROLE);
}
