/**
 * An edit that is let through by plan/gate.ts: apply the ops WITHOUT validation (op errors still fail), validate the
 * result, and reject the edit (nothing changes) only on what blocks an edit. The GM's edits in the app and the
 * model's edit_plan both go through `gateApplied`, so they accept and refuse the same plans.
 */
import type { ApplyResult, PlanOp } from "../contracts/ops";
import type { MapPlan, PlanIssue } from "../contracts/plan";
import { planGate } from "../plan/gate";
import { validatePlan } from "../plan/validate";
import { applyOps, validateContextOf, type PlanRules } from "./apply";

/**
 * Gates an unvalidated apply: `validate` gives the new plan's issues. A refused edit returns `{ ok: false }` with the
 * blocking issues; an accepted one carries every issue that does not block (playability errors included), so the
 * caller can report them.
 */
export function gateApplied(r: ApplyResult, validate: (plan: MapPlan) => readonly PlanIssue[]): ApplyResult {
  if (!r.ok) return r;
  const issues = [...r.issues, ...validate(r.plan)];
  const { blocking } = planGate(issues, "edit");
  if (blocking.length > 0) return { ok: false, opErrors: [], issues: blocking };
  return { ...r, issues };
}

/**
 * applyOps for an edit, gated: the rules' checks validate the result at the rules' size tier (`themes`: the installed
 * themes, if known).
 */
export function applyChecked(
  plan: MapPlan,
  ops: readonly PlanOp[],
  rules: PlanRules,
  options: { themes?: readonly string[] } = {},
): ApplyResult {
  return gateApplied(
    applyOps(plan, ops, rules, { validate: false }),
    (p) => validatePlan(p, validateContextOf(rules, options.themes)).issues,
  );
}
