/**
 * The cells of the plan's stair and ramp runs, by level: which link a run cell belongs to, its step number and whether
 * it is the top step. Read by the link checks and by reachability (inside a run you move along it; the top step
 * arrives on the upper level one cell further in the run's direction).
 */
import type { LevelId } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import { SIDE_STEP } from "../../gen/gridGeometry";

type Link = ResolvedPlan["links"][number];

export interface RunCell {
  readonly linkId: string;
  /** Step number from the foot of the run (0 = the bottom step). */
  readonly k: number;
  /** The top step: the run arrives one cell past it. */
  readonly last: boolean;
}

export class StairRuns {
  private readonly cells = new Map<string, RunCell>();

  constructor(links: readonly Link[]) {
    for (const lk of links) {
      if (!isRun(lk)) continue;
      const ks = lk.lowerCells.map((c) => stepNumber(lk, c));
      const maxK = Math.max(...ks);
      lk.lowerCells.forEach((c, i) =>
        this.cells.set(`${lk.fromLevel}|${c[0]},${c[1]}`, {
          linkId: lk.id,
          k: ks[i] ?? 0,
          last: ks[i] === maxK,
        }),
      );
    }
  }

  /** The run cell at (x, y) on the level, if any. */
  at(levelId: LevelId, x: number, y: number): RunCell | undefined {
    return this.cells.get(`${levelId}|${x},${y}`);
  }

  /** The link's top steps (on its lower level) with the cell each arrives at on the upper level, in run-cell order. */
  arrivals(lk: Link): Array<{ top: readonly [number, number]; arrival: [number, number] }> {
    const [dx, dy] = SIDE_STEP[lk.dir];
    return lk.lowerCells
      .filter((c) => this.at(lk.fromLevel, c[0], c[1])?.last)
      .map((c) => ({ top: c, arrival: [c[0] + dx, c[1] + dy] }));
  }
}

/** Stairs and ramps climb along a run of cells; the other links stand in one place. */
export function isRun(lk: Link): boolean {
  return lk.kind === "stairs" || lk.kind === "ramp";
}

/** Steps from the foot of the run to cell c, counted along the run's direction. */
function stepNumber(lk: Link, c: readonly [number, number]): number {
  const xs = lk.lowerCells.map((q) => q[0]);
  const ys = lk.lowerCells.map((q) => q[1]);
  return lk.dir === "N"
    ? Math.max(...ys) - c[1]
    : lk.dir === "S"
      ? c[1] - Math.min(...ys)
      : lk.dir === "E"
        ? c[0] - Math.min(...xs)
        : Math.max(...xs) - c[0];
}
