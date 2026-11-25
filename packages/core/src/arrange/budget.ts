/**
 * Piece budgets: how many pieces an arrangement places, and thinning one to a cap the same way every time: the finest
 * detail goes first (the highest `tier`), and within a tier each piece is ranked by a hash of the seed and its index;
 * what stays keeps its original order. `ARRANGE_LIMITS` are the caps the build holds instances to
 * (resolve/level/arrangements.ts attaches within them; verify reports a level past its cap).
 */
import { hashUnitMixed } from "../util/hash";
import type { Arrangement } from "./piece";

export const ARRANGE_LIMITS = {
  /** Pieces in one instance. */
  piecesPerInstance: 1024,
  /** Pieces of every instance on one level together (the cap generated features have, PLAN_LIMITS). */
  piecesPerLevel: 6000,
} as const;

export function pieceCount(a: Arrangement): number {
  return a.length;
}

export interface ThinParams {
  readonly cap: number;
  /** Names the draw (default 0). */
  readonly seed?: string | number;
}

/**
 * At most `cap` of the pieces (an arrangement's, or an instance's resolved pieces): the lowest tiers first, then a
 * deterministic choice by `seed`, in their original order.
 */
export function thin<T extends { readonly tier?: number }>(a: readonly T[], p: ThinParams): readonly T[] {
  if (a.length <= p.cap) return a;
  const seed = p.seed ?? 0;
  const keep = new Set(
    a
      .map((q, i) => ({ i, tier: q.tier ?? 0, rank: hashUnitMixed(seed, "thin", i) }))
      .sort((x, y) => x.tier - y.tier || x.rank - y.rank || x.i - y.i)
      .slice(0, Math.max(0, p.cap))
      .map((r) => r.i),
  );
  return a.filter((_, i) => keep.has(i));
}
