/**
 * Covered stalls (generator 4, switch `coveredStalls`) the palettes cannot build: the same question the resolver asked
 * (palette/stallParts.ts), asked of the stall's own theme. It fires when the resolved plan was resolved against other
 * palettes than the ones compiled with (a caller error: both take the same catalog), or when a stall row spans two
 * themes (the resolver asks once per row, the build per stall).
 *
 * Emits `verify_stall_uncovered` (warning), one per stall.
 */
import type { CompileDiagnosticCode } from "../../contracts/compiler";
import { roleProbe, stallParts } from "../../palette/stallParts";
import type { VerifyCtx } from "./context";
import { elementRef } from "./words";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const STALL_CODES = ["verify_stall_uncovered"] as const satisfies readonly CompileDiagnosticCode[];

export function checkCoveredStalls(ctx: VerifyCtx): void {
  if (!ctx.profile.coveredStalls) return;
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    if (!g) continue;
    for (const f of L.features) {
      if (!f.stall) continue;
      const theme = f.theme || g.cell(f.at[0], f.at[1]).theme;
      const parts = stallParts(roleProbe(ctx.resolveRole, theme), f.stall.form);
      if ("missing" in parts)
        ctx.report.add({
          severity: "warning",
          code: "verify_stall_uncovered",
          levelId: L.id,
          ...elementRef(f.id),
          cell: [f.at[0], f.at[1]],
          message: `Stall ${f.id} was laid out covered (${f.stall.form} canopy, ${f.stall.w}x${f.stall.d}) but theme "${theme}" has no stall ${parts.missing} piece; only its table and goods were built.`,
          hint: `covered stalls are chosen by the level's theme: put the stall row in an area of that theme, or give theme "${theme}" a stall ${parts.missing} piece`,
        });
    }
  }
}
