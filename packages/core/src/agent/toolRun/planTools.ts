/**
 * The tools that change the plan: create_plan (a whole plan, completed and validated) and edit_plan (ops on the head
 * version). Blocking issues reject the call; playability findings are reported, never rejected.
 */
import { GENERATOR_VERSION, PLAN_SCHEMA, type LevelId, type MapPlan } from "../../contracts/plan";
import { autoKeyRooms } from "../../ops/apply";
import { listElements } from "../../plan/elements";
import { splitIssues } from "../checks";
import { validateToolInput } from "../inputs";
import { RESULT_VIEW_BUDGET, clip, fromOpError, fromPlanIssue } from "../report";
import type { PlanChangeReport, ToolOutcome } from "../tools";
import { appliedContent, dedupeIssues } from "./applied";
import type { ToolRunCtx } from "./context";
import type { AgentToolContext } from "./ports";
import { fail, noPlan } from "./results";

/** A stale_version rejection names at most this many of the elements changed since the model's base version. */
const STALE_IDS_SHOWN = 30;

/** Fills the fields the app owns and the empty lists the JSON Schema lets the model omit. */
export function completeAuthoredPlan(
  authored: Record<string, unknown>,
  id: string,
  seed: number,
): Record<string, unknown> {
  const levels = Array.isArray(authored["levels"])
    ? (authored["levels"] as unknown[]).map((l) =>
        typeof l === "object" && l !== null && !Array.isArray(l)
          ? {
              areas: [],
              openings: [],
              walls: [],
              features: [],
              terrain: [],
              labels: [],
              ...(l as Record<string, unknown>),
            }
          : l,
      )
    : authored["levels"];
  const rest = { ...authored };
  delete rest["schema"];
  delete rest["generator"];
  delete rest["id"];
  return {
    schema: PLAN_SCHEMA,
    generator: GENERATOR_VERSION,
    id,
    ...rest,
    seed: typeof authored["seed"] === "number" ? authored["seed"] : seed,
    levels,
    links: authored["links"] ?? [],
  };
}

export function runCreatePlan(r: ToolRunCtx, ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("create_plan", input);
  if (!v.ok) return fail("create_plan", ctx.head, v.errors);
  if (ctx.plan !== null && !v.value.replace) {
    return fail("create_plan", ctx.head, [
      {
        code: "plan_exists",
        msg: `a plan already exists (v${ctx.head})`,
        hint: "change it with edit_plan; use replace: true only if the GM asked to start over",
      },
    ]);
  }
  const candidate = completeAuthoredPlan(v.value.plan, ctx.newPlanId(), ctx.newSeed());
  const split = splitIssues(r.validateFor(ctx, candidate).issues);
  if (split.blocking.length > 0) {
    return fail(
      "create_plan",
      ctx.head,
      split.blocking.map((i) => fromPlanIssue(i, "/plan")),
    );
  }
  // unnumbered rooms get numbers the way adding them with edit_plan would; numbers the model gave are kept
  const plan = autoKeyRooms(candidate as unknown as MapPlan);
  const report: PlanChangeReport = {
    status: "applied",
    version: ctx.nextVersion ?? ctx.head + 1,
    added: listElements(plan).map((e) => e.id),
  };
  const content = appliedContent(r, {
    palettes: ctx.palettes,
    report,
    checks: split.checks,
    before: null,
    after: plan,
    dirtyLevels: plan.levels.map((l) => l.id),
    brief: ctx.brief,
  });
  const changes = v.value.changes ?? [];
  return { ok: true, content, newPlan: { plan, summary: v.value.summary, changes, cause: "create" } };
}

export function runEditPlan(r: ToolRunCtx, ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("edit_plan", input);
  if (!v.ok) return fail("edit_plan", ctx.head, v.errors);
  if (ctx.plan === null) return noPlan("edit_plan", "call create_plan for the first draft");
  const { baseVersion, ops, summary, changes } = v.value;
  if (baseVersion !== ctx.head) return staleVersion(r, ctx, ctx.plan, baseVersion);
  const result = r.ports.applyOps(ctx.plan, ops, ctx.palettes);
  if (!result.ok) {
    const errors = [
      ...result.opErrors.map(fromOpError),
      ...result.issues.filter((i) => i.severity === "error").map((i) => fromPlanIssue(i)),
    ];
    if (errors.length === 0) errors.push({ code: "invalid_value", msg: "the edit was rejected" });
    return fail("edit_plan", ctx.head, errors);
  }
  // Structurally invalid results are rejected; playability findings are reported, never rejected.
  const split = splitIssues([...result.issues, ...r.issuesOf(result.plan, ctx)]);
  if (split.blocking.length > 0) {
    return fail(
      "edit_plan",
      ctx.head,
      split.blocking.map((i) => fromPlanIssue(i)),
    );
  }
  const report: PlanChangeReport = {
    status: "applied",
    version: ctx.nextVersion ?? ctx.head + 1,
    added: result.changed.added,
    updated: result.changed.updated,
    removed: result.changed.removed,
  };
  const content = appliedContent(r, {
    palettes: ctx.palettes,
    report,
    checks: dedupeIssues(split.checks),
    before: ctx.plan,
    after: result.plan,
    dirtyLevels: result.dirtyLevels,
    brief: ctx.brief,
  });
  return { ok: true, content, newPlan: { plan: result.plan, summary, changes, cause: "ops", ops: ops } };
}

/**
 * An edit against an older version: rejected with what changed since that version (when the engine can say) and the
 * outline of the levels it touched, so the model can re-check its edit against the head.
 */
function staleVersion(r: ToolRunCtx, ctx: AgentToolContext, head: MapPlan, baseVersion: number): ToolOutcome {
  const base = ctx.planAt?.(baseVersion) ?? null;
  let extra = "";
  let affected: LevelId[] | undefined;
  if (base) {
    const d = r.ports.diffPlans(base, head);
    const ids = [...d.added, ...d.changed, ...d.removed];
    const levels = [...new Set(ids.map((x) => x.levelId).filter((x): x is string => x !== undefined))];
    affected = levels.length > 0 ? levels.filter((l) => head.levels.some((pl) => pl.id === l)) : undefined;
    extra = `Changes since v${baseVersion}: ${
      ids.length === 0
        ? "none"
        : ids
            .slice(0, STALE_IDS_SHOWN)
            .map((x) => x.id)
            .join(", ")
    }${ids.length > STALE_IDS_SHOWN ? ` (+${ids.length - STALE_IDS_SHOWN} more)` : ""}.\n`;
  }
  extra += clip(r.outlineOf(ctx.palettes, head, ctx.head, affected), RESULT_VIEW_BUDGET);
  return fail(
    "edit_plan",
    ctx.head,
    [
      {
        code: "stale_version",
        msg: `baseVersion is ${baseVersion} but the current plan is v${ctx.head}`,
        hint: `re-check the elements you change against the outline below, then use baseVersion ${ctx.head}`,
      },
    ],
    extra,
  );
}
