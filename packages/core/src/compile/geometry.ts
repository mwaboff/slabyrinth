/**
 * Plan → TaleSpire world geometry. Every convention comes from OrientationCalibration (data), never from code:
 * flipZ (plan row → z = Hg − 1 − row), rotSense (clockwise), edgePlacement (min corner of the rotated footprint,
 * +0.5 for north/east edges).
 */
import type { Box3, OrientationCalibration, PaletteVariant } from "../contracts/compiler";
import type { Side } from "../contracts/plan";
import { SIDES } from "../gen/gridGeometry";
import { rotateXZ, turnedHalfExtents } from "../util/turn";

/** The four sides clockwise from north (gen/gridGeometry.ts SIDES), the order the quarter turns count in. */
export const DIRS: readonly Side[] = SIDES;
const idx = (d: Side): number => DIRS.indexOf(d);

/** Turns `d` clockwise by `quarters` quarter turns (compass terms). */
export function rotateDir(d: Side, quarters: number): Side {
  return DIRS[(((idx(d) + quarters) % 4) + 4) % 4] ?? "N";
}

/** Clockwise quarter turns from `from` to `to` (0..3). */
export function turnQuarters(from: Side, to: Side): number {
  return (((idx(to) - idx(from)) % 4) + 4) % 4;
}

export class WorldFrame {
  constructor(
    readonly o: OrientationCalibration,
    /** Hg = 1 + the maximum plan row over all levels. */
    readonly hg: number,
  ) {}

  /** World z of the south edge of plan row `y` (the min z of cell row y). */
  cellZ(y: number): number {
    return this.o.flipZ ? this.hg - 1 - y : y;
  }

  /** World min corner (x, z) of a plan rect [x, x+w] × [y, y+h]. */
  rectMin(x: number, y: number, _w: number, h: number): { x: number; z: number } {
    return { x, z: this.o.flipZ ? this.hg - y - h : y };
  }

  /** World (x, z) of a plan point. */
  point(px: number, py: number): { x: number; z: number } {
    return { x: px, z: this.o.flipZ ? this.hg - py : py };
  }

  /** The plan cell whose square holds world (x, z): the inverse of `rectMin` for one cell. */
  cellAt(x: number, z: number): [number, number] {
    const row = Math.floor(z);
    return [Math.floor(x), this.o.flipZ ? this.hg - 1 - row : row];
  }

  /** A plan direction (dx east, dy south) in the world (x, z), unscaled. */
  planVector(dx: number, dy: number): { x: number; z: number } {
    return { x: dx, z: this.o.flipZ ? -dy : dy };
  }

  /** Compass side in the world for a plan side. */
  worldSide(s: Side): Side {
    if (this.o.flipZ) return s;
    return s === "N" ? "S" : s === "S" ? "N" : s;
  }

  /** Codec rotation steps (15° each, 0..23) for `quarters` clockwise quarter turns seen from above. */
  stepsForQuarters(quarters: number): number {
    return (((quarters * 6 * this.o.rotSense) % 24) + 24) % 24;
  }

  /** Steps that turn a rot-0 direction `from` into world direction `to`. */
  stepsToFace(from: Side, to: Side): number {
    return this.stepsForQuarters(turnQuarters(from, to));
  }

  /** Direction `d` (at rot 0) after rotating the asset by `steps`. */
  dirAfter(d: Side, steps: number): Side {
    const q = Math.round((steps * this.o.rotSense) / 6);
    return rotateDir(d, q);
  }

  /** Converts a plan-view clockwise angle (degrees) into codec degrees. */
  planDegreesToWorld(deg: number): number {
    const d = this.o.flipZ ? deg : -deg;
    return (((d * this.o.rotSense) % 360) + 360) % 360;
  }
}

/** A rotation snapped to the nearest quarter turn, 0..270 (a tile stays square to the grid). */
export const quarterTurn = (deg: number): number => (((Math.round(deg / 90) % 4) + 4) % 4) * 90;

export { rotateXZ, turnBasis } from "../util/turn";

/**
 * The turn a placement's stored rotation (`Placement.rot`, or a slab's rotation in degrees) means in the world:
 * degrees clockwise seen from above, the calibration's rotSense applied. The one reading realize places a piece by and
 * the 3D scene draws it by, so the two can never disagree about which way a piece faces.
 */
export function worldTurn(rot: number, o: Pick<OrientationCalibration, "rotSense">): number {
  return rot * o.rotSense;
}

/**
 * World AABB of an asset stored at (x,y,z) with rotation `rotDeg` (game degrees; rotSense applied by caller).
 *
 * A tile (corner-origin) is stored at the min corner of its turned footprint (docs/talespire-slab-format.md §2.2,
 * verified in game for quarter turns): its box starts at the stored point and is as wide as the footprint turned about
 * its centre, which at a quarter turn is the footprint itself (swapped at odd ones) and at any other 15° step the
 * larger box round the turned outline. A prop is stored at its origin; its box is the collider turned about it.
 */
export function placementBox(
  geom: PaletteVariant["geom"],
  x: number,
  y: number,
  z: number,
  cwDeg: number,
): Box3 {
  if (geom.originAt === "minCorner") {
    const half = turnedHalfExtents(geom.size.x, geom.size.z, cwDeg);
    return { min: { x, y, z }, max: { x: x + 2 * half.x, y: y + geom.size.y, z: z + 2 * half.z } };
  }
  const c = rotateXZ(geom.boundsCenter.x, geom.boundsCenter.z, cwDeg);
  const t = (cwDeg * Math.PI) / 180;
  const ex = (Math.abs(Math.cos(t)) * geom.size.x) / 2 + (Math.abs(Math.sin(t)) * geom.size.z) / 2;
  const ez = (Math.abs(Math.sin(t)) * geom.size.x) / 2 + (Math.abs(Math.cos(t)) * geom.size.z) / 2;
  const cy = y + geom.boundsCenter.y;
  return {
    min: { x: x + c.x - ex, y: cy - geom.size.y / 2, z: z + c.z - ez },
    max: { x: x + c.x + ex, y: cy + geom.size.y / 2, z: z + c.z + ez },
  };
}

/**
 * Where an asset is stored so that its collider stands centred on world (cx, cz) with its bottom at `bottom`, turned
 * `cwDeg` (game degrees, rotSense applied): the inverse of `placementBox`, by the same rule for tiles and props.
 */
export function storedPosition(
  geom: PaletteVariant["geom"],
  cx: number,
  bottom: number,
  cz: number,
  cwDeg: number,
): { x: number; y: number; z: number } {
  if (geom.originAt === "minCorner") {
    const half = turnedHalfExtents(geom.size.x, geom.size.z, cwDeg);
    return { x: cx - half.x, y: bottom, z: cz - half.z };
  }
  const off = rotateXZ(geom.boundsCenter.x, geom.boundsCenter.z, cwDeg);
  return { x: cx - off.x, y: bottom - geom.boundsCenter.y + geom.size.y / 2, z: cz - off.z };
}

export function emptyBox(): Box3 {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

export function growBox(b: Box3, o: Box3): void {
  b.min.x = Math.min(b.min.x, o.min.x);
  b.min.y = Math.min(b.min.y, o.min.y);
  b.min.z = Math.min(b.min.z, o.min.z);
  b.max.x = Math.max(b.max.x, o.max.x);
  b.max.y = Math.max(b.max.y, o.max.y);
  b.max.z = Math.max(b.max.z, o.max.z);
}

export function finiteBox(b: Box3): Box3 {
  if (!Number.isFinite(b.min.x)) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const r = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    min: { x: r(b.min.x), y: r(b.min.y), z: r(b.min.z) },
    max: { x: r(b.max.x), y: r(b.max.y), z: r(b.max.z) },
  };
}
