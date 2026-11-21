/**
 * The one answer to "may this plan go on?" (decisions.md "Playability validation", UX §7.5). Every place that lets a
 * plan through — an edit by the model or the GM, the GM's approval, a build in the app or the CLI — asks `planGate`
 * with its purpose, so the rule lives here and nowhere else.
 *
 * validatePlan reports two kinds of problems:
 *  - STRUCTURAL errors (bad ids, a door with no shared wall, a feature inside rock, …): the plan is invalid.
 *  - PLAYABILITY findings (codes in PLAYABILITY_CODES: unreachable rooms, blocked doors, stairs with no landing, …)
 *    at any severity, plus every warning and info note.
 *
 * What blocks, by purpose:
 *  - "edit": structural errors only. Playability is fixed in steps (the model is told after each change, the GM
 *    sees it on the map), so a half-finished plan must stay editable.
 *  - "build": structural errors only, like an edit. The compiler needs a valid plan; whether the GM wants to play a
 *    plan with a dead-end room is a decision approval already took, and a rebuild must not be refused because a
 *    later check (or a palette change) finds something new.
 *  - "approve": every error, playability included, and every `unreachable` finding whatever its severity. Approval
 *    is the GM saying "this is the map to play"; UX §7.5 lists unreachable rooms as blocking, and architecture.md's
 *    validation rules escalate `unreachable` to blocking at approval. This is the only purpose stricter than an edit.
 */
import type { PlanIssue, PlanIssueCode } from "../contracts/plan";

/** Issue codes that describe playability (walkability) rather than validity. */
export const PLAYABILITY_CODES: ReadonlySet<PlanIssueCode> = new Set<PlanIssueCode>([
  "unreachable",
  "area_sealed",
  "opening_blocked",
  "opening_dead_end",
  "reachable_secret_only",
  "link_approach_blocked",
  "link_run_blocked",
  "passage_blocked",
  "feature_not_at_wall",
  "seat_detached",
  "route_dead_end",
]);

/** Why a plan is being let through (see the header for what each one blocks). */
export type GatePurpose = "edit" | "approve" | "build";

/** Issue codes approval refuses at any severity (on top of every error). */
const APPROVE_BLOCKS_ANY_SEVERITY: ReadonlySet<PlanIssueCode> = new Set<PlanIssueCode>(["unreachable"]);

/**
 * What the gate reads of an issue: its severity and code. A caller holding a slimmer copy of the issues (the app's
 * renderer gets them without hints) asks the same gate with what it has.
 */
export type GatedIssue = Pick<PlanIssue, "severity" | "code">;

/** Whether one issue stops a plan going on for `purpose`. */
export function isBlocking(i: GatedIssue, purpose: GatePurpose): boolean {
  if (purpose === "approve") return i.severity === "error" || APPROVE_BLOCKS_ANY_SEVERITY.has(i.code);
  return i.severity === "error" && !PLAYABILITY_CODES.has(i.code);
}

export interface CheckResults<I extends GatedIssue = PlanIssue> {
  errors: I[];
  warnings: I[];
  info: I[];
}

export interface PlanGate<I extends GatedIssue = PlanIssue> {
  /** Stop: the change is not applied, the plan is not approved, the build does not run. */
  blocking: I[];
  /** Everything else, by severity: reported with the plan that went on. */
  checks: CheckResults<I>;
}

/** Splits a plan's issues into what blocks `purpose` and what is only reported. Order is kept. */
export function planGate<I extends GatedIssue>(issues: readonly I[], purpose: GatePurpose): PlanGate<I> {
  const out: PlanGate<I> = { blocking: [], checks: { errors: [], warnings: [], info: [] } };
  for (const i of issues) {
    if (isBlocking(i, purpose)) out.blocking.push(i);
    else if (i.severity === "error") out.checks.errors.push(i);
    else if (i.severity === "warning") out.checks.warnings.push(i);
    else out.checks.info.push(i);
  }
  return out;
}
