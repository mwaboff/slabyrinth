/**
 * An arrangement set on the map: the resolved element a resolve stage attaches (`ResolvedArrangement`,
 * contracts/resolved.ts) and the plan-frame geometry both sides share. The local frame (x east, z north, y up) is turned
 * `turn` clockwise and stood on the plan point `at` (plan y grows southwards, so local z becomes minus plan y), its y = 0
 * at the absolute height `base`. compile/realize/arrangements.ts builds from the same mapping (`planPointOf`).
 */
import type { Vec2 } from "../contracts/plan";
import type { ResolvedArrangement, ResolvedArrangementPiece } from "../contracts/resolved";
import { maxOf, minOf } from "../util/lists";
import { rotateXZ } from "../util/turn";
import { ARRANGE_LIMITS, thin } from "./budget";
import { placedBox, snapYaw, type Arrangement } from "./piece";

/** Where an arrangement is set: a plan point (cells), the absolute height of its y = 0, its turn (degrees clockwise). */
export interface Anchor {
  readonly at: readonly [number, number];
  readonly base: number;
  readonly turn?: number;
}

export interface InstanceSpec {
  readonly id: string;
  readonly recipe: string;
  readonly anchor: Anchor;
  /** Default true: the pieces block the way. */
  readonly blocking?: boolean;
  /** Names the thinning draw when the arrangement is over `ARRANGE_LIMITS.piecesPerInstance` (default: the id). */
  readonly seed?: string | number;
}

/** The plan point of a local point (x, z) of an instance at `at` turned `turn`. */
export function planPointOf(
  at: readonly [number, number],
  turn: number,
  x: number,
  z: number,
): [number, number] {
  const r = rotateXZ(x, z, turn);
  return [at[0] + r.x, at[1] - r.z];
}

/** The resolved element of an arrangement: its pieces as palette references, thinned to the per-instance cap. */
export function toInstance(a: Arrangement, spec: InstanceSpec): ResolvedArrangement {
  const kept = thin(a, { cap: ARRANGE_LIMITS.piecesPerInstance, seed: spec.seed ?? spec.id });
  const turn = snapYaw(spec.anchor.turn ?? 0);
  const pieces: ResolvedArrangementPiece[] = kept.map((p) => ({
    palette: p.piece.palette,
    role: p.piece.role,
    asset: p.piece.variant.wanted,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: snapYaw(p.yaw),
    ...(p.tier !== undefined && p.tier > 0 ? { tier: p.tier } : {}),
  }));
  return {
    id: spec.id,
    recipe: spec.recipe,
    at: [spec.anchor.at[0], spec.anchor.at[1]],
    base: spec.anchor.base,
    turn,
    cells: coveredCells(kept, spec.anchor.at, turn),
    blocking: spec.blocking ?? true,
    pieces,
  };
}

/** The plan cells the pieces' footprints cover (each piece's turned box, turned again into the plan), ascending. */
function coveredCells(a: Arrangement, at: readonly [number, number], turn: number): Vec2[] {
  const keys = new Map<string, Vec2>();
  for (const p of a) {
    const b = placedBox(p);
    const corners = [
      planPointOf(at, turn, b.min.x, b.min.z),
      planPointOf(at, turn, b.max.x, b.min.z),
      planPointOf(at, turn, b.max.x, b.max.z),
      planPointOf(at, turn, b.min.x, b.max.z),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const eps = 1e-6;
    for (let y = Math.floor(minOf(ys) + eps); y < maxOf(ys) - eps; y++)
      for (let x = Math.floor(minOf(xs) + eps); x < maxOf(xs) - eps; x++) keys.set(`${x},${y}`, [x, y]);
  }
  return [...keys.values()].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
}
