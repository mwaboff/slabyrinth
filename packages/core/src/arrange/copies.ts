/**
 * Copies of an arrangement about a point or a line: `twin` (a turned copy at the same place), `fan` (copies in 15°
 * steps at one centre), `ring` (copies round a point), `layer` (a second skin) and `mirror` (reflected across a line).
 */
import { rotateXZ } from "../util/turn";
import { centreOf, extent, snapYaw, type Arrangement, type Placed, type XZ } from "./piece";
import { transform } from "./transform";

export interface TwinParams {
  /** The copy's turn (default 180: a one-sided piece made two-sided; 90 for cross-planing). */
  readonly turn?: number;
  /** Turned about this point (default: the arrangement's footprint centre). */
  readonly about?: XZ;
  /** The copy is then moved by this much (back to back: a piece's thickness, 0..0.3). */
  readonly offset?: XZ;
}

/** The arrangement and a turned copy of it. */
export function twin(a: Arrangement, p: TwinParams = {}): Arrangement {
  const [dx, dz] = p.offset ?? [0, 0];
  return [...a, ...transform(a, { turn: p.turn ?? 180, about: p.about ?? centreOf(a), dx, dz })];
}

export interface FanParams {
  readonly count: number;
  /** The turn between copies (default 15). */
  readonly step?: number;
  /** Default: the arrangement's footprint centre. */
  readonly about?: XZ;
}

/** `count` copies at one centre, each turned `step` further: a post rounded into a column, a slab into a disc. */
export function fan(a: Arrangement, p: FanParams): Arrangement {
  const about = p.about ?? centreOf(a);
  const step = p.step ?? 15;
  return Array.from({ length: Math.max(0, p.count) }, (_, i) =>
    transform(a, { turn: i * step, about }),
  ).flat();
}

/** Two sides within this ratio are "about equal" (palette/traits.ts uses the same for a piece's long axis). */
const SAME_SIDE = 1.1;

/**
 * How many copies `fan` needs for a full round at `step`: an outline that repeats every quarter turn (a square
 * footprint, its sides within 10%) needs 90/step, any other every half turn 180/step.
 */
export function roundCount(a: Arrangement, step = 15): number {
  const sx = extent(a, "x");
  const sz = extent(a, "z");
  const square = Math.max(sx, sz) <= SAME_SIDE * Math.min(sx, sz);
  return Math.max(1, Math.round((square ? 90 : 180) / step));
}

/** Which way each copy of a ring is turned: with its bearing, back to the centre, along the circle, or not at all. */
export type RingFacing = "out" | "centre" | "tangent" | "keep";

export interface RingParams {
  readonly count: number;
  /** From the centre to each copy's origin. */
  readonly radius: number;
  /** Angle of the first copy, clockwise from east (default 0). */
  readonly start?: number;
  readonly about?: XZ;
  /** Default "out": each copy turned by its bearing, so it faces out the way the first does. */
  readonly facing?: RingFacing;
}

const FACING_TURN: Readonly<Record<RingFacing, (bearing: number) => number>> = {
  out: (b) => b,
  centre: (b) => b + 180,
  tangent: (b) => b + 90,
  keep: () => 0,
};

/** `count` copies round a point at `radius`, positions exact, each turned by its facing (snapped to 15°). */
export function ring(a: Arrangement, p: RingParams): Arrangement {
  const [cx, cz] = p.about ?? [0, 0];
  const n = Math.max(0, p.count);
  const face = FACING_TURN[p.facing ?? "out"];
  const out: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const bearing = (p.start ?? 0) + (i * 360) / n;
    const turn = face(bearing);
    for (const q of a) {
      const at = rotateXZ(p.radius, 0, bearing);
      const own = rotateXZ(q.x, q.z, turn);
      out.push({ ...q, x: cx + at.x + own.x, z: cz + at.z + own.z, yaw: snapYaw(q.yaw + turn) });
    }
  }
  return out;
}

export interface LayerParams {
  /** The local axis the second skin stands off along. */
  readonly normal: "x" | "z";
  /** How far proud of the first (negative: behind it): 0.02..0.25; coplanar layers keep at least 0.02. */
  readonly proud: number;
  /** Along the other horizontal axis (half a module: half the first skin's extent that way). */
  readonly shift?: number;
  /** Up (a course offset). */
  readonly rise?: number;
  /** The second skin (default: a copy of the first; another arrangement for frame and infill). */
  readonly skin?: Arrangement;
}

/** A second skin just proud of (or behind) the first, shifted along it: depth and broken joints on a face. */
export function layer(a: Arrangement, p: LayerParams): Arrangement {
  const shift = p.shift ?? 0;
  const dy = p.rise ?? 0;
  const move = p.normal === "x" ? { dx: p.proud, dz: shift, dy } : { dz: p.proud, dx: shift, dy };
  return [...a, ...transform(p.skin ?? a, move)];
}

export interface MirrorParams {
  /** The axis whose sign flips: "x" mirrors across the line x = at (east to west), "z" across z = at. */
  readonly axis: "x" | "z";
  readonly at?: number;
  /** Keep the original beside the mirrored copy (default true). */
  readonly keep?: boolean;
}

/**
 * The arrangement reflected across a line. Pieces cannot be scaled in TaleSpire, so each is turned to the yaw that
 * mirrors its footprint and its front (a left-handed piece stays left-handed).
 */
export function mirror(a: Arrangement, p: MirrorParams): Arrangement {
  const at = p.at ?? 0;
  const m = a.map((q) =>
    p.axis === "x"
      ? { ...q, x: 2 * at - q.x, yaw: snapYaw(180 - q.yaw) }
      : { ...q, z: 2 * at - q.z, yaw: snapYaw(-q.yaw) },
  );
  return p.keep === false ? m : [...a, ...m];
}
