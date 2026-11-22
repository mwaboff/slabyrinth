/**
 * The arrangement model (generator 5): pieces placed in a local frame, before they are instanced on the map.
 *
 * - A piece (`ArrangePiece`) is a palette variant with where it came from (palette, role) and its measures
 *   (palette/traits.ts), usually borrowed from a trait pool (`fromPool`).
 * - A placed piece (`Placed`) stands with the centre of its collider's footprint at (x, z) and its bottom at y, turned
 *   `yaw` degrees clockwise seen from above (a multiple of 15, the only turn TaleSpire has). The frame is the world's:
 *   x east, z north, y up, tiles. Positions are continuous; the build quantises them (compile/realize/arrangements.ts).
 * - An arrangement is a list of placed pieces. Its pieces may overlap freely: an instance is one element.
 *
 * A piece is placed by its collider, in its own axes: a variant's correction `rot` and `offset` (role conventions) do
 * not apply, so the measures (`runAxis`, `length`, ...) are the piece's turned outline exactly.
 */
import type { RoleName } from "../contracts/compiler";
import type { ThemeId } from "../contracts/plan";
import type { ResolvedVariant } from "../palette/resolve";
import type { TraitPiece, TraitPool } from "../palette/traitPools";
import { measurePiece, type PieceMeasures } from "../palette/traits";
import { ROTATION_STEP } from "../slab/codec";
import { turnedHalfExtents } from "../util/turn";

/** A piece an arrangement places: the variant, the palette and role that list it, and its measures. */
export interface ArrangePiece {
  /** The palette that lists the asset (a theme's own, or `generic`). */
  readonly palette: ThemeId;
  readonly role: RoleName;
  readonly variant: ResolvedVariant;
  readonly measures: PieceMeasures;
}

/** One piece in an arrangement's frame: collider footprint centre (x, z), bottom y, clockwise turn `yaw` (degrees). */
export interface Placed {
  readonly piece: ArrangePiece;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /**
   * What the piece is worth when a budget thins (budget.ts `thin`): 0 what makes the map read (kept longest) .. 3 the
   * finest detail (dropped first). Absent: 0.
   */
  readonly tier?: number;
}

export type Arrangement = readonly Placed[];

/** A point on the ground of the local frame: [x, z]. */
export type XZ = readonly [x: number, z: number];

/** An axis-aligned box in the local frame. */
export interface LocalBox {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/** The piece of a trait pool's pick (its first role names it; the pool's palette supplied it). */
export function fromPool(pool: TraitPool, piece: TraitPiece): ArrangePiece {
  return {
    palette: pool.paletteId ?? "generic",
    role: piece.roles[0] ?? "",
    variant: piece.variant,
    measures: piece.measures,
  };
}

/** The piece of a variant a role resolution handed out. */
export function fromVariant(palette: ThemeId, role: RoleName, variant: ResolvedVariant): ArrangePiece {
  return { palette, role, variant, measures: measurePiece(variant.geom) };
}

/** A turn snapped to TaleSpire's 15° steps, in 0..345. */
export function snapYaw(deg: number): number {
  const steps = Math.round(deg / ROTATION_STEP);
  return (((steps * ROTATION_STEP) % 360) + 360) % 360;
}

/** One piece at the origin, turned `yaw`. */
export function single(piece: ArrangePiece, yaw = 0): Arrangement {
  return [{ piece, x: 0, y: 0, z: 0, yaw: snapYaw(yaw) }];
}

/** One piece at the origin, turned so its long horizontal side (`runAxis`) lies along local x: the module of a run. */
export function lengthwise(piece: ArrangePiece): Arrangement {
  return single(piece, piece.measures.runAxis === "z" ? 90 : 0);
}

/** The box of one placed piece: its footprint turned about its centre, from its bottom up its height. */
export function placedBox(p: Placed): LocalBox {
  const { size } = p.piece.variant.geom;
  const half = turnedHalfExtents(size.x, size.z, p.yaw);
  return {
    min: { x: p.x - half.x, y: p.y, z: p.z - half.z },
    max: { x: p.x + half.x, y: p.y + size.y, z: p.z + half.z },
  };
}

/** The box round every piece of an arrangement (a zero box at the origin for an empty one). */
export function bounds(a: Arrangement): LocalBox {
  if (a.length === 0) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of a) {
    const b = placedBox(p);
    min.x = Math.min(min.x, b.min.x);
    min.y = Math.min(min.y, b.min.y);
    min.z = Math.min(min.z, b.min.z);
    max.x = Math.max(max.x, b.max.x);
    max.y = Math.max(max.y, b.max.y);
    max.z = Math.max(max.z, b.max.z);
  }
  return { min, max };
}

/** How far an arrangement reaches along a local axis (its box's side). */
export function extent(a: Arrangement, axis: "x" | "y" | "z"): number {
  const b = bounds(a);
  return b.max[axis] - b.min[axis];
}

/** The centre of an arrangement's footprint. */
export function centreOf(a: Arrangement): XZ {
  const b = bounds(a);
  return [(b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2];
}

/** Several arrangements as one, in order. */
export function concat(...parts: readonly Arrangement[]): Arrangement {
  return parts.flat();
}
