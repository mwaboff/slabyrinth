/**
 * What every step of asciiLevel reads (the level, the options, the cropped region) and the one record that lives
 * across the steps on purpose: `AsciiSeen`, what the drawn map showed, which the legend lists afterwards.
 */
import type { PlanIssue } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";

export interface AsciiOptions {
  /** Crop to a cell rect (global coords). */
  region?: { x: number; y: number; w: number; h: number };
  /** Max cells across before switching to 1 char per cell (default 60). */
  maxDoubleWidth?: number;
  /** Most cells drawn one by one before the view becomes a block overview (default MAX_VIEW_CELLS). */
  maxCells?: number;
  /** Print the legend (default true). */
  legend?: boolean;
  /** Level labels for link hints, e.g. { l1: "L1" }. */
  levelLabels?: Record<string, string>;
  /** Issues to mark: cells of issues on this level are drawn as "!" and listed under the map. */
  issues?: readonly PlanIssue[];
}

export interface AsciiCtx {
  lvl: ResolvedLevel;
  opts: AsciiOptions;
  /** The cropped region in global cell coords: [rx0, rx1) × [ry0, ry1), rw × rh cells (both > 0). */
  rx0: number;
  ry0: number;
  rx1: number;
  ry1: number;
  rw: number;
  rh: number;
  /** Local cell index of a global cell, -1 outside the level. */
  cellI: (gx: number, gy: number) => number;
  /** Is the global cell inside the cropped region? */
  inView: (gx: number, gy: number) => boolean;
}

/** The region the view shows, null when the crop leaves nothing. */
export function createAsciiCtx(lvl: ResolvedLevel, opts: AsciiOptions): AsciiCtx | null {
  const B = lvl.bounds;
  let rx0 = B.x;
  let ry0 = B.y;
  let rx1 = B.x + B.w;
  let ry1 = B.y + B.h;
  if (opts.region) {
    rx0 = Math.max(rx0, Math.floor(opts.region.x));
    ry0 = Math.max(ry0, Math.floor(opts.region.y));
    rx1 = Math.min(rx1, Math.floor(opts.region.x + opts.region.w));
    ry1 = Math.min(ry1, Math.floor(opts.region.y + opts.region.h));
  }
  const rw = Math.max(0, rx1 - rx0);
  const rh = Math.max(0, ry1 - ry0);
  if (rw === 0 || rh === 0) return null;
  return {
    lvl,
    opts,
    rx0,
    ry0,
    rx1,
    ry1,
    rw,
    rh,
    cellI: (gx, gy) =>
      gx < B.x || gy < B.y || gx >= B.x + B.w || gy >= B.y + B.h ? -1 : (gy - B.y) * B.w + (gx - B.x),
    inView: (gx, gy) => gx >= rx0 && gx < rx1 && gy >= ry0 && gy < ry1,
  };
}

/** What the drawn map showed: the legend lists only these. Written while drawing, read by the legend. */
export interface AsciiSeen {
  /** Opening characters drawn on edges. */
  edgeChars: Set<string>;
  ledge: boolean;
  stair: boolean;
  /** Sunken heights (quarter tiles) and raised heights drawn as "^". */
  low: Set<number>;
  high: Set<number>;
  /** Base characters of cells inside the region. */
  base: Set<string>;
}

export const newSeen = (): AsciiSeen => ({
  edgeChars: new Set(),
  ledge: false,
  stair: false,
  low: new Set(),
  high: new Set(),
  base: new Set(),
});
