/**
 * How much ground a small natural or loose piece (a tuft, a fern, a flower clump, a rock, a scrap of paper) visibly
 * covers seen from above, as opposed to its collider box. A collider is the box round the piece; turned between the
 * quarter turns its axis-aligned box is up to twice the piece; and inside the box a plant is fronds with gaps, a rock
 * is rounded, a scatter of papers is a few sheets. Measured on the varied-street proof, ground cover read 30-42 % by
 * boxes and 10-15 % in the owner's screenshots, which is what this model gives.
 *
 * Model: the ellipse inscribed in the piece's own turned footprint (not the axis-aligned box round it), shrunk about its
 * centre to the share of it the piece's kind fills (FILL). Shared by the ground recipe (resolve/recipes/ground.ts, which
 * lays to a visible share) and the meter (review/qualityRooms.ts ground_cover), so both measure cover one way.
 * The fill shares are estimates from the asset kinds (not measured per piece in game): to be replaced by a per-piece
 * fact when the owner measures one.
 */
import { rotateXZ } from "./turn";

/** Share of its inscribed ellipse a piece of each kind fills, seen from above (estimates; see the header). */
export const FILL = {
  /** rocks, rubble, blocks: solid but rounded */
  solid: 0.85,
  /** flat cover: leaves, pebbles, papers lie as a few separate bits */
  flat: 0.6,
  /** standing plants: tufts, ferns, flowers, bushes, fronds with gaps */
  plant: 0.55,
} as const;

/** Flat cover is at most this tall (the ground recipe's FLAT_H). */
const FLAT_H = 0.17;

/** The kind of a cover piece by its role (or, where the role is not known, its name) and height. */
export function coverKind(role: string, height: number): keyof typeof FILL {
  if (/rock|rubble|debris|block|stone|pebble/i.test(role)) return "solid";
  return height <= FLAT_H ? "flat" : "plant";
}

/** One piece as cover: its footprint centre (plan x, y: cells), its collider's sides (x, z), its turn and kind. */
export interface CoverShape {
  readonly x: number;
  readonly y: number;
  readonly sx: number;
  readonly sz: number;
  /** Clockwise turn seen from above, degrees (the world's sense: plan y runs south, world z north). */
  readonly yaw: number;
  readonly kind: keyof typeof FILL;
}

/** The ground a shape visibly covers (tiles²): its inscribed ellipse times its fill. */
export const visibleArea = (s: CoverShape): number => (Math.PI / 4) * s.sx * s.sz * FILL[s.kind];

/** Whether a shape visibly covers the plan point (px, py). */
export function coversPoint(s: CoverShape, px: number, py: number): boolean {
  const k = Math.sqrt(FILL[s.kind]);
  const a = (s.sx / 2) * k;
  const b = (s.sz / 2) * k;
  if (a <= 0 || b <= 0) return false;
  // into the piece's own axes: plan y south is world -z; undo the clockwise turn
  const r = rotateXZ(px - s.x, s.y - py, -s.yaw);
  return (r.x / a) ** 2 + (r.z / b) ** 2 <= 1;
}

/** Samples per tile side of the raster `coveredSamples` uses. */
export const COVER_RASTER = 10;
/** The stride of a sample's key (gx * KEY + gy). */
const KEY = 100003;

/** The cell (x, y) a sample key of `coveredSamples` lies in. */
export function sampleCell(s: number): [number, number] {
  const gx = Math.floor(s / KEY + 1e-9);
  const gy = s - gx * KEY;
  return [Math.floor(gx / COVER_RASTER), Math.floor(gy / COVER_RASTER)];
}

/**
 * The raster samples (COVER_RASTER per tile side, at their centres) the shapes visibly cover, keyed `gx,gy`, kept to
 * those `keep(cellX, cellY)` accepts: the union, so overlapping pieces count once.
 */
export function coveredSamples(
  shapes: readonly CoverShape[],
  keep: (cx: number, cy: number) => boolean,
): Set<number> {
  const R = COVER_RASTER;
  const out = new Set<number>();
  for (const s of shapes) {
    const reach = Math.max(s.sx, s.sz) / 2;
    for (let gx = Math.floor((s.x - reach) * R); gx < Math.ceil((s.x + reach) * R); gx++)
      for (let gy = Math.floor((s.y - reach) * R); gy < Math.ceil((s.y + reach) * R); gy++) {
        const px = (gx + 0.5) / R;
        const py = (gy + 0.5) / R;
        if (!coversPoint(s, px, py)) continue;
        if (!keep(Math.floor(px), Math.floor(py))) continue;
        out.add(gx * KEY + gy);
      }
  }
  return out;
}
