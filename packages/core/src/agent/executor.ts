/**
 * The tool executor (contract `ExecuteTool`): pure core code that turns one validated tool call into a
 * ToolOutcome. It never commits anything itself; the engine commits `newPlan` / `newBrief`.
 *
 * Every input is validated first (inputs.ts). Every rejection uses the §3.4 format and leaves the plan unchanged.
 * Geometry, text views and compile estimates come through injected ports so tests can use fakes; the defaults
 * (`defaultExecutorPorts`) are the real WP1/WP2 functions.
 */
import type { ApplyOps, DiffPlans } from "../contracts/ops";
import {
  DRESS_PRESETS,
  FEATURE_TYPES,
  GENERATOR_VERSION,
  MATERIALS,
  PLAN_SCHEMA,
  WALL_STYLES,
  type ElementId,
  type LevelId,
  type MapPlan,
  type PlanIssue,
  type ValidationResult,
} from "../contracts/plan";
import type { ResolvedPlan } from "../contracts/resolved";
import type { CompileDiagnostic, CompileEstimate } from "../contracts/compiler";
import { applyOps } from "../ops/apply";
import { diffPlans } from "../ops/diff";
import { listElements } from "../plan/elements";
import { validatePlan } from "../plan/validate";
import { resolvePlan } from "../resolve";
import { asciiView, changedRegionViews, outlineView } from "../text";
import { mergeBrief } from "./brief";
import { checksLine, issueWhere, splitIssues, type CheckResults } from "./checks";
import { invalidJsonRaw, validateToolInput, type ReportError } from "./inputs";
import { RESULT_VIEW_BUDGET, changeReportJson, clip, fromOpError, fromPlanIssue, rejection } from "./report";
import { isToolName } from "./serialize";
import type { PlanChangeReport, ToolContext, ToolName, ToolOutcome, ToolResultContent } from "./tools";

// ───────────────────────────── ports ─────────────────────────────

export interface ExecutorPorts {
  applyOps: ApplyOps;
  validatePlan: (input: unknown, ctx?: { themes?: readonly string[] }) => ValidationResult;
  diffPlans: DiffPlans;
  /** null: resolver unavailable (outline still works without resolved facts; ascii is unavailable). */
  resolvePlan: ((plan: MapPlan, version: number) => ResolvedPlan) | null;
  outline:
    | ((
        plan: MapPlan,
        resolved: ResolvedPlan | null,
        opts: { version?: number; levels?: LevelId[] },
      ) => string)
    | null;
  ascii:
    | ((
        resolved: ResolvedPlan,
        levelId: LevelId,
        opts: { region?: { x: number; y: number; w: number; h: number }; issues?: readonly PlanIssue[] },
      ) => string)
    | null;
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
  applyOps: (plan, ops) => applyOps(plan, ops, { validate: false }),
  validatePlan: (input, ctx) => validatePlan(input, ctx?.themes ? { themes: ctx.themes } : {}),
  diffPlans: (before, after) => diffPlans(before, after),
  resolvePlan: (plan, version) => resolvePlan(plan, { planVersion: version }),
  outline: (plan, resolved, opts) => outlineView(plan, resolved, opts),
  ascii: (resolved, levelId, opts) => {
    const o: { region?: { x: number; y: number; w: number; h: number }; issues?: readonly PlanIssue[] } = {};
    if (opts.region) o.region = opts.region;
    if (opts.issues) o.issues = opts.issues;
    return asciiView(resolved, levelId, o);
  },
  changedViews: (before, after, opts) => changedRegionViews(before, after, { maxChars: opts.maxChars }),
};

/**
 * The context the engine supplies: the contract's ToolContext plus
 *  - `nextVersion`: the number the next committed version will get (default head + 1);
 *  - `planAt`: lets stale_version report what changed since the model's base version.
 */
export interface AgentToolContext extends ToolContext {
  nextVersion?: number;
  planAt?: (version: number) => MapPlan | null;
}

export type AgentExecuteTool = (ctx: AgentToolContext, name: string, input: unknown) => Promise<ToolOutcome>;

// ───────────────────────────── helpers ─────────────────────────────

type ErrorEntry = Extract<ToolOutcome, { ok: false }>["errors"][number];

function fail(tool: string, version: number, errors: ReportError[], extra?: string): ToolOutcome {
  return {
    ok: false,
    content: rejection(tool, version, errors, extra),
    errors: errors.map((e): ErrorEntry => {
      const known = ["stale_version", "invalid_input", "no_plan", "plan_exists", "unavailable"] as const;
      const code = (known as readonly string[]).includes(e.code)
        ? (e.code as (typeof known)[number])
        : "invalid_input";
      const entry: ErrorEntry = { code, message: e.msg };
      if (e.hint !== undefined) entry.hint = e.hint;
      return entry;
    }),
  };
}

function textResult(text: string): ToolOutcome {
  return { ok: true, content: [{ type: "text", text }] };
}

function base64(bytes: Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      abc.charAt((n >> 18) & 63) +
      abc.charAt((n >> 12) & 63) +
      abc.charAt((n >> 6) & 63) +
      abc.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${abc.charAt((n >> 18) & 63)}${abc.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += `${abc.charAt((n >> 18) & 63)}${abc.charAt((n >> 12) & 63)}${abc.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

function themesOf(ctx: AgentToolContext): readonly string[] | undefined {
  return ctx.catalog.themes.length > 0 ? ctx.catalog.themes.map((t) => t.id) : undefined;
}

type ReportErr = NonNullable<PlanChangeReport["errors"]>[number];
type ReportWarning = NonNullable<PlanChangeReport["warnings"]>[number];

/** Budget for the issue-map block of a create/edit result. */
const ISSUE_VIEW_BUDGET = 3000;

function dedupeIssues(c: CheckResults): CheckResults {
  const uniq = (xs: PlanIssue[]): PlanIssue[] => {
    const seen = new Set<string>();
    return xs.filter((i) => {
      const k = JSON.stringify([i.code, i.message, i.elementId ?? null, i.cell ?? null]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { errors: uniq(c.errors), warnings: uniq(c.warnings), info: uniq(c.info) };
}

/** The playability findings, in full with hints (capped at 50 each), for the change report. */
function checkEntries(c: CheckResults): { errors: ReportErr[]; warnings: ReportWarning[] } {
  const msg = (i: PlanIssue): string => {
    const where = issueWhere(i);
    return where ? `${i.message} [${where}]` : i.message;
  };
  const errors = c.errors.slice(0, 50).map((i): ReportErr => {
    const e: ReportErr = { code: i.code, msg: msg(i) };
    if (i.path !== undefined) e.path = i.path;
    if (i.hint !== undefined) e.hint = i.hint;
    return e;
  });
  const warnings = c.warnings.slice(0, 50).map((i): ReportWarning => {
    const w: ReportWarning = { code: i.code, msg: msg(i) };
    if (i.elementId !== undefined) w.id = i.elementId;
    if (i.hint !== undefined) w.hint = i.hint;
    return w;
  });
  return { errors, warnings };
}

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

// ───────────────────────────── executor ─────────────────────────────

export function createToolExecutor(ports: ExecutorPorts = defaultExecutorPorts): AgentExecuteTool {
  const resolve = (plan: MapPlan, version: number): ResolvedPlan | null => {
    if (!ports.resolvePlan) return null;
    try {
      return ports.resolvePlan(plan, version);
    } catch {
      return null;
    }
  };

  /** The second block of a create/edit result: changed-region ASCII, degrading to an outline (§3.3 item 1). */
  const changeView = (
    before: MapPlan | null,
    after: MapPlan,
    version: number,
    dirtyLevels: LevelId[],
  ): string => {
    const prevResolved = before ? resolve(before, version - 1) : null;
    const nextResolved = resolve(after, version);
    if (nextResolved && ports.changedViews) {
      const r = ports.changedViews(prevResolved, nextResolved, { maxChars: RESULT_VIEW_BUDGET });
      if (r.fits && r.views.length > 0) return r.views.map((v) => v.text).join("\n");
    }
    if (ports.outline) {
      const levels = dirtyLevels.length > 0 ? dirtyLevels : after.levels.map((l) => l.id);
      return clip(ports.outline(after, nextResolved, { version, levels }), RESULT_VIEW_BUDGET);
    }
    return "";
  };

  /** All non-blocking issues of a plan (playability findings, warnings, notes). */
  const issuesOf = (plan: MapPlan, ctx: AgentToolContext): PlanIssue[] => {
    const themes = themesOf(ctx);
    return ports.validatePlan(plan, themes ? { themes } : {}).issues;
  };

  const outlineOf = (
    plan: MapPlan,
    version: number,
    levels?: LevelId[],
    issues?: readonly PlanIssue[],
  ): string => {
    if (!ports.outline) return "";
    const opts: { version: number; levels?: LevelId[]; issues?: readonly PlanIssue[] } = { version };
    if (levels) opts.levels = levels;
    if (issues) opts.issues = issues;
    return ports.outline(plan, resolve(plan, version), opts);
  };

  /** ASCII crops around the cells of error/warning findings, marked with "!" (third block of a create/edit result). */
  const issueMaps = (plan: MapPlan, version: number, c: CheckResults): string => {
    const flagged = [...c.errors, ...c.warnings].filter(
      (i) => i.cell !== undefined && i.levelId !== undefined,
    );
    if (flagged.length === 0 || !ports.ascii) return "";
    const resolved = resolve(plan, version);
    if (!resolved) return "";
    const out: string[] = [];
    let used = 0;
    for (const level of plan.levels) {
      const here = flagged.filter((i) => i.levelId === level.id);
      if (here.length === 0) continue;
      const xs = here.map((i) => i.cell?.[0] ?? 0);
      const ys = here.map((i) => i.cell?.[1] ?? 0);
      const b = level.bounds;
      const x0 = Math.max(b.x, Math.min(...xs) - 3);
      const y0 = Math.max(b.y, Math.min(...ys) - 3);
      const x1 = Math.min(b.x + b.w, Math.max(...xs) + 4);
      const y1 = Math.min(b.y + b.h, Math.max(...ys) + 4);
      const text = `ISSUES ON ${level.id} ("!" marks the cell):\n${ports.ascii(resolved, level.id, {
        region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        issues: here,
      })}`;
      if (used + text.length > ISSUE_VIEW_BUDGET) break;
      used += text.length;
      out.push(text);
    }
    return out.join("\n");
  };

  /** The content of an applied create/edit: report + CHECKS line, changed-region view, issue map. */
  const appliedContent = (
    report: PlanChangeReport,
    checks: CheckResults,
    before: MapPlan | null,
    after: MapPlan,
    dirtyLevels: LevelId[],
  ): ToolResultContent[] => {
    const entries = checkEntries(checks);
    const full: PlanChangeReport = { ...report, errors: entries.errors, warnings: entries.warnings };
    const content: ToolResultContent[] = [
      { type: "text", text: `${changeReportJson(full)}\n${checksLine(checks)}` },
    ];
    const view = changeView(before, after, report.version, dirtyLevels);
    if (view) content.push({ type: "text", text: view });
    const maps = issueMaps(after, report.version, checks);
    if (maps) content.push({ type: "text", text: maps });
    return content;
  };

  async function runUpdateBrief(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
    const v = validateToolInput("update_brief", input);
    if (!v.ok) return fail("update_brief", ctx.head, v.errors);
    const merged = mergeBrief(ctx.brief, v.value.set);
    const text =
      JSON.stringify({ status: "applied", updated: merged.updated, skipped: merged.skipped }) +
      (merged.skipped.length > 0
        ? `\nThe GM set ${merged.skipped.join(", ")} by hand; those were kept.`
        : "");
    return Promise.resolve({ ok: true, content: [{ type: "text", text }], newBrief: merged.brief });
  }

  function runAskQuestions(ctx: AgentToolContext, input: unknown): ToolOutcome {
    const v = validateToolInput("ask_questions", input);
    if (!v.ok) return fail("ask_questions", ctx.head, v.errors);
    const ids = v.value.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) {
      return fail("ask_questions", ctx.head, [
        {
          code: "invalid_input",
          path: "/questions",
          msg: "question ids must be unique",
          hint: 'use ids like "q1", "q2"',
        },
      ]);
    }
    return { ok: true, content: [], awaitUser: true };
  }

  function runCreatePlan(ctx: AgentToolContext, input: unknown): ToolOutcome {
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
    const themes = themesOf(ctx);
    const result = ports.validatePlan(candidate, themes ? { themes } : {});
    const split = splitIssues(result.issues);
    if (split.blocking.length > 0) {
      return fail(
        "create_plan",
        ctx.head,
        split.blocking.map((i) => fromPlanIssue(i, "/plan")),
      );
    }
    const plan = candidate as unknown as MapPlan;
    const version = ctx.nextVersion ?? ctx.head + 1;
    const report: PlanChangeReport = {
      status: "applied",
      version,
      added: listElements(plan).map((e) => e.id),
    };
    const content = appliedContent(
      report,
      split.checks,
      null,
      plan,
      plan.levels.map((l) => l.id),
    );
    const changes = v.value.changes ?? [];
    return { ok: true, content, newPlan: { plan, summary: v.value.summary, changes, cause: "create" } };
  }

  function runEditPlan(ctx: AgentToolContext, input: unknown): ToolOutcome {
    const v = validateToolInput("edit_plan", input);
    if (!v.ok) return fail("edit_plan", ctx.head, v.errors);
    if (ctx.plan === null) {
      return fail("edit_plan", 0, [
        { code: "no_plan", msg: "there is no plan yet", hint: "call create_plan for the first draft" },
      ]);
    }
    const { baseVersion, ops, summary, changes } = v.value;
    if (baseVersion !== ctx.head) {
      const base = ctx.planAt?.(baseVersion) ?? null;
      let extra = "";
      let affected: LevelId[] | undefined;
      if (base) {
        const d = ports.diffPlans(base, ctx.plan);
        const ids = [...d.added, ...d.changed, ...d.removed];
        const levels = [...new Set(ids.map((x) => x.levelId).filter((x): x is string => x !== undefined))];
        affected =
          levels.length > 0 ? levels.filter((l) => ctx.plan?.levels.some((pl) => pl.id === l)) : undefined;
        extra = `Changes since v${baseVersion}: ${
          ids.length === 0
            ? "none"
            : ids
                .slice(0, 30)
                .map((x) => x.id)
                .join(", ")
        }${ids.length > 30 ? ` (+${ids.length - 30} more)` : ""}.\n`;
      }
      extra += clip(outlineOf(ctx.plan, ctx.head, affected), RESULT_VIEW_BUDGET);
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
    const result = ports.applyOps(ctx.plan, ops);
    if (!result.ok) {
      const errors = [
        ...result.opErrors.map(fromOpError),
        ...result.issues.filter((i) => i.severity === "error").map((i) => fromPlanIssue(i)),
      ];
      if (errors.length === 0) errors.push({ code: "invalid_value", msg: "the edit was rejected" });
      return fail("edit_plan", ctx.head, errors);
    }
    // Structurally invalid results are rejected; playability findings are reported, never rejected.
    const split = splitIssues([...result.issues, ...issuesOf(result.plan, ctx)]);
    if (split.blocking.length > 0) {
      return fail(
        "edit_plan",
        ctx.head,
        split.blocking.map((i) => fromPlanIssue(i)),
      );
    }
    const version = ctx.nextVersion ?? ctx.head + 1;
    const report: PlanChangeReport = {
      status: "applied",
      version,
      added: result.changed.added,
      updated: result.changed.updated,
      removed: result.changed.removed,
    };
    const content = appliedContent(
      report,
      dedupeIssues(split.checks),
      ctx.plan,
      result.plan,
      result.dirtyLevels,
    );
    return { ok: true, content, newPlan: { plan: result.plan, summary, changes, cause: "ops", ops: ops } };
  }

  function runViewPlan(ctx: AgentToolContext, input: unknown): ToolOutcome {
    const v = validateToolInput("view_plan", input);
    if (!v.ok) return fail("view_plan", ctx.head, v.errors);
    const plan = ctx.plan;
    if (plan === null)
      return fail("view_plan", 0, [
        { code: "no_plan", msg: "there is no plan yet", hint: "call create_plan first" },
      ]);
    const { level, format, region, ids } = v.value;
    if (level !== undefined && !plan.levels.some((l) => l.id === level)) {
      return fail("view_plan", ctx.head, [
        {
          code: "unknown_level",
          path: "/level",
          msg: `no level "${level}"`,
          hint: `levels: ${plan.levels.map((l) => l.id).join(", ")}`,
        },
      ]);
    }
    const checks = splitIssues(issuesOf(plan, ctx)).checks;
    const flagged = [...checks.errors, ...checks.warnings, ...checks.info];
    if (format === "outline") {
      const text = outlineOf(plan, ctx.head, level !== undefined ? [level] : undefined, flagged);
      return textResult(text ? `${text}\n${checksLine(checks)}` : JSON.stringify(plan));
    }
    if (format === "ascii") {
      const resolved = resolve(plan, ctx.head);
      if (!resolved || !ports.ascii) {
        return fail("view_plan", ctx.head, [
          {
            code: "unavailable",
            msg: "the ascii view is not available right now",
            hint: 'use format "outline" or "json"',
          },
        ]);
      }
      const levelId = level ?? plan.levels[0]?.id ?? "";
      const opts: { region?: { x: number; y: number; w: number; h: number }; issues?: readonly PlanIssue[] } =
        {
          issues: flagged.filter((i) => i.severity !== "info"),
        };
      if (region) opts.region = region;
      return textResult(
        `PLAN v${ctx.head} level ${levelId}\n${ports.ascii(resolved, levelId, opts)}\n${checksLine(checks)}`,
      );
    }
    return textResult(
      clip(
        jsonView(plan, ctx.head, level, region, ids),
        30000,
        "… (truncated; ask for fewer ids or a smaller region)",
      ),
    );
  }

  async function runViewMapImage(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
    const v = validateToolInput("view_map_image", input);
    if (!v.ok) return fail("view_map_image", ctx.head, v.errors);
    if (ctx.renderImage === null) {
      return fail("view_map_image", ctx.head, [
        {
          code: "unavailable",
          msg: "map images are unavailable on this model",
          hint: 'use view_plan with format "ascii" instead',
        },
      ]);
    }
    const plan = ctx.plan;
    if (plan === null)
      return fail("view_map_image", 0, [
        { code: "no_plan", msg: "there is no plan yet", hint: "call create_plan first" },
      ]);
    if (!plan.levels.some((l) => l.id === v.value.level)) {
      return fail("view_map_image", ctx.head, [
        {
          code: "unknown_level",
          path: "/level",
          msg: `no level "${v.value.level}"`,
          hint: `levels: ${plan.levels.map((l) => l.id).join(", ")}`,
        },
      ]);
    }
    const bytes = await ctx.renderImage(v.value.level, v.value.region, v.value.showIds ?? true);
    return {
      ok: true,
      content: [
        { type: "text", text: `Map image of level ${v.value.level}, plan v${ctx.head}.` },
        { type: "image", mediaType: "image/png", dataBase64: base64(bytes) },
      ],
    };
  }

  async function runCompilePreview(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
    const v = validateToolInput("compile_preview", input);
    if (!v.ok) return fail("compile_preview", ctx.head, v.errors);
    const plan = ctx.plan;
    if (plan === null)
      return fail("compile_preview", 0, [
        { code: "no_plan", msg: "there is no plan yet", hint: "call create_plan first" },
      ]);
    const unknown = (v.value.levels ?? []).filter((l) => !plan.levels.some((pl) => pl.id === l));
    if (unknown.length > 0) {
      return fail("compile_preview", ctx.head, [
        {
          code: "unknown_level",
          path: "/levels",
          msg: `no level ${unknown.map((u) => `"${u}"`).join(", ")}`,
          hint: `levels: ${plan.levels.map((l) => l.id).join(", ")}`,
        },
      ]);
    }
    const est = await ctx.estimate(plan, v.value.levels);
    if (est === null) {
      return fail("compile_preview", ctx.head, [
        {
          code: "unavailable",
          msg: "the build estimate is not available right now",
          hint: "try again later",
        },
      ]);
    }
    return textResult(compilePreviewText(ctx.head, est));
  }

  function runListCatalog(ctx: AgentToolContext, input: unknown): ToolOutcome {
    const v = validateToolInput("list_catalog", input);
    if (!v.ok) return fail("list_catalog", ctx.head, v.errors);
    switch (v.value.what) {
      case "themes":
        return textResult(JSON.stringify({ themes: ctx.catalog.themes }));
      case "materials":
        return textResult(JSON.stringify({ materials: MATERIALS }));
      case "wall_styles":
        return textResult(JSON.stringify({ wall_styles: WALL_STYLES }));
      case "presets":
        return textResult(JSON.stringify({ presets: DRESS_PRESETS }));
      case "features": {
        const theme = v.value.theme;
        if (theme === undefined) return textResult(JSON.stringify({ features: FEATURE_TYPES }));
        if (!ctx.catalog.themes.some((t) => t.id === theme)) {
          return fail("list_catalog", ctx.head, [
            {
              code: "theme_unknown",
              path: "/theme",
              msg: `no installed theme "${theme}"`,
              hint: `themes: ${ctx.catalog.themes.map((t) => t.id).join(", ")}`,
            },
          ]);
        }
        const coverage = ctx.catalog.featureCoverage(theme);
        const withAssets = FEATURE_TYPES.filter((f) => coverage[f] === true);
        const without = FEATURE_TYPES.filter((f) => coverage[f] !== true);
        return textResult(JSON.stringify({ theme, withAssets, withoutAssets: without }));
      }
    }
  }

  return async (ctx, name, input) => {
    if (!isToolName(name)) {
      return fail(name, ctx.head, [
        {
          code: "invalid_input",
          msg: `there is no tool "${name}"`,
          hint: "use one of the tools you were given",
        },
      ]);
    }
    const raw = invalidJsonRaw(input);
    if (raw !== null) {
      // The skill's error result for unparseable tool input (eager input streaming).
      return {
        ok: false,
        content: [{ type: "text", text: JSON.stringify({ INVALID_JSON: raw }) }],
        errors: [
          {
            code: "invalid_input",
            message: "tool input was not valid JSON",
            hint: "send the complete input again",
          },
        ],
      };
    }
    const tool: ToolName = name;
    switch (tool) {
      case "update_brief":
        return runUpdateBrief(ctx, input);
      case "ask_questions":
        return runAskQuestions(ctx, input);
      case "create_plan":
        return runCreatePlan(ctx, input);
      case "edit_plan":
        return runEditPlan(ctx, input);
      case "view_plan":
        return runViewPlan(ctx, input);
      case "view_map_image":
        return runViewMapImage(ctx, input);
      case "compile_preview":
        return runCompilePreview(ctx, input);
      case "list_catalog":
        return runListCatalog(ctx, input);
    }
  };
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

/** json format of view_plan: selected elements, one level, or the whole plan. */
function jsonView(
  plan: MapPlan,
  version: number,
  level: LevelId | undefined,
  region: { x: number; y: number; w: number; h: number } | undefined,
  ids: ElementId[] | undefined,
): string {
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    const found: Record<string, unknown> = {};
    for (const l of plan.levels) {
      if (wanted.has(l.id))
        found[l.id] = {
          ...l,
          areas: undefined,
          openings: undefined,
          walls: undefined,
          features: undefined,
          terrain: undefined,
          labels: undefined,
        };
      for (const list of [l.areas, l.openings, l.walls, l.features, l.terrain, l.labels] as Array<
        Array<{ id: string }>
      >) {
        for (const e of list) if (wanted.has(e.id)) found[e.id] = { level: l.id, ...e };
      }
    }
    for (const link of plan.links) if (wanted.has(link.id)) found[link.id] = link;
    const missing = ids.filter((id) => !(id in found));
    return JSON.stringify({ version, elements: found, ...(missing.length > 0 ? { notFound: missing } : {}) });
  }
  const inRegion = (at: readonly [number, number]): boolean =>
    region === undefined ||
    (at[0] >= region.x && at[0] < region.x + region.w && at[1] >= region.y && at[1] < region.y + region.h);
  const levels = plan.levels
    .filter((l) => level === undefined || l.id === level)
    .map((l) =>
      region === undefined
        ? l
        : {
            ...l,
            features: l.features.filter((f) => inRegion(f.at)),
            labels: l.labels.filter((x) => inRegion(x.at)),
          },
    );
  if (level !== undefined) return JSON.stringify({ version, level: levels[0] });
  return JSON.stringify({ version, plan: { ...plan, levels } });
}

/** Default executor wired to the real core functions. */
export const executeTool: AgentExecuteTool = createToolExecutor();
