/**
 * Whether a build's slabs can be pasted in line. TaleSpire puts the middle of a pasted slab's bounding box under the
 * cursor, so the slabs of a split build land in place only because every one carries the same two alignment pillars
 * (core compile/chunk.ts). A split build made without them (alignment "none", or no pillar asset in the palettes)
 * lands every slab centred on the cursor, piled on each other (owner, 0.3.0, a 512 × 512 map in 18 slabs).
 * Main refuses to send such a build to the add-on and the build page says so; both ask this one function.
 */
import { MARKER_ROLE } from "@slabyrinth/core";
import type { BuildRecord } from "./project";

type PasteFacts = Pick<BuildRecord, "settings" | "levels" | "unmatchedAssets">;

/**
 * Why a split build's slabs carry no alignment pillars: "noPiece" when the palettes have no pillar piece (the build
 * names the role among its unmatched assets: building again cannot add one), else "turnedOff" (the build was made
 * without them); null when the build is one slab or carries them.
 */
export function outOfLineCause(record: PasteFacts): "noPiece" | "turnedOff" | null {
  const slabs = record.levels.reduce((n, l) => n + l.chunks.length, 0);
  if (slabs <= 1) return null;
  if (record.unmatchedAssets.some((u) => u.role === MARKER_ROLE)) return "noPiece";
  return record.settings.markers === "none" ? "turnedOff" : null;
}

/** True when the build is more than one slab and its slabs carry no alignment pillars. */
export function pastesOutOfLine(record: PasteFacts): boolean {
  return outOfLineCause(record) !== null;
}

/** What the build page and the add-on refusal say, by cause. */
export const OUT_OF_LINE_MESSAGES = {
  turnedOff:
    "This build is split into several slabs but has no alignment pillars, so TaleSpire would put every slab's middle under the cursor and pile them on each other. Build again to add the pillars.",
  noPiece:
    "This build is split into several slabs, but your palettes have no alignment pillar piece, so the slabs carry none and TaleSpire would put every slab's middle under the cursor and pile them on each other. Building again will not fix it: add a palette that has a pillar piece (role marker.alignment) and build again, or paste the slabs one at a time and move each into place.",
} as const;

/** The message for a build that pastes out of line ("" when it does not). */
export function outOfLineMessage(record: PasteFacts): string {
  const cause = outOfLineCause(record);
  return cause === null ? "" : OUT_OF_LINE_MESSAGES[cause];
}
