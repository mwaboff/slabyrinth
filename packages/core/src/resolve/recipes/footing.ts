/**
 * Where a loose piece stands on the ground (the detail recipes: layered ground, wall-foot growth, breach rubble, the
 * threshold pairs, a lean-to's posts), in one place: its centre and its four footprint corners (turned with it) each on
 * a floor cell at one height, clear of the cells a piece never reaches onto (KEEP_OFF: water, a path, a stair, a link).
 * A recipe that knows more says so:
 *   top     the height the ground must be at (a cluster's ground), else the centre cell's;
 *   within  the cells the piece must stay on (a place's own cells);
 *   lean    a corner may reach up to `reach` over a path's edge (the corner pulled that far back toward the centre is off
 *           the path), never onto a cell `never` names (a lane, a door's apron).
 */
import type { ArrangePiece } from "../../arrange";
import { CELL_FLAG } from "../../contracts/resolved";
import { turnedHalfExtents } from "../../util/turn";
import type { RecipeCtx } from "./types";

/** Cells no loose piece reaches onto: water, a path, a stair, a link. */
export const KEEP_OFF = CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.STEPS | CELL_FLAG.LINK;
/** Cells a piece flanking a path may stand on the edge of (a path is ground; water, stairs and links are not). */
export const KEEP_OFF_BESIDE_PATH = KEEP_OFF & ~CELL_FLAG.PATH;

/** Two floor tops within this are one height. */
const SAME_TOP = 0.01;

export interface FootingOpts {
  readonly keepOff?: number;
  readonly top?: number;
  readonly within?: (cx: number, cy: number) => boolean;
  readonly lean?: { readonly reach: number; readonly never: (cx: number, cy: number) => boolean };
}

/** The floor top under the plan point (qx, qy), or null when it has no floor, is off `within` or flagged `keepOff`. */
export function groundAt(
  ctx: RecipeCtx,
  qx: number,
  qy: number,
  keepOff: number = KEEP_OFF,
  within?: (cx: number, cy: number) => boolean,
): number | null {
  const g = ctx.anchors.grid;
  const cx = Math.floor(qx);
  const cy = Math.floor(qy);
  if (!g.cell(cx, cy).floor || (within !== undefined && !within(cx, cy))) return null;
  if (((ctx.level.cells.flags[g.index(cx, cy)] ?? 0) & keepOff) !== 0) return null;
  return g.top(cx, cy);
}

/** The points a piece at plan point (px, py), turned `yaw` (degrees), is sampled at: its centre, then its corners. */
export function footprintPoints(
  px: number,
  py: number,
  p: ArrangePiece,
  yaw: number,
): ReadonlyArray<readonly [number, number]> {
  const h = turnedHalfExtents(p.variant.geom.size.x, p.variant.geom.size.z, yaw);
  return [
    [px, py],
    [px - h.x, py - h.z],
    [px + h.x, py - h.z],
    [px - h.x, py + h.z],
    [px + h.x, py + h.z],
  ];
}

/** Is the plan point (qx, qy) on ground at `top` (see groundAt)? */
export function standsAt(
  ctx: RecipeCtx,
  qx: number,
  qy: number,
  top: number,
  keepOff: number = KEEP_OFF,
  within?: (cx: number, cy: number) => boolean,
): boolean {
  const t = groundAt(ctx, qx, qy, keepOff, within);
  return t !== null && Math.abs(t - top) < SAME_TOP;
}

/**
 * The ground top a piece at plan point (px, py), turned `yaw` (degrees, plan), stands on, or null when its footprint is
 * not wholly on one floor height clear of the cells it keeps off (see the header).
 */
export function pieceFooting(
  ctx: RecipeCtx,
  px: number,
  py: number,
  p: ArrangePiece,
  yaw: number,
  opts: FootingOpts = {},
): number | null {
  const keepOff = opts.keepOff ?? KEEP_OFF;
  const on = (qx: number, qy: number, flags: number, top: number): boolean =>
    standsAt(ctx, qx, qy, top, flags, opts.within);
  const centre = groundAt(ctx, px, py, keepOff, opts.within);
  if (centre === null) return null;
  const top = opts.top ?? centre;
  if (Math.abs(centre - top) >= SAME_TOP) return null;
  const lean = opts.lean;
  for (const [qx, qy] of footprintPoints(px, py, p, yaw).slice(1)) {
    if (on(qx, qy, keepOff, top)) continue;
    if (lean === undefined || !on(qx, qy, keepOff & ~CELL_FLAG.PATH, top)) return null;
    if (lean.never(Math.floor(qx), Math.floor(qy))) return null;
    // the corner pulled `reach` back toward the centre is off the path
    const d = Math.hypot(px - qx, py - qy);
    const t = d <= lean.reach ? 1 : lean.reach / d;
    if (!on(qx + (px - qx) * t, qy + (py - qy) * t, keepOff, top)) return null;
  }
  return top;
}
