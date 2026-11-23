/**
 * A dead end's small set (generator 5, switch `deadEndVignettes`; technique catalogue Q4 `dead-ends-pay`): the option
 * drawn for the room (gen/complexLayout.ts DEAD_END_OPTIONS) placed as a group by the furnisher's own mechanism
 * (gen/rooms4/groups.ts placeGroup: against the far wall from the door, its companions where they fit, the way from
 * the door kept), with things on its top. No lights: the room keeps the lights it has.
 */
import type { DeadEndOption } from "../complexLayout";
import { cellKey } from "../gridGeometry";
import type { PlacementGrid, ScatterResult } from "../placementGrid";
import { SURFACE_LOAD } from "../surfaces";
import { placeGroup } from "./groups";
import { ROOM_DRESS } from "./recipes";
import { Room } from "./room";
import { addToppers } from "./things";

export interface DeadEndParams {
  readonly option: DeadEndOption;
  readonly areaIndex: number;
  readonly areaCells: Array<[number, number]>;
  readonly seed: number;
  readonly remaining: number;
}

/** The option's group in the room; null when it has none (plain) or its anchor fits nowhere. */
export function dressDeadEnd(grid: PlacementGrid, p: DeadEndParams): ScatterResult | null {
  const g = p.option.group;
  if (g === null || grid.piece4 === undefined) return null;
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining, { compactDoorsBelow: Infinity });
  if (room.cells.length === 0 || room.wallPairs.length === 0) return null;
  const placed = placeGroup(room, g, p.option.family, new Set([g.name]));
  if (placed === null) return null;
  for (const q of room.placed.slice()) {
    const rule = SURFACE_LOAD[q.type];
    if (!rule || q.family === "none") continue;
    if (room.rng.chance(rule.chance ?? ROOM_DRESS.topChance)) addToppers(room, q, q.family, rule, false);
  }
  const keptClear = room.cells.filter(([x, y]) => room.zone.has(cellKey(x, y)));
  return { placements: room.out, capped: room.capped, keptClear };
}
