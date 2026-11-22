/**
 * Cell, edge, side and footprint helpers every generator in gen/ shares. The edge and flag numbers come from the
 * resolved contract (`EDGE`, `CELL_FLAG`), so a change there reaches every generator; the side tables (step, opposite,
 * rotation) are declared here once. A generator file must not redeclare any of them (the lint rule in eslint.config.js
 * rejects `const EDGE_x = 1`-style copies).
 */
import type { Rotation, Side } from "../contracts/plan";
import { CELL_FLAG, EDGE } from "../contracts/resolved";

export const EDGE_WALL: number = EDGE.WALL;
export const EDGE_OPENING: number = EDGE.OPENING;
export const EDGE_LEDGE: number = EDGE.LEDGE;
export const EDGE_STAIR: number = EDGE.STAIR;
export const FLAG_NO_FLOOR: number = CELL_FLAG.NO_FLOOR;
export const FLAG_WATER: number = CELL_FLAG.WATER;
export const FLAG_PATH: number = CELL_FLAG.PATH;
export const FLAG_LINK: number = CELL_FLAG.LINK;
export const FLAG_FEATURE: number = CELL_FLAG.FEATURE;
export const FLAG_BRIDGE: number = CELL_FLAG.BRIDGE;
export const FLAG_STEPS: number = CELL_FLAG.STEPS;

/** The four sides, clockwise from north (the order every side loop uses). */
export const SIDES: readonly Side[] = ["N", "E", "S", "W"];

/** The neighbour cell across each side, as (dx, dy); y grows southwards. */
export const SIDE_STEP: Readonly<Record<Side, readonly [number, number]>> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

/** The side facing the given one. */
export const OPPOSITE: Readonly<Record<Side, Side>> = { N: "S", E: "W", S: "N", W: "E" };

/** From a cell on side `s` of the room into the room: the step across the opposite side. */
export const INWARD: Readonly<Record<Side, readonly [number, number]>> = {
  N: SIDE_STEP.S,
  E: SIDE_STEP.W,
  S: SIDE_STEP.N,
  W: SIDE_STEP.E,
};

/** Rotation of a piece that backs onto the wall on side `s` (a wall torch, a shelf: rot 0 backs onto north). */
export const SIDE_ROT: Readonly<Record<Side, Rotation>> = { N: 0, E: 90, S: 180, W: 270 };

/** Rotation of a piece that faces side `s` (rot 0 faces south, as the realizer turns it). */
export const FACE_ROT: Readonly<Record<Side, Rotation>> = { S: 0, W: 90, N: 180, E: 270 };

/** The four neighbours of a cell as (dx, dy), in the order the flood fills and scans iterate them (E, W, S, N). */
export const NEIGHBOURS4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The cell across side `s` of (x, y). */
export function stepSide(x: number, y: number, s: Side): [number, number] {
  const [dx, dy] = SIDE_STEP[s];
  return [x + dx, y + dy];
}

/** Anything that answers the edge kind on one side of a cell (a PlacementGrid). */
export interface EdgeReader {
  edge(x: number, y: number, side: Side): number;
}

/** The sides of (x, y) that carry a wall, in SIDES order. */
export function wallSides(grid: EdgeReader, x: number, y: number): Side[] {
  return SIDES.filter((s) => grid.edge(x, y, s) === EDGE_WALL);
}

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
