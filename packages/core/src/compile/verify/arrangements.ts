/**
 * Generator 5 (`arrangements`): the pieces of a level's arrangement instances stay within the per-level cap
 * (`ARRANGE_LIMITS.piecesPerLevel`, which resolve/level/arrangements.ts attaches within): a level past it, from a stage
 * that bypassed the attach or a hand-made plan, is reported (`verify_arrangement_cap`, warning). Bounds, the slab's
 * coordinate range and overlaps are the general checks' (props.ts, chunk.ts), which treat an instance as one element.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import { ARRANGE_LIMITS } from "../../arrange";
import type { VerifyCtx } from "./context";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const ARRANGEMENT_CODES = [
  "verify_arrangement_cap",
] as const satisfies readonly CompileDiagnosticCode[];

export function checkArrangementCap(ctx: VerifyCtx): void {
  if (!ctx.profile.arrangements) return;
  for (const lv of ctx.set.levels) {
    let n = 0;
    for (const p of lv.placements) if (ctx.arrangementOf(lv.levelId, p.source.elementId)) n++;
    if (n <= ARRANGE_LIMITS.piecesPerLevel) continue;
    ctx.report.add({
      severity: "warning",
      code: "verify_arrangement_cap",
      levelId: lv.levelId,
      count: n,
      message: `Level ${lv.levelId} places ${n} pieces in arrangements, more than the ${ARRANGE_LIMITS.piecesPerLevel} a level may hold.`,
      hint: "Fewer or sparser arrangements on this level.",
    });
  }
}
