/**
 * Moving a whole arrangement: turned about a point, then moved. Every operator that copies does it through this, so a
 * turn off the 15° grid (a ring of 7) places the copies exactly and snaps each piece's yaw to the grid.
 */
import { rotateXZ } from "../util/turn";
import { snapYaw, type Arrangement, type XZ } from "./piece";

export interface TransformParams {
  /** Turn about `about` (degrees clockwise; positions turn exactly, yaws snap to 15°). */
  readonly turn?: number;
  readonly about?: XZ;
  readonly dx?: number;
  readonly dy?: number;
  readonly dz?: number;
}

/** Turns the arrangement about a point, then moves it. */
export function transform(a: Arrangement, t: TransformParams): Arrangement {
  const turn = t.turn ?? 0;
  const [ax, az] = t.about ?? [0, 0];
  const dx = t.dx ?? 0;
  const dy = t.dy ?? 0;
  const dz = t.dz ?? 0;
  return a.map((p) => {
    const r = rotateXZ(p.x - ax, p.z - az, turn);
    return { ...p, x: ax + r.x + dx, y: p.y + dy, z: az + r.z + dz, yaw: snapYaw(p.yaw + turn) };
  });
}
