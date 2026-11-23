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
import type { GroupSpec } from "../roomTraits";
import { ROOM_DRESS, type Family } from "./recipes";
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
  if (g === null) return null;
  return dressSet(grid, { ...p, group: g, family: p.option.family });
}

/**
 * A small set (one group: its anchor by its rule, its companions where they fit, things on its top) on these cells of
 * a room, no lights: a dead end's set, a cell row's aisle set (resolve/level/rooms.ts). Null when its anchor fits nowhere.
 */
export function dressSet(
  grid: PlacementGrid,
  p: Omit<DeadEndParams, "option"> & { readonly group: GroupSpec; readonly family: Family },
): ScatterResult | null {
  const g = p.group;
  if (grid.piece4 === undefined) return null;
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining, { compactDoorsBelow: Infinity });
  if (room.cells.length === 0 || room.wallPairs.length === 0) return null;
  const placed = placeGroup(room, g, p.family, new Set([g.name]));
  if (placed === null) return null;
  for (const q of room.placed.slice()) {
    const rule = SURFACE_LOAD[q.type];
    if (!rule || q.family === "none") continue;
    if (room.rng.chance(rule.chance ?? ROOM_DRESS.topChance)) addToppers(room, q, q.family, rule, false);
  }
  const keptClear = room.cells.filter(([x, y]) => room.zone.has(cellKey(x, y)));
  return { placements: room.out, capped: room.capped, keptClear };
}
