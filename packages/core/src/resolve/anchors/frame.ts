/**
 * The local frame an anchor hands a recipe, and the plan geometry of frames. A frame is where a recipe's arrangement is
 * set (arrange/instance.ts `Anchor`): local +x runs along the anchor (`u`), local +z is its normal `n` (out of the wall,
 * toward whoever sees it: `u` turned a quarter counter-clockwise seen from above), +y is up from `base`. A recipe composed
 * in the frame (posts at x = ±0.75, a band at z = 0.1) is the same recipe on every wall of every theme.
 *
 * `mirror`: the frame's local x is reflected (the left jamb of an opening, the far end of a run): a recipe composed for
 * the right-hand frame is mirrored by construction (arrange/ `mirror`: position and yaw, never a scaled mesh).
 *
 * Plan coordinates: x east, y south, cells. A grid frame's `turn` is a quarter turn: 0 when `u` is east (normal north),
 * 90 when `u` is south (normal east), 180 west (normal south), 270 north (normal west).
 */
import type { Side } from "../../contracts/plan";
import { planPointOf } from "../../arrange";

export interface AnchorFrame {
  /** Plan point of the local origin. */
  readonly at: readonly [number, number];
  /** Clockwise turn (degrees) taking local +x to the anchor's direction `u`. */
  readonly turn: number;
  /** Absolute height (tiles) of local y = 0. */
  readonly base: number;
  /** Local x reflected (a paired frame's left-hand member). */
  readonly mirror?: boolean;
}

/** The frame turn whose normal points to `side`. */
export const NORMAL_TURN: Readonly<Record<Side, number>> = { N: 0, E: 90, S: 180, W: 270 };

/** The plan point of local (x, z) of a frame (mirror applied). */
export function framePoint(f: AnchorFrame, x: number, z: number): [number, number] {
  return planPointOf(f.at, f.turn, f.mirror === true ? -x : x, z);
}

/** A frame moved along its own axes (x along `u`, z along `n`, y up); a mirrored frame moves the mirrored way. */
export function shiftFrame(f: AnchorFrame, x: number, z = 0, y = 0): AnchorFrame {
  return { ...f, at: framePoint(f, x, z), base: f.base + y };
}

/**
 * The frame of a straight run of cells along one grid line, seen from the `n` side: `line` is the edge line's
 * coordinate (y of a horizontal line, x of a vertical one), `lo..hi` the first and last cell along it, and `plane` how
 * far the surface stands from the line toward `n` (a half-cell wall hosted on the viewer's side: 0.5). The origin is the
 * run's start as `u` walks it, so local x runs 0..(hi - lo + 1).
 */
export function runFrame(
  n: Side,
  line: number,
  lo: number,
  hi: number,
  plane: number,
  base: number,
): AnchorFrame {
  const turn = NORMAL_TURN[n];
  switch (n) {
    case "N":
      return { at: [lo, line - plane], turn, base };
    case "S":
      return { at: [hi + 1, line + plane], turn, base };
    case "E":
      return { at: [line + plane, lo], turn, base };
    case "W":
      return { at: [line - plane, hi + 1], turn, base };
  }
}

/** Where along a run frame (local x of the near end) the cell at coordinate `c` along the line starts. */
export function runOffset(n: Side, lo: number, hi: number, c: number): number {
  return n === "N" || n === "E" ? c - lo : hi - c;
}

/** The unit direction `u` of a frame in the plan (x east, y south). */
export function frameDir(f: AnchorFrame): [number, number] {
  const [x0, y0] = framePoint({ ...f, mirror: false }, 0, 0);
  const [x1, y1] = framePoint({ ...f, mirror: false }, 1, 0);
  return [x1 - x0, y1 - y0];
}
