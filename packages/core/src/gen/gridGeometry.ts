/**
 * Cell, edge and footprint helpers the placement generators share (gen/place.ts, gen/rooms4.ts). The edge and flag
 * numbers come from the resolved contract (`EDGE`, `CELL_FLAG`), so a change there reaches every generator; they were
 * redeclared by number in each file before.
 */
import type { Side } from "../contracts/plan";
import { CELL_FLAG, EDGE } from "../contracts/resolved";

export const EDGE_WALL: number = EDGE.WALL;
export const EDGE_OPENING: number = EDGE.OPENING;
export const EDGE_STAIR: number = EDGE.STAIR;
export const FLAG_NO_FLOOR: number = CELL_FLAG.NO_FLOOR;
export const FLAG_WATER: number = CELL_FLAG.WATER;
export const FLAG_PATH: number = CELL_FLAG.PATH;
export const FLAG_LINK: number = CELL_FLAG.LINK;
export const FLAG_FEATURE: number = CELL_FLAG.FEATURE;

export const SIDES: readonly Side[] = ["N", "E", "S", "W"];

/** Integer key of a cell (coordinates are within ±8192). */
export const cellKey = (x: number, y: number): number => (x + 16384) * 32768 + (y + 16384);

/** Every cell of a footprint, row by row. */
export function footprintCells(
  at: readonly [number, number],
  size: readonly [number, number],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = at[1]; y < at[1] + size[1]; y++)
    for (let x = at[0]; x < at[0] + size[0]; x++) out.push([x, y]);
  return out;
}

/** Footprint top-left for an item of unrotated size [along the wall, depth] backed onto `side` of (cx, cy). */
export function wallFootprint(
  cx: number,
  cy: number,
  side: Side,
  size: readonly [number, number],
): [number, number] {
  const d = size[1];
  switch (side) {
    case "N":
    case "W":
      return [cx, cy];
    case "S":
      return [cx, cy - d + 1];
    case "E":
      return [cx - d + 1, cy];
  }
}
