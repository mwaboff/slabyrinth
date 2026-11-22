import { applyOps, diffPlans, gateApplied, migrateProject, validatePlan } from "@slabyrinth/core";
import type { ApplyOps, DiffPlans, MapPlan, PlanIssue, PlanRules } from "@slabyrinth/core";

/**
 * Narrow port onto @slabyrinth/core's plan functions, injected into ProjectService. Production and the service tests
 * use the real core functions, with the rules of the palettes the app builds with (core
 * `planRules(buildPalettes.current())`); a test may replace the validator or the migration to steer a case.
 */
export interface PlanCorePort {
  /**
   * The current plan rules (the resolver's checks and the materialize generator for the build
   * palettes). History replay takes them: an op that removes generated features by their shown id
   * materializes them first.
   */
  rules(): PlanRules;
  /**
   * Applies ops WITHOUT validating the result (op errors still fail). Used for history replay, where
   * newer checks must not make old versions unreadable.
   */
  readonly applyOps: ApplyOps;
  /**
   * Applies ops for an EDIT through core's edit gate (`applyChecked`, the same one the model's edit_plan passes):
   * rejected (nothing changes) only on what blocks an edit; on success `issues` holds every non-blocking issue of the
   * new plan, playability errors included, so the renderer can show them.
   */
  readonly applyChecked: ApplyOps;
  /** Every issue of a plan, for the gates (core `planGate`). */
  validatePlan(plan: MapPlan): PlanIssue[];
  diffPlans: DiffPlans;
  /** Upgrades an older project JSON to the current format; null when it can't be migrated. */
  migrateProject(json: unknown): unknown;
}

/** Test doubles: a function replaces the core one; absent keys use core. */
export interface PlanCoreOverrides {
  validatePlan?: (plan: MapPlan) => PlanIssue[];
  migrateProject?: (json: unknown) => unknown;
}

/** `rules`: asked at each call, since the build palettes change (user palettes, the game's assets). */
export function createPlanCorePort(rules: () => PlanRules, overrides: PlanCoreOverrides = {}): PlanCorePort {
  const validate =
    overrides.validatePlan ?? ((plan: MapPlan): PlanIssue[] => validatePlan(plan, rules()).issues);
  const migrate =
    overrides.migrateProject ??
    ((json: unknown): unknown => {
      const r = migrateProject(json);
      return r.ok ? r.project : null;
    });
  const apply: ApplyOps = (plan, ops) => applyOps(plan, ops, rules(), { validate: false });
  return {
    rules,
    applyOps: apply,
    // core applyChecked, with this port's validator (the same one unless a test replaced it)
    applyChecked: (plan, ops) => gateApplied(apply(plan, ops), validate),
    validatePlan: validate,
    diffPlans: (before, after) => diffPlans(before, after),
    migrateProject: (json) => migrate(json) ?? null,
  };
}
