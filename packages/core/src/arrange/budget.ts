/**
 * Piece budgets: how many pieces an arrangement places, and thinning one to a cap the same way every time (each piece
 * ranked by a hash of the seed and its index; the lowest ranks stay, in their original order). `ARRANGE_LIMITS` are the
 * caps the build holds instances to (resolve/level/arrangements.ts attaches within them; verify reports a level past
 * its cap).
 */
import { hashUnit } from "../util/hash";
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

/**
 * At most `cap` of the arrangement's pieces (or of any list: an instance's resolved pieces): a deterministic choice by
 * `seed`, in their original order.
 */
export function thin<T = Arrangement[number]>(
  a: readonly T[],
  cap: number,
  seed: string | number = 0,
): readonly T[] {
  if (a.length <= cap) return a;
  const keep = new Set(
    a
      .map((_, i) => ({ i, rank: hashUnit(seed, "thin", i) }))
      .sort((p, q) => p.rank - q.rank || p.i - q.i)
      .slice(0, Math.max(0, cap))
      .map((r) => r.i),
  );
  return a.filter((_, i) => keep.has(i));
}
