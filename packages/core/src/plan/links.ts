/**
 * Level-link arithmetic (architecture §2.6) and the entry level the links are walked from. Pure and
 * resolver-independent, so validation can check link consistency (rise, computed arrival) and WP2's resolver can
 * reuse the exact same footprints.
 */
import { BUILD_CONSTANTS } from "../contracts/plan";
import type { LevelLink, LinkKind, MapPlan, Side, Vec2 } from "../contracts/plan";

/**
 * What each link kind IS, as data: one row per kind of the plan's LINK_KINDS, read by the geometry below, validation,
 * the resolver's link pass and the playability walk instead of kind names. A new kind gets one row here.
 */
export interface LinkKindInfo {
  /**
   * The cells it takes: a straight run toward `dir`, one cell per stairRisePerCell of rise and `width` wide (stairs,
   * a ramp: the arrival is past its end); a 2×2 square (a spiral stair); one cell (the rest: the arrival is above it).
   */
  footprint: "run" | "square" | "cell";
  /**
   * What its arrival must be on the upper level: open floor (a run, a hatch you climb out of), an open cell (a ladder
   * or a spiral stair comes up through a stairwell), or nothing (a pit drop only lands below).
   */
  arrival: "floor" | "open" | "none";
  /**
   * What it cuts in the upper level's floor above its lower cells: a stairwell (the climb comes up through it), a hole
   * (a pit), or nothing (a trapdoor is a hatch in a floor that stays).
   */
  cuts: "stairwell" | "hole" | null;
  /** Can be climbed from the lower level to the upper (a pit drop only goes down). */
  climbsUp: boolean;
  /**
   * Its upper end is a hatch: the upper level has no approach to keep clear, and climbing up through it from below
   * needs something to climb (the playability check suggests a ladder).
   */
  hatch: boolean;
}

const row = (info: Partial<LinkKindInfo>): LinkKindInfo => ({
  footprint: "cell",
  arrival: "open",
  cuts: "stairwell",
  climbsUp: true,
  hatch: false,
  ...info,
});

export const LINK_KIND_INFO: Readonly<Record<LinkKind, LinkKindInfo>> = {
  stairs: row({ footprint: "run", arrival: "floor" }),
  spiral_stairs: row({ footprint: "square" }),
  ladder: row({}),
  ramp: row({ footprint: "run", arrival: "floor" }),
  trapdoor: row({ arrival: "floor", cuts: null, hatch: true }),
  pit_drop: row({ arrival: "none", cuts: "hole", climbsUp: false }),
};

/** What a link of this kind is (LINK_KIND_INFO). */
export function linkKindInfo(kind: LinkKind): LinkKindInfo {
  return LINK_KIND_INFO[kind];
}

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
  const { footprint } = LINK_KIND_INFO[link.kind];
  if (footprint === "run") {
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
  if (footprint === "square") {
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
