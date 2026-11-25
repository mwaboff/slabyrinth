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
import type { CompileDiagnostic, CompileDiagnosticCode, PaletteCatalog } from "../../contracts/compiler";
import type { ResolvedPlan } from "../../contracts/resolved";
import { checkPlayability } from "../../resolve";
import { CHUNK_VERIFY_CODES } from "../chunk";
import { ARRANGEMENT_CODES, checkArrangementCap } from "./arrangements";
import type { RealizedSet } from "../realize/output";
import { checkCliffBand, CLIFF_CODES } from "./cliffs";
import { createVerifyCtx, type VerifiedSet, type VerifyCtx } from "./context";
import { checkMaterialFidelity, FIDELITY_CODES } from "./fidelity";
import { checkLevelAbove, LEVEL_ABOVE_CODES } from "./levelAbove";
import { LINE_CODES } from "./lines";
import { checkLinks, LINK_CODES } from "./links";
import { checkOpenFloor, OPEN_FLOOR_CODES } from "./openFloor";
import { checkOpenings, OPENING_CODES } from "./openings";
import type { VerifyOptions, VerifyResult } from "./options";
import { dropBadPlacements, indexSolids, PLACEMENT_CODES, recountStats } from "./placements";
import { checkProps, PROP_CODES } from "./props";
import { checkReachability, REACH_CODES } from "./reachability";
import { StairRuns } from "./runs";
import { checkCoveredStalls, STALL_CODES } from "./stalls";
import { checkFloorsAndWalls, WALL_CODES } from "./walls";

export type { VerifyOptions, VerifyResult } from "./options";

export function verifyBuild(
  resolved: ResolvedPlan,
  set: VerifiedSet,
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
  checkArrangementCap(ctx);

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
    (opts.plan ? [...resolved.issues, ...checkPlayability(opts.plan, resolved)] : resolved.issues);
  const planKeys = new Set(planIssues.map((i) => `${i.code}|${i.elementId ?? ""}`));
  const covered = (d: CompileDiagnostic): boolean =>
    (COVERED_BY_PLAN[d.code] ?? []).some((c) => planKeys.has(`${c}|${d.elementId ?? ""}`));
  const out = report.diagnostics;
  for (let i = out.length - 1; i >= 0; i--) {
    const d = out[i];
    if (d && covered(d)) out.splice(i, 1);
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

/**
 * Every verify code, in check order: the union of the lists each check file declares beside its header (and the chunk
 * stage's water note). A test reads the sources and the contract so a code emitted or declared but missing here fails.
 */
export const VERIFY_CODES: readonly CompileDiagnosticCode[] = [
  ...PLACEMENT_CODES,
  ...WALL_CODES,
  ...CLIFF_CODES,
  ...STALL_CODES,
  ...FIDELITY_CODES,
  ...OPEN_FLOOR_CODES,
  ...OPENING_CODES,
  ...LINK_CODES,
  ...PROP_CODES,
  ...LINE_CODES,
  ...LEVEL_ABOVE_CODES,
  ...REACH_CODES,
  ...ARRANGEMENT_CODES,
  ...CHUNK_VERIFY_CODES,
];

export type { RealizedSet };
