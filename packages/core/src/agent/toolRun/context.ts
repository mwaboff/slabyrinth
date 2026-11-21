/**
 * What every tool run reads: the executor's ports, and the one record that lives across calls on purpose, the design
 * review last shown for each plan (so a later result shows only what changed). One per executor, never module-level.
 */
import type { LevelId, MapPlan, PlanIssue, ValidationResult } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import type { PaletteCatalog } from "../../contracts/compiler";
import type { DesignNote } from "../../review";
import type { AgentToolContext, ExecutorPorts } from "./ports";

export class ToolRunCtx {
  /** The design review last shown for each plan (by plan id). */
  readonly lastReview = new Map<string, DesignNote[]>();

  constructor(readonly ports: ExecutorPorts) {}

  /** The plan resolved against the palettes it is built with; null when the resolver is missing or fails. */
  resolve(palettes: PaletteCatalog, plan: MapPlan, version: number): ResolvedPlan | null {
    if (!this.ports.resolvePlan) return null;
    try {
      return this.ports.resolvePlan(plan, palettes, version);
    } catch {
      return null;
    }
  }

  /** Validation against the palettes the plan is built with, knowing the installed themes. */
  validateFor(ctx: AgentToolContext, input: unknown): ValidationResult {
    const themes = themesOf(ctx);
    return this.ports.validatePlan(
      input,
      themes ? { themes, palettes: ctx.palettes } : { palettes: ctx.palettes },
    );
  }

  /** All issues of a plan (blocking ones, playability findings, warnings, notes). */
  issuesOf(plan: MapPlan, ctx: AgentToolContext): PlanIssue[] {
    return this.validateFor(ctx, plan).issues;
  }

  /** The outline view ("" without the port). */
  outlineOf(
    palettes: PaletteCatalog,
    plan: MapPlan,
    version: number,
    levels?: LevelId[],
    issues?: readonly PlanIssue[],
  ): string {
    if (!this.ports.outline) return "";
    const opts: { version: number; levels?: LevelId[]; issues?: readonly PlanIssue[] } = { version };
    if (levels) opts.levels = levels;
    if (issues) opts.issues = issues;
    return this.ports.outline(plan, this.resolve(palettes, plan, version), opts);
  }
}

function themesOf(ctx: AgentToolContext): readonly string[] | undefined {
  return ctx.catalog.themes.length > 0 ? ctx.catalog.themes.map((t) => t.id) : undefined;
}
