import type { CompileDiagnostic } from "../../contracts/compiler";
import type { LevelId, MapPlan, PlanIssue } from "../../contracts/plan";

export interface VerifyOptions {
  /** Level the party enters on (MapPlan.entryLevel); default: plan/links.ts `entryLevelId` of the plan's levels. */
  entryLevelId?: LevelId;
  /** Apply safe automatic repairs (default true). */
  repair?: boolean;
  /** Plan-to-world orientation (default flipZ true, as in orientation.json). */
  flipZ?: boolean;
  /**
   * The plan. Reachability walks the resolver's WalkGraph either way (with the realized occupancy as `extraBlocked`);
   * the plan names the entry level and its levels. When given, problems the plan-level playability pass already
   * reports (`checkPlayability`, whose own errors propagate) are not reported a second time under a verify code.
   */
  plan?: MapPlan;
  /** Plan-level issues already reported (default: resolved.issues + checkPlayability(plan) when `plan` is set). */
  planIssues?: PlanIssue[];
}

export interface VerifyResult {
  diagnostics: CompileDiagnostic[];
  counts: { error: number; warning: number; info: number };
  repairs: number;
  /** Wall-clock time of the stage (ms), for the performance budget. */
  ms: number;
}
