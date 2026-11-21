import type { CompileDiagnostic } from "../../contracts/compiler";
import type { LevelId, MapPlan, PlanIssue } from "../../contracts/plan";

export interface VerifyOptions {
  /** Level the party enters on (MapPlan.entryLevel); default: the level with elevation closest to 0. */
  entryLevelId?: LevelId;
  /** Apply safe automatic repairs (default true). */
  repair?: boolean;
  /** Plan-to-world orientation (default flipZ true, as in orientation.json). */
  flipZ?: boolean;
  /**
   * The plan. When given, reachability reuses the resolver's WalkGraph (`walkReachability`) with the realized
   * occupancy as `extraBlocked`, and problems the plan-level playability pass already reports
   * (`checkPlayability`) are not reported a second time under a verify code.
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
