/**
 * Reading `PlacementSet.placed` (contracts/compiler.ts): what realize knows about each placement it made. The set
 * carries the map (realize writes it through `RealizeLevel.emit` and `rebox`; verify moves a nudged prop's box), so
 * every reader asks the set it was given. A placement without an entry (a set built elsewhere, a copy added after
 * realize) reads as its point and its uuid.
 */
import type { Box3, Placement, PlacementSet } from "../contracts/compiler";

/** The placement's world box, or its point when the set does not know it. */
export function placedBox(set: Pick<PlacementSet, "placed">, p: Placement): Box3 {
  return set.placed?.get(p)?.box ?? { min: { x: p.x, y: p.y, z: p.z }, max: { x: p.x, y: p.y, z: p.z } };
}

/** The placement's asset name, or its uuid when the set does not know it. */
export function placedName(set: Pick<PlacementSet, "placed">, p: Placement): string {
  return set.placed?.get(p)?.name ?? p.asset;
}
