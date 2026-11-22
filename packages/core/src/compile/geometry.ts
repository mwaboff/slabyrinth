/**
 * Plan → TaleSpire world geometry. Every convention comes from OrientationCalibration (data), never from code:
 * flipZ (plan row → z = Hg − 1 − row), rotSense (clockwise), edgePlacement (min corner of the rotated footprint,
 * +0.5 for north/east edges).
 */
import type { Box3, OrientationCalibration, PaletteVariant } from "../contracts/compiler";
import type { Side } from "../contracts/plan";
import { SIDES } from "../gen/gridGeometry";

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

/** Rotates (x, z) clockwise (seen from above) by `deg` degrees of game rotation (after rotSense). */
export function rotateXZ(x: number, z: number, cwDeg: number): { x: number; z: number } {
  const t = (cwDeg * Math.PI) / 180;
  const c = Math.round(Math.cos(t) * 1e12) / 1e12;
  const s = Math.round(Math.sin(t) * 1e12) / 1e12;
  return { x: x * c + z * s, z: -x * s + z * c };
}

/** World AABB of an asset stored at (x,y,z) with rotation `rotDeg` (game degrees; rotSense applied by caller). */
export function placementBox(
  geom: PaletteVariant["geom"],
  x: number,
  y: number,
  z: number,
  cwDeg: number,
): Box3 {
  const quarter = Math.round(cwDeg / 90);
  const odd = Math.abs(quarter) % 2 === 1 && Math.abs(cwDeg - quarter * 90) < 1e-6;
  if (geom.originAt === "minCorner") {
    const sx = odd ? geom.size.z : geom.size.x;
    const sz = odd ? geom.size.x : geom.size.z;
    return { min: { x, y, z }, max: { x: x + sx, y: y + geom.size.y, z: z + sz } };
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
