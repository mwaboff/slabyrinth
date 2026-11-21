/**
 * Verify stage (runs after realize, before chunk): checks the REALIZED tile set — real asset footprints, heights
 * and origins — against the resolved grid, so anything that is fine in the plan but wrong once real assets are
 * placed is caught at conversion. Returns structured diagnostics (stable code, severity, location, elements,
 * assets, plain message, plan-level hint). Safe repairs that do not change the design are applied and reported
 * as info diagnostics with `repaired` set. Never throws for bad content.
 *
 * This file is the order of the checks, which live beside it, one file per check; each file's header names what it
 * checks and the codes it emits. Every check reads the context (`VerifyCtx`, context.ts: the plan-wide inputs and the
 * one diagnostic writer) and the spatial index of the placements (`SolidIndex`, grid.ts); what a check finds for a later
 * one is returned and passed on read-only:
 *
 *   hand-off          made by                           read by
 *   SolidIndex        placements.ts indexSolids         every check (props.ts nudges move pieces in it)
 *   StairRuns         runs.ts                           checkLinks, checkReachability
 *   ObstructedCells   openFloor.ts checkOpenFloor       checkLinks, checkReachability
 *   BlockedOpenings   openings.ts checkOpenings         checkReachability
 *   LinkVerdicts      links.ts checkLinks               checkReachability
 *
 * Diagnostics keep the order the checks emit them in (then a stable sort by severity), and that order is part of the
 * output: a new check goes where its diagnostics should appear, and a check that only runs for some generators tests
 * its own switch on its first line.
 */
import type {
  CompileDiagnostic,
  CompileDiagnosticCode,
  PaletteCatalog,
  PlacementSet,
} from "../../contracts/compiler";
import type { MapPlan, PlanIssue } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import { checkPlayability } from "../../resolve";
import type { RealizedSet } from "../realize/output";
import { checkCliffBand } from "./cliffs";
import { createVerifyCtx, type VerifyCtx } from "./context";
import { checkMaterialFidelity } from "./fidelity";
import { checkLevelAbove } from "./levelAbove";
import { checkLinks } from "./links";
import { checkOpenFloor } from "./openFloor";
import { checkOpenings } from "./openings";
import type { VerifyOptions, VerifyResult } from "./options";
import { dropBadPlacements, indexSolids, recountStats } from "./placements";
import { checkProps } from "./props";
import { checkReachability } from "./reachability";
import { StairRuns } from "./runs";
import { checkCoveredStalls } from "./stalls";
import { checkFloorsAndWalls } from "./walls";

export type { VerifyOptions, VerifyResult } from "./options";

export function verifyBuild(
  resolved: ResolvedPlan,
  set: PlacementSet,
  palettes: PaletteCatalog,
  opts: VerifyOptions = {},
): VerifyResult {
  const t0 = Date.now();
  const ctx = createVerifyCtx(resolved, set, palettes, opts);

  // repairs first, then every measure is taken on what is left
  dropBadPlacements(ctx);
  const solids = indexSolids(ctx);
  const runs = new StairRuns(resolved.links);

  // structure and what the 2D map shows
  checkFloorsAndWalls(ctx, solids);
  checkCliffBand(ctx);
  checkCoveredStalls(ctx);
  checkMaterialFidelity(ctx);
  const obstructed = checkOpenFloor(ctx, solids);

  // ways through: doors, stairs and links
  const doors = checkOpenings(ctx, solids);
  const links = checkLinks(ctx, solids, runs, obstructed);

  // props, the level above, and whether every area is still reached
  checkProps(ctx, solids);
  checkLevelAbove(ctx, solids);
  checkReachability(ctx, { runs, obstructed, doors, links });

  dropCoveredByPlan(ctx);
  recountStats(set);
  return finish(ctx, t0);
}

/** verify code → plan-level code(s) that already describe the same problem for the same element. */
const COVERED_BY_PLAN: Partial<Record<CompileDiagnosticCode, readonly string[]>> = {
  verify_door_blocked: ["opening_blocked"],
  verify_door_leads_nowhere: ["opening_dead_end", "opening_blocked"],
  verify_stairs_approach_blocked: ["link_approach_blocked"],
  verify_stairs_arrival_blocked: ["link_blocked", "link_run_blocked"],
};

/** Problems the plan-level playability pass already reports are not repeated under a verify code. */
function dropCoveredByPlan({ opts, resolved, report }: VerifyCtx): void {
  const planIssues =
    opts.planIssues ??
    (opts.plan ? [...resolved.issues, ...safePlayability(opts.plan, resolved)] : resolved.issues);
  const planKeys = new Set(planIssues.map((i) => `${i.code}|${i.elementId ?? ""}`));
  const covered = (d: CompileDiagnostic): boolean =>
    (COVERED_BY_PLAN[d.code] ?? []).some((c) => planKeys.has(`${c}|${d.elementId ?? ""}`));
  const out = report.diagnostics;
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i];
    if (d && covered(d)) out.splice(i, 1);
  }
}

function safePlayability(plan: MapPlan, resolved: ResolvedPlan): PlanIssue[] {
  try {
    return checkPlayability(plan, resolved);
  } catch {
    return [];
  }
}

/** Errors first, then warnings, then info (a stable sort: each keeps the order it was emitted in). */
function finish({ report }: VerifyCtx, t0: number): VerifyResult {
  const out = report.diagnostics;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of out) counts[d.severity]++;
  return { diagnostics: out, counts, repairs: report.repairs, ms: Date.now() - t0 };
}

export const VERIFY_CODES: readonly CompileDiagnosticCode[] = [
  "verify_cell_obstructed",
  "verify_door_blocked",
  "verify_door_no_floor",
  "verify_door_missing",
  "verify_door_misplaced",
  "verify_door_buried",
  "verify_door_leads_nowhere",
  "verify_area_unreachable",
  "verify_stairs_no_arrival",
  "verify_stairs_approach_blocked",
  "verify_stairs_arrival_blocked",
  "verify_stairwell_closed",
  "verify_link_short",
  "verify_props_overlap",
  "verify_prop_in_wall",
  "verify_prop_nudged",
  "verify_prop_floating",
  "verify_prop_sunk",
  "verify_prop_no_floor",
  "verify_mount_no_wall",
  "verify_prop_outside",
  "verify_floor_missing",
  "verify_wall_gap",
  "verify_duplicate_removed",
  "verify_bad_coordinate",
  "verify_pokes_into_level_above",
  "verify_material_substituted",
  "verify_water_level",
];

export type { RealizedSet };
