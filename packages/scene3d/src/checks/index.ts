/**
 * Scene checks (design §2.6): general measurements over the scene's real geometry that report faults as data, so a
 * test or the coding assistant finds them without looking at a picture. Each check is a rule over parts and plan data,
 * never a kind of thing: it means the same on a ship, a house, a cart or something nobody has built yet. The grid-level
 * checks (core verify) already hold the plan's boxes; these hold the meshes.
 *
 * The order of the list is the order of the findings.
 */
import type { Scene } from "../types/index";
import { clashCheck } from "./clash";
import { facingCheck } from "./facing";
import { shellGapCheck } from "./gaps";
import type { PlanFacts } from "./plan";
import { SceneSpace } from "./space";
import { floatingCheck, sunkCheck } from "./support";
import { deckHoleCheck, floorOverOpenCheck, roofOpenCheck } from "./surfaces";
import type { CheckCode, Finding, SceneCheck } from "./types";
import { wayBlockedCheck } from "./ways";

export const SCENE_CHECKS: readonly SceneCheck[] = [
  shellGapCheck,
  deckHoleCheck,
  floorOverOpenCheck,
  roofOpenCheck,
  floatingCheck,
  sunkCheck,
  clashCheck,
  facingCheck,
  wayBlockedCheck,
];

export interface CheckReport {
  findings: Finding[];
  /** Milliseconds per check (and "space": building the hash). */
  ms: Record<string, number>;
  /** Checks skipped because the scene has no plan (a bare slab). */
  skipped: CheckCode[];
}

/** Runs the checks (all, or `only`) over a scene; `plan` is what the build planned (null for a slab). */
export function runChecks(
  scene: Scene,
  plan: PlanFacts | null,
  o: { only?: readonly CheckCode[]; now?: () => number } = {},
): CheckReport {
  const now = o.now ?? (() => 0);
  const t0 = now();
  const space = new SceneSpace(scene);
  const ms: Record<string, number> = { space: Math.round(now() - t0) };
  const findings: Finding[] = [];
  const skipped: CheckCode[] = [];
  for (const c of SCENE_CHECKS) {
    if (o.only && !o.only.includes(c.code)) continue;
    if (c.needsPlan && !plan) {
      skipped.push(c.code);
      continue;
    }
    const t = now();
    for (const f of c.run({ scene, space, plan })) findings.push(f);
    ms[c.code] = Math.round(now() - t);
  }
  return { findings, ms, skipped };
}

export { CHECK_CODES } from "./types";
export type { CheckCode, CheckInput, Finding, FindingPiece, SceneCheck, Severity } from "./types";
export { CHECK_THRESHOLDS } from "./thresholds";
export { planFacts } from "./plan";
export type { ObjectPlan, PlanBoundary, PlanCell, PlanFacts, PlanObject, PlanPassage } from "./plan";
export { SceneSpace } from "./space";
export type { Hit } from "./space";
export { clusterFindings, clusterShot, markedPicture } from "./mark";
export type { FindingCluster } from "./mark";
export { compareFindings, findingKey } from "./compare";
export type { FindingsDiff } from "./compare";
