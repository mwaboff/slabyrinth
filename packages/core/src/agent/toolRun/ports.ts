/**
 * What the tool executor is given: the ports (geometry, text views and checks, injected so tests can use fakes; the
 * defaults are the real core functions) and the context the engine supplies with each call.
 */
import type { ApplyOps, DiffPlans } from "../../contracts/ops";
import type { LevelId, MapPlan, PlanIssue, ValidationResult } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import type { PaletteCatalog } from "../../contracts/compiler";
import { applyOps } from "../../ops/apply";
import { diffPlans } from "../../ops/diff";
import { validatePlan } from "../../plan/validate";
import { planRules, resolvePlan } from "../../resolve";
import { asciiView, changedRegionViews, outlineView } from "../../text";
import type { ToolContext, ToolOutcome } from "../tools";
import { sizeLimits, type SizeTierId } from "../../plan/sizeTiers";

/** A crop and the issues to mark, as the ascii port takes them. */
export interface AsciiPortOptions {
  region?: { x: number; y: number; w: number; h: number };
  issues?: readonly PlanIssue[];
}

export interface ExecutorPorts {
  /** `palettes`: the ones the plan is built with (`materialize` resolves the plan against them). */
  applyOps: (plan: MapPlan, ops: Parameters<ApplyOps>[1], palettes: PaletteCatalog) => ReturnType<ApplyOps>;
  /** `palettes`: the ones the plan is built with (the checks that resolve the plan use them). */
  validatePlan: (
    input: unknown,
    ctx: { themes?: readonly string[]; palettes: PaletteCatalog; sizeTier?: SizeTierId },
  ) => ValidationResult;
  diffPlans: DiffPlans;
  /** null: resolver unavailable (outline still works without resolved facts; ascii is unavailable). */
  resolvePlan: ((plan: MapPlan, palettes: PaletteCatalog, version: number) => ResolvedPlan) | null;
  outline:
    | ((
        plan: MapPlan,
        resolved: ResolvedPlan | null,
        opts: { version?: number; levels?: LevelId[] },
      ) => string)
    | null;
  ascii: ((resolved: ResolvedPlan, levelId: LevelId, opts: AsciiPortOptions) => string) | null;
  changedViews:
    | ((
        before: ResolvedPlan | null,
        after: ResolvedPlan,
        opts: { maxChars: number },
      ) => { views: Array<{ levelId: LevelId; text: string }>; fits: boolean })
    | null;
}

/**
 * Default ports. applyOps runs WITHOUT validation: the executor validates the result itself so it can separate
 * blocking errors (reject) from playability findings (report, never reject) — see checks.ts.
 */
export const defaultExecutorPorts: ExecutorPorts = {
  applyOps: (plan, ops, palettes) => applyOps(plan, ops, planRules(palettes), { validate: false }),
  validatePlan: (input, ctx) =>
    validatePlan(input, {
      checks: planRules(ctx.palettes).checks,
      ...(ctx.themes !== undefined ? { themes: ctx.themes } : {}),
      ...(ctx.sizeTier !== undefined ? { limits: sizeLimits(ctx.sizeTier) } : {}),
    }),
  diffPlans: (before, after) => diffPlans(before, after),
  resolvePlan: (plan, palettes, version) => resolvePlan(plan, palettes, { planVersion: version }),
  outline: (plan, resolved, opts) => outlineView(plan, resolved, opts),
  ascii: (resolved, levelId, opts) => {
    const o: AsciiPortOptions = {};
    if (opts.region) o.region = opts.region;
    if (opts.issues) o.issues = opts.issues;
    return asciiView(resolved, levelId, o);
  },
  changedViews: (before, after, opts) => changedRegionViews(before, after, { maxChars: opts.maxChars }),
};

/**
 * The context the engine supplies: the contract's ToolContext plus
 *  - `palettes`: the palettes the plan is built with (bundled, the user's, the game's assets), so the views, checks
 *    and design review the model gets describe the map the build produces;
 *  - `nextVersion`: the number the next committed version will get (default head + 1);
 *  - `planAt`: lets stale_version report what changed since the model's base version.
 */
export interface AgentToolContext extends ToolContext {
  palettes: PaletteCatalog;
  /** The map size setting the model's plans are held to (plan/sizeTiers.ts); standard when absent. */
  sizeTier?: SizeTierId;
  nextVersion?: number;
  planAt?: (version: number) => MapPlan | null;
}

export type AgentExecuteTool = (ctx: AgentToolContext, name: string, input: unknown) => Promise<ToolOutcome>;
