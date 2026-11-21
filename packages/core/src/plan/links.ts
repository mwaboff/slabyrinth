/**
 * Level-link arithmetic (architecture §2.6) and the entry level the links are walked from. Pure and
 * resolver-independent, so validation can check link consistency (rise, computed arrival) and WP2's resolver can
 * reuse the exact same footprints.
 */
import { BUILD_CONSTANTS } from "../contracts/plan";
import type { LevelLink, MapPlan, Side, Vec2 } from "../contracts/plan";

/** Entry level id: plan.entryLevel, else the level with the smallest |elevation| (ties: plan order). */
export function entryLevelId(plan: MapPlan): string | undefined {
  if (plan.entryLevel && plan.levels.some((l) => l.id === plan.entryLevel)) return plan.entryLevel;
  let best: { id: string; e: number } | undefined;
  for (const l of plan.levels)
    if (!best || Math.abs(l.elevation) < best.e) best = { id: l.id, e: Math.abs(l.elevation) };
  return best?.id;
}

/** Unit step per side in plan space (y grows south). */
export const SIDE_STEP: Record<Side, Vec2> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export interface LinkGeometry {
  /** elevation(to) − elevation(from); must be > 0. */
  rise: number;
  /** Run length in cells (stairs/ramp: ceil(rise / stairRisePerCell); others 1, spiral 2). */
  length: number;
  /** Cells occupied on the LOWER level (from.level). */
  lowerCells: Vec2[];
  /** Cells on the UPPER level vertically above the lower footprint (stairwell / hole / hatch). */
  upperCells: Vec2[];
  /** Computed `to.at`: first cell of the arrival footprint on the upper level. */
  arrival: Vec2;
  /** All arrival cells on the upper level (width-wide for stairs/ramp, 2×2 for spiral stairs). */
  arrivalCells: Vec2[];
}

/**
 * Computes the footprint of a link given the two level elevations.
 *  - stairs/ramp: lower cells = from.at + k·dir (k = 0..L−1), `width` wide (extends east for N/S runs, south for
 *    E/W runs); arrival = from.at + L·dir.
 *  - spiral_stairs: 2×2 at from.at; arrival is the same footprint.
 *  - ladder, trapdoor, pit_drop: one cell; arrival is the same cell.
 */
export function linkGeometry(link: LevelLink, fromElevation: number, toElevation: number): LinkGeometry {
  const rise = toElevation - fromElevation;
  const [fx, fy] = link.from.at;
  const width = link.width ?? 1;
  if (link.kind === "stairs" || link.kind === "ramp") {
    const dir = link.dir ?? "N";
    const [sx, sy] = SIDE_STEP[dir];
    const across: Vec2 = dir === "N" || dir === "S" ? [1, 0] : [0, 1];
    const length = Math.max(1, Math.ceil(rise / BUILD_CONSTANTS.stairRisePerCell));
    const strip = (x: number, y: number): Vec2[] =>
      Array.from({ length: width }, (_, w): Vec2 => [x + across[0] * w, y + across[1] * w]);
    const lowerCells: Vec2[] = [];
    for (let k = 0; k < length; k++) lowerCells.push(...strip(fx + sx * k, fy + sy * k));
    const arrival: Vec2 = [fx + sx * length, fy + sy * length];
    return {
      rise,
      length,
      lowerCells,
      upperCells: lowerCells.slice(),
      arrival,
      arrivalCells: strip(arrival[0], arrival[1]),
    };
  }
  if (link.kind === "spiral_stairs") {
    const cells: Vec2[] = [
      [fx, fy],
      [fx + 1, fy],
      [fx, fy + 1],
      [fx + 1, fy + 1],
    ];
    return {
      rise,
      length: 2,
      lowerCells: cells,
      upperCells: cells.slice(),
      arrival: [fx, fy],
      arrivalCells: cells.slice(),
    };
  }
  const cell: Vec2 = [fx, fy];
  return { rise, length: 1, lowerCells: [cell], upperCells: [cell], arrival: cell, arrivalCells: [cell] };
}

/**
 * Every cell a level's links occupy on that level, from `linkGeometry`: the lower run of the links that start here, and
 * the stairwell above it plus the arrival cells of the links that end here. A run climbs from its LOWER end, so the
 * cells are right whichever end of the link this level holds, and the run is as long as the rise needs (not a fixed
 * guess). Anything that must keep clear of a stair or ladder (floor shaping, ragged outlines, room steps) asks here.
 */
export function linkCellsOnLevel(plan: Pick<MapPlan, "levels" | "links">, levelId: string): Vec2[] {
  const out: Vec2[] = [];
  for (const link of plan.links) {
    const lo = plan.levels.find((l) => l.id === link.from.level);
    const up = plan.levels.find((l) => l.id === link.to.level);
    if (!lo || !up) continue;
    const geo = linkGeometry(link, lo.elevation, up.elevation);
    if (lo.id === levelId) out.push(...geo.lowerCells);
    if (up.id === levelId) out.push(...geo.upperCells, ...geo.arrivalCells);
  }
  return out;
}
