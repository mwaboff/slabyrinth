/** compile_preview: the build's size and its build-level checks, with the substitution note when the generator reviews. */
import type { CompileDiagnostic, CompileEstimate } from "../../contracts/compiler";
import { generatorProfile } from "../../plan/generator";
import { designReviewText, substitutionNotes } from "../../review";
import { validateToolInput } from "../inputs";
import type { ToolOutcome } from "../tools";
import type { AgentToolContext } from "./ports";
import { fail, noPlan, textResult, unavailable, unknownLevel } from "./results";

export async function runCompilePreview(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
  const v = validateToolInput("compile_preview", input);
  if (!v.ok) return fail("compile_preview", ctx.head, v.errors);
  const plan = ctx.plan;
  if (plan === null) return noPlan("compile_preview");
  const unknown = (v.value.levels ?? []).filter((l) => !plan.levels.some((pl) => pl.id === l));
  if (unknown.length > 0)
    return unknownLevel(
      "compile_preview",
      ctx.head,
      plan,
      "/levels",
      `no level ${unknown.map((u) => `"${u}"`).join(", ")}`,
    );
  const est = await ctx.estimate(plan, v.value.levels);
  if (est === null)
    return unavailable(
      "compile_preview",
      ctx.head,
      "the build estimate is not available right now",
      "try again later",
    );
  // the build's substituted and unresolved pieces as one design note (review/), with the elements named
  const sub = generatorProfile(plan).designReview ? designReviewText(substitutionNotes(est.diagnostics)) : "";
  return textResult(compilePreviewText(ctx.head, est) + (sub ? `\n${sub}` : ""));
}

/** Caps for compile_preview problems: every error up to 40, warnings up to 25; info is summarised. */
export const PREVIEW_CAPS = { error: 40, warning: 25, repaired: 10 } as const;

/**
 * compile_preview result: build size plus the build-level checks (verify stage), errors first, each with the
 * fields the model needs to act (hint, cell, side, elementIds, assets). Info notes and automatic repairs are
 * summarised. A "checks" line says whether the build is clean.
 */
export function compilePreviewText(version: number, est: CompileEstimate): string {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const diags = [...est.diagnostics].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const toProblem = (d: CompileDiagnostic): Record<string, unknown> => {
    const p: Record<string, unknown> = { severity: d.severity, code: d.code, msg: d.message };
    if (d.hint !== undefined) p["hint"] = d.hint;
    if (d.levelId !== undefined) p["level"] = d.levelId;
    const ids = d.elementIds ?? (d.elementId !== undefined ? [d.elementId] : undefined);
    if (ids !== undefined && ids.length > 0) p["ids"] = ids;
    if (d.cell !== undefined) p["cell"] = d.cell;
    if (d.side !== undefined) p["side"] = d.side;
    if (d.assets !== undefined && d.assets.length > 0) p["assets"] = d.assets;
    if (d.count !== undefined) p["count"] = d.count;
    return p;
  };
  const errors = diags.filter((d) => d.severity === "error");
  const warnings = diags.filter((d) => d.severity === "warning");
  const info = diags.filter((d) => d.severity === "info");
  const repaired = info.filter((d) => d.repaired !== undefined);
  const notes = info.filter((d) => d.repaired === undefined);
  const noteCounts = new Map<string, number>();
  for (const n of notes) noteCounts.set(n.code, (noteCounts.get(n.code) ?? 0) + (n.count ?? 1));
  const out: Record<string, unknown> = {
    version,
    checks:
      errors.length === 0 && warnings.length === 0
        ? "clean: no build errors or warnings"
        : `NOT CLEAN: ${errors.length} error(s), ${warnings.length} warning(s); fix them with edit_plan (or tell the GM why one is intended), then run compile_preview again`,
    build:
      est.estimatedChunks <= 1
        ? "one slab for the whole map (every level), pasted once"
        : `too large for one slab: split into about ${est.estimatedChunks} chunks`,
    totalAssets: est.totalAssets,
    estimatedChunks: est.estimatedChunks,
    perLevel: est.perLevel,
    errors: errors.slice(0, PREVIEW_CAPS.error).map(toProblem),
    warnings: warnings.slice(0, PREVIEW_CAPS.warning).map(toProblem),
  };
  if (errors.length > PREVIEW_CAPS.error) out["moreErrors"] = errors.length - PREVIEW_CAPS.error;
  if (warnings.length > PREVIEW_CAPS.warning) out["moreWarnings"] = warnings.length - PREVIEW_CAPS.warning;
  if (repaired.length > 0) {
    out["repairedAutomatically"] = repaired.slice(0, PREVIEW_CAPS.repaired).map((d) => d.repaired);
    if (repaired.length > PREVIEW_CAPS.repaired)
      out["moreRepaired"] = repaired.length - PREVIEW_CAPS.repaired;
  }
  if (noteCounts.size > 0) out["notes"] = Object.fromEntries([...noteCounts.entries()].sort());
  return JSON.stringify(out);
}
