/**
 * What every step of buildDisplayList reads: the level, the options, the plan-wide context and a few questions about
 * a cell (local index i = ly * w + lx). Read-only; each step returns its items and buildDisplayList appends them.
 */
import type { DisplayContext, DisplayOptions, ResolvedLevel } from "../../contracts/resolved";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { cellIndex } from "../../resolve/levelGrid";

/** The ground under a broken bridge cell: shown instead of a black hole (lava, the chasm floor). */
export interface UnderBroken {
  material: string | null;
  /** Height in quarter tiles, like ResolvedLevel.cells.height. */
  height: number;
}

export interface DisplayCtx {
  level: ResolvedLevel;
  opts: DisplayOptions;
  plan: DisplayContext;
  /** Level bounds (global cell coords of the top-left cell, size in cells). */
  bx: number;
  by: number;
  w: number;
  h: number;
  /** Broken bridge cells by local index. */
  underBroken: ReadonlyMap<number, UnderBroken>;
  /** Open cell with a floor. */
  isFloor: (i: number) => boolean;
  /** Local cell index, -1 outside the level. */
  cellAt: (lx: number, ly: number) => number;
  /** Floor height in quarter tiles, the ground below for a broken bridge cell. */
  groundHeight: (i: number) => number;
}

export function createDisplayCtx(
  level: ResolvedLevel,
  opts: DisplayOptions,
  plan: DisplayContext,
): DisplayCtx {
  const { x: bx, y: by, w, h } = level.bounds;
  const st = level.cells.state;
  const fl = level.cells.flags;
  const underBroken = brokenBridgeGround(level);
  return {
    level,
    opts,
    plan,
    bx,
    by,
    w,
    h,
    underBroken,
    isFloor: (i) => st[i] === CELL.OPEN && ((fl[i] as number) & CELL_FLAG.NO_FLOOR) === 0,
    cellAt: (lx, ly) => cellIndex(level.bounds, lx, ly),
    groundHeight: (i) => {
      const ub = underBroken.get(i);
      return ub ? ub.height : (level.cells.height[i] as number);
    },
  };
}

/** Broken bridge cells show the ground below them (lava, the chasm floor), not a black hole. */
function brokenBridgeGround(level: ResolvedLevel): Map<number, UnderBroken> {
  const { x: bx, y: by, w } = level.bounds;
  const underBroken = new Map<number, UnderBroken>();
  for (const b of level.bridges ?? []) {
    const brokenSet = new Set(b.broken.map(([x, y]) => `${x},${y}`));
    b.cells.forEach(([x, y], j) => {
      if (!brokenSet.has(`${x},${y}`)) return;
      underBroken.set((y - by) * w + (x - bx), {
        material: b.underMaterial[j] ?? null,
        height: b.under[j] ?? 0,
      });
    });
  }
  return underBroken;
}
