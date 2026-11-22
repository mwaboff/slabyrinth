/**
 * The model's line about the map size setting, added to the app's own context message (the released prompt and tool
 * texts are frozen and say nothing about it): only for an experimental tier, and once more when the setting changes.
 */
import { sizeLimits, type SizeTierId } from "@slabyrinth/core/plan";

export const SIZE_TIER_PREFIX = "Map size setting:";

const n = (v: number): string => v.toLocaleString("en-US");

export function sizeTierText(id: SizeTierId): string {
  const l = sizeLimits(id);
  return l.experimental
    ? `${SIZE_TIER_PREFIX} larger maps (experimental), at most ${n(l.levelSide)} cells a side and ${n(l.totalCells)} cells over all levels together; big maps are slow to check and build, so keep bounds to what the map uses.`
    : `${SIZE_TIER_PREFIX} standard, at most ${n(l.levelSide)} cells a side and ${n(l.totalCells)} cells over all levels together.`;
}

/** The session-start text with the size line after it, when there is one. */
export function withSizeTier(text: string, line: string | null): string {
  return line === null ? text : `${text}\n${line}`;
}
