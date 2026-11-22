/**
 * Bays (`@bays`): a face or a storey line cut at a pitch, phase-locked to its openings. Each blank stretch (between the
 * face's ends and its openings) is cut into the whole number of bays nearest to its length over the pitch, all of one
 * width, so a bay joint falls at every opening and every end. The bays of a stretch come as mirrored pairs: the first
 * and the last, the second and the second-to-last, ... (the second of each pair mirrored; a middle bay alone stands
 * unmirrored), so a recipe composed for one bay is symmetric about the stretch by construction.
 */
import { shiftFrame, type AnchorFrame } from "./frame";
import type { FaceAnchor, FaceGap, StoreyLineAnchor } from "./types";

export interface Bay {
  /** Frame origin: the bay's centre on the surface, `u` along the face (mirrored for the far member of a pair). */
  readonly frame: AnchorFrame;
  readonly width: number;
  /** The stretch it belongs to (0, 1, ... along the face) and its index in it. */
  readonly stretch: number;
  readonly index: number;
  /** How many bays its stretch has. */
  readonly of: number;
  /** Local x of the bay's centre along the face. */
  readonly x: number;
}

/** The blank stretches of a run: [from, to] between its ends and its gaps (gaps sorted by `from`). */
export function blankStretches(length: number, gaps: readonly FaceGap[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const gp of [...gaps].sort((p, q) => p.from - q.from)) {
    if (gp.from > at + 1e-9) out.push([at, gp.from]);
    at = Math.max(at, gp.to);
  }
  if (length > at + 1e-9) out.push([at, length]);
  return out;
}

/** The bays of a face or line at `pitch` (tiles), phase-locked to its gaps. */
export function baysOf(anchor: FaceAnchor | StoreyLineAnchor, pitch: number): Bay[] {
  const out: Bay[] = [];
  if (pitch <= 0) return out;
  blankStretches(anchor.length, anchor.gaps).forEach(([from, to], stretch) => {
    const len = to - from;
    const n = Math.max(1, Math.round(len / pitch));
    const width = len / n;
    for (let i = 0; i < n; i++) {
      const x = from + (i + 0.5) * width;
      const far = i > (n - 1) / 2;
      const f = shiftFrame(anchor.frame, x);
      out.push({ frame: far ? { ...f, mirror: true } : f, width, stretch, index: i, of: n, x });
    }
  });
  return out;
}
