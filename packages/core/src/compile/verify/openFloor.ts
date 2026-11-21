/**
 * Preview fidelity of open floor: realized solids that intrude into cells the 2D map shows as open floor.
 *
 * Emits `verify_cell_obstructed` (warning), one per (asset, element) with the first cell and the count, per level.
 * Returns the obstructed cells (`ObstructedCells`), which the link checks and reachability read.
 */
import { CELL_FLAG } from "../../contracts/resolved";
import type { LevelId } from "../../contracts/plan";
import type { LevelGrid } from "../../resolve/levelGrid";
import type { VerifyCtx } from "./context";
import type { Solid, SolidIndex } from "./grid";
import { HEAD, MIN_FREE_SPAN, STEP } from "./limits";
import { elementRef, fmt, solidLabel } from "./words";

/** A placed piece that is part of the build's structure (not a prop or a marker). */
const structural = (s: Solid): boolean => s.role !== "feature" && s.role !== "marker";

/** Open floor cells a structural piece fills between a step and head height above the floor, in level and row order. */
export class ObstructedCells {
  private readonly byCell = new Map<string, ObstructedCell>();

  add(levelId: LevelId, x: number, y: number, solids: Solid[]): void {
    this.byCell.set(`${levelId}|${x},${y}`, { levelId, cell: [x, y], solids });
  }

  /** The pieces filling (x, y) on the level, undefined when it is free. */
  at(levelId: LevelId, x: number, y: number): readonly Solid[] | undefined {
    return this.byCell.get(`${levelId}|${x},${y}`)?.solids;
  }

  /** Every obstructed cell, in the order found. */
  list(): Iterable<ObstructedCell> {
    return this.byCell.values();
  }
}

export interface ObstructedCell {
  readonly levelId: LevelId;
  readonly cell: [number, number];
  readonly solids: readonly Solid[];
}

export function checkOpenFloor(ctx: VerifyCtx, solids: SolidIndex): ObstructedCells {
  const obstructed = new ObstructedCells();
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    if (!g) continue;
    const agg = new Map<string, { n: number; first: [number, number]; s: Solid }>();
    for (let ly = 0; ly < g.h; ly++)
      for (let lx = 0; lx < g.w; lx++) {
        const x = L.bounds.x + lx;
        const y = L.bounds.y + ly;
        const c = g.cell(x, y);
        if (!c.floor || (c.flags & (CELL_FLAG.FEATURE | CELL_FLAG.LINK | CELL_FLAG.STEPS)) !== 0) continue;
        const pc = freeCentre(g, x, y);
        if (!pc) continue;
        const p = solids.toWorld(pc[0], pc[1]);
        const top = g.top(x, y);
        const hits = solids.at(p.x, p.z, top + STEP, top + HEAD).filter(structural);
        if (!hits.length) continue;
        obstructed.add(L.id, x, y, hits);
        const s = hits[0] as Solid;
        const k = `${s.name}|${s.p.source.elementId ?? ""}`;
        const a = agg.get(k);
        if (a) a.n++;
        else agg.set(k, { n: 1, first: [x, y], s });
      }
    for (const a of agg.values())
      ctx.report.add({
        severity: "warning",
        code: "verify_cell_obstructed",
        levelId: L.id,
        cell: a.first,
        count: a.n,
        ...elementRef(a.s.p.source.elementId),
        assets: [a.s.name],
        message: `${solidLabel(a.s)} fills ${a.n > 1 ? `${a.n} cells` : "a cell"} the 2D map shows as open floor (first at ${fmt(a.first)} on level ${L.id}).`,
        hint: `Keep ${fmt(a.first)} free in the plan (mark it as part of the obstacle), or move the element that places ${a.s.name}.`,
      });
  }
  return obstructed;
}

/**
 * The centre (plan coordinates) of the part of cell (x, y) no wall or door strip stands in, or null when too little is
 * left to stand in.
 */
function freeCentre(g: LevelGrid, x: number, y: number): [number, number] | null {
  let x0 = x,
    x1 = x + 1,
    y0 = y,
    y1 = y + 1;
  if (g.hostedOn(x, y, "W")) x0 += 0.5;
  if (g.hostedOn(x, y, "E")) x1 -= 0.5;
  if (g.hostedOn(x, y, "N")) y0 += 0.5;
  if (g.hostedOn(x, y, "S")) y1 -= 0.5;
  if (x1 - x0 < MIN_FREE_SPAN || y1 - y0 < MIN_FREE_SPAN) return null;
  // an outer corner of a building diagonal to this cell (walls on both neighbours, hosted on this side) carries a
  // corner post in this cell's corner quarter: when that quarter is all that is left free, the cell is not open floor
  const quarter = (qx: number, qy: number): boolean =>
    x0 >= qx - 0.01 && x1 <= qx + 0.51 && y0 >= qy - 0.01 && y1 <= qy + 0.51;
  if (
    (quarter(x + 0.5, y + 0.5) && g.hostedOn(x + 1, y, "S") && g.hostedOn(x, y + 1, "E")) ||
    (quarter(x, y + 0.5) && g.hostedOn(x - 1, y, "S") && g.hostedOn(x, y + 1, "W")) ||
    (quarter(x + 0.5, y) && g.hostedOn(x + 1, y, "N") && g.hostedOn(x, y - 1, "E")) ||
    (quarter(x, y) && g.hostedOn(x - 1, y, "N") && g.hostedOn(x, y - 1, "W"))
  )
    return null;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
