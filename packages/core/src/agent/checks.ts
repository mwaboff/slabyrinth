/**
 * Playability checks as the agent sees them (decisions.md "Playability validation").
 *
 * validatePlan reports two kinds of problems:
 *  - BLOCKING: structural or geometric errors that make the plan invalid (bad ids, a door with no shared wall, a
 *    feature inside rock, …). A create/edit that produces one is rejected and changes nothing.
 *  - CHECKS: playability findings (unreachable rooms, blocked doors, stairs with no landing, furniture plugging a
 *    corridor, …) at any severity, plus every non-error warning and info note. These never reject an edit — the
 *    model fixes them in steps — but every create/edit result reports them until they are resolved.
 */
import type { MapPlan, PlanIssue, PlanIssueCode, ValidationResult } from "../contracts/plan";
import { validatePlan } from "../plan/validate";
// Registers WP2's geometry + playability check with validatePlan (idempotent side-effect module).
import "../resolve/autoregister";

/** Issue codes that describe playability (walkability) rather than validity; never blocking. */
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

export function isBlocking(i: PlanIssue): boolean {
  return i.severity === "error" && !PLAYABILITY_CODES.has(i.code);
}

export interface CheckResults {
  errors: PlanIssue[];
  warnings: PlanIssue[];
  info: PlanIssue[];
}

export interface SplitIssues {
  /** Reject the change: nothing is applied. */
  blocking: PlanIssue[];
  /** Reported with the applied change. */
  checks: CheckResults;
}

export function splitIssues(issues: readonly PlanIssue[]): SplitIssues {
  const out: SplitIssues = { blocking: [], checks: { errors: [], warnings: [], info: [] } };
  for (const i of issues) {
    if (isBlocking(i)) out.blocking.push(i);
    else if (i.severity === "error") out.checks.errors.push(i);
    else if (i.severity === "warning") out.checks.warnings.push(i);
    else out.checks.info.push(i);
  }
  return out;
}

export function isClean(c: CheckResults): boolean {
  return c.errors.length === 0 && c.warnings.length === 0;
}

/** Where an issue is: "hall @4,5" (element id, cell). */
export function issueWhere(i: PlanIssue): string {
  const parts: string[] = [];
  if (i.elementId !== undefined) parts.push(i.elementId);
  if (i.cell !== undefined) parts.push(`@${i.cell[0]},${i.cell[1]}`);
  if (parts.length === 0 && i.levelId !== undefined) parts.push(`level ${i.levelId}`);
  return parts.join(" ");
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The one line that says whether the plan is clean, and what to do if not. */
export function checksLine(c: CheckResults): string {
  const notes =
    c.info.length > 0 ? ` Notes (info, no action needed unless unintended): ${summariseInfo(c.info)}.` : "";
  if (isClean(c)) return `CHECKS: clean — no playability errors or warnings.${notes}`;
  return (
    `CHECKS: NOT CLEAN — ${plural(c.errors.length, "error")}, ${plural(c.warnings.length, "warning")} (listed above with hints). ` +
    "The change was applied. Fix every error, and every warning that is a real mistake, with edit_plan; " +
    `tell the GM about anything you leave on purpose.${notes}`
  );
}

/** "reachable_secret_only ×1 (vault); opening_dead_end ×2 (d1, d2)". */
export function summariseInfo(info: readonly PlanIssue[]): string {
  const byCode = new Map<string, string[]>();
  for (const i of info) {
    const list = byCode.get(i.code) ?? [];
    list.push(issueWhere(i) || "-");
    byCode.set(i.code, list);
  }
  return [...byCode.entries()]
    .map(
      ([code, where]) =>
        `${code} ×${where.length} (${where.slice(0, 5).join(", ")}${where.length > 5 ? ", …" : ""})`,
    )
    .join("; ");
}

/** Outstanding-issue summary for the UI (engine guard): what is still wrong after a turn changed the plan. */
export interface OutstandingIssues {
  version: number;
  errors: number;
  warnings: number;
  /** Error-level issues first, then warnings; at most 20. */
  items: Array<Pick<PlanIssue, "severity" | "code" | "message" | "hint" | "elementId" | "levelId" | "cell">>;
}

export function checkPlan(
  plan: MapPlan,
  validate: (p: unknown) => ValidationResult = (p) => validatePlan(p),
): CheckResults {
  return splitIssues(validate(plan).issues).checks;
}

export function outstandingIssues(version: number, c: CheckResults): OutstandingIssues {
  const items = [...c.errors, ...c.warnings].slice(0, 20).map((i) => {
    const o: OutstandingIssues["items"][number] = { severity: i.severity, code: i.code, message: i.message };
    if (i.hint !== undefined) o.hint = i.hint;
    if (i.elementId !== undefined) o.elementId = i.elementId;
    if (i.levelId !== undefined) o.levelId = i.levelId;
    if (i.cell !== undefined) o.cell = i.cell;
    return o;
  });
  return { version, errors: c.errors.length, warnings: c.warnings.length, items };
}
