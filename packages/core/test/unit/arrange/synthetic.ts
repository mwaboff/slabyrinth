/**
 * Synthetic pieces for the arrangement tests: a box collider of the given size, as a prop (centred, origin at its
 * base) or a tile (min-corner origin), with no palette behind it.
 */
import type { ArrangePiece } from "../../../src/arrange";
import { fromVariant } from "../../../src/arrange";
import type { ResolvedVariant } from "../../../src/palette/resolve";

export function synthetic(
  name: string,
  x: number,
  y: number,
  z: number,
  originAt: "center" | "minCorner" = "center",
): ArrangePiece {
  const corner = originAt === "minCorner";
  const v: ResolvedVariant = {
    uuid: `00000000-0000-4000-8000-${name.padStart(12, "0").slice(-12)}`,
    wanted: `00000000-0000-4000-8000-${name.padStart(12, "0").slice(-12)}`,
    substituted: false,
    geom: {
      size: { x, y, z },
      originAt,
      boundsCenter: { x: corner ? x / 2 : 0, y: y / 2, z: corner ? z / 2 : 0 },
    },
    name,
    weight: 1,
    variant: undefined,
    footprint: [Math.max(1, Math.ceil(x)), Math.max(1, Math.ceil(z))],
    rot: 0,
    offset: { x: 0, y: 0, z: 0 },
    unitHeight: y,
    facing: undefined,
  };
  return fromVariant("generic", `feature.${name}`, v);
}

/** The value, or a test failure naming what was missing. */
export function must<T>(v: T | null | undefined, what = "value"): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** Rounds every number of a placed list for comparison: [x, y, z, yaw]. */
export function poses(a: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }>): number[][] {
  const r = (v: number): number => Math.round(v * 1e6) / 1e6 || 0;
  return a.map((p) => [r(p.x), r(p.y), r(p.z), p.yaw]);
}
