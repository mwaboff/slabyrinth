import { applyOps, diffPlans, isBlocking, migrateProject, splitIssues, validatePlan } from "@slabyrinth/core";
import type { ApplyOps, DiffPlans, MapPlan, PlanIssue } from "@slabyrinth/core";
// (The root entry also registers the resolver's geometric checks that validatePlan runs.)

/**
 * Narrow port onto @slabyrinth/core's plan functions, injected into ProjectService so service
 * tests can substitute doubles. Production always uses the real core functions.
 */
export interface PlanCorePort {
  /**
   * Applies ops WITHOUT validating the result (op errors still fail). Used for history replay, where
   * newer checks must not make old versions unreadable. null only in tests that exercise "no plan
   * engine" behaviour (UI edits refused with "unsupported").
   */
  readonly applyOps: ApplyOps | null;
  /**
   * Applies ops for an EDIT, with the same split as the agent's executor (decisions.md "Playability
   * validation"): apply without validation, validate the result, reject (nothing changes) only on
   * blocking issues (core `isBlocking`: error severity outside the playability codes). On success,
   * `issues` holds every non-blocking issue of the new plan, playability errors included, so the
   * renderer can show them. null when applyOps is null.
   */
  readonly applyChecked: ApplyOps | null;
  /** Validation issues; null when a test double provides no validator. */
  validatePlan(plan: MapPlan): PlanIssue[] | null;
  diffPlans: DiffPlans;
  /** Upgrades an older project JSON to the current format; null when it can't be migrated. */
  migrateProject(json: unknown): unknown;
}

type Override<F> = F | null;

/** Test doubles: a function replaces the core one, `null` removes it; absent keys use core. */
export interface PlanCoreOverrides {
  applyOps?: Override<ApplyOps>;
  validatePlan?: Override<(plan: MapPlan) => unknown>;
  migrateProject?: Override<(json: unknown) => unknown>;
}

export function createPlanCorePort(overrides: PlanCoreOverrides = {}): PlanCorePort {
  const apply: ApplyOps | null =
    overrides.applyOps === undefined
      ? (plan, ops) => applyOps(plan, ops, { validate: false })
      : overrides.applyOps;
  const validate =
    overrides.validatePlan === undefined
      ? (plan: MapPlan): unknown => validatePlan(plan)
      : overrides.validatePlan;
  const migrate =
    overrides.migrateProject === undefined
      ? (json: unknown): unknown => migrateProject(json)
      : overrides.migrateProject;
  const validateIssues = (plan: MapPlan): PlanIssue[] | null => {
    if (!validate) return null;
    const r = validate(plan);
    if (Array.isArray(r)) return r as PlanIssue[];
    if (typeof r === "object" && r !== null && Array.isArray((r as { issues?: unknown }).issues)) {
      return (r as { issues: PlanIssue[] }).issues;
    }
    return null;
  };
  const applyChecked: ApplyOps | null = apply
    ? (plan, ops) => {
        const r = apply(plan, ops);
        if (!r.ok) return r;
        const issues = validateIssues(r.plan) ?? r.issues;
        const { blocking } = splitIssues(issues);
        if (blocking.length > 0) return { ok: false, opErrors: [], issues: blocking };
        return { ...r, issues: issues.filter((i) => !isBlocking(i)) };
      }
    : null;
  return {
    applyOps: apply,
    applyChecked,
    validatePlan: validateIssues,
    diffPlans: (before, after) => diffPlans(before, after),
    migrateProject(json) {
      if (!migrate) return null;
      const r = migrate(json);
      // core returns { ok, project } (MigrateProjectResult); test doubles may return a bare object.
      if (typeof r === "object" && r !== null && "ok" in r) {
        const res = r as { ok: boolean; project?: unknown };
        return res.ok ? (res.project ?? null) : null;
      }
      return r ?? null;
    },
  };
}
