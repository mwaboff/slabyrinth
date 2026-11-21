import type { MapPlan, PlanHistory, PlanRules, PlanVersion } from "@slabyrinth/core";
import * as core from "@slabyrinth/core/history";
import { AppFailure } from "../util/errors";

/**
 * Version history for ProjectService: thin, mutating wrappers over core's pure history module
 * (@slabyrinth/core/history), which owns the semantics (UX §7) and the keyframe rules (first version,
 * creates, restores, migrations, `materialize` ops, every 20th, and any ops version whose replay does
 * not reproduce the committed plan). Core failures become AppFailures.
 */
export const KEYFRAME_EVERY = core.KEYFRAME_INTERVAL;

export function emptyHistory(): PlanHistory {
  return core.createHistory();
}

export function findVersion(h: PlanHistory, n: number): PlanVersion {
  const v = core.getVersion(h, n);
  if (!v) throw new AppFailure("not_found", `Version ${String(n)} doesn't exist.`);
  return v;
}

export function nextNumber(h: PlanHistory): number {
  return core.latestNumber(h) + 1;
}

export interface NewVersionInput {
  plan: MapPlan;
  author: PlanVersion["author"];
  summary: string;
  changeSummary?: string[];
  cause: PlanVersion["cause"];
  messageId?: string;
  cost?: PlanVersion["cost"];
  createdAt?: string;
}

function assign(h: PlanHistory, next: PlanHistory): void {
  h.head = next.head;
  h.versions = next.versions;
  h.undone = next.undone;
  h.approvedVersion = next.approvedVersion;
}

/** Appends a version (mutates `h`), moves head to it. Returns the new version. */
export function commit(
  h: PlanHistory,
  input: NewVersionInput,
  rules: PlanRules,
  cache?: Map<number, MapPlan>,
): PlanVersion {
  const ci: core.CommitInput = {
    plan: input.plan,
    author: input.author,
    createdAt: input.createdAt ?? new Date().toISOString(),
    summary: input.summary,
    cause: input.cause,
  };
  if (input.changeSummary !== undefined) ci.changeSummary = input.changeSummary;
  if (input.messageId !== undefined) ci.messageId = input.messageId;
  if (input.cost !== undefined) ci.cost = input.cost;
  const r = core.commitVersion(h, ci, rules, cache);
  assign(h, r.history);
  return r.version;
}

export function undo(h: PlanHistory): number {
  const r = core.undo(h);
  if (!r.ok)
    throw new AppFailure(
      "validation",
      h.head === 0 ? "Nothing to undo." : "Nothing to undo: this is the first version.",
    );
  assign(h, r.history);
  return h.head;
}

export function redo(h: PlanHistory): number {
  const r = core.redo(h);
  if (!r.ok) throw new AppFailure("validation", "Nothing to redo.");
  assign(h, r.history);
  return h.head;
}

/**
 * Moves head back to `target`, an ancestor of head (Retry of a turn that made versions, architecture
 * §3.2): an undo of every version in between, each recorded in `undone` so redo still works.
 */
export function moveHeadBack(h: PlanHistory, target: number): number {
  if (target === h.head) return h.head;
  // target 0 = before the first version (no plan): Retry of the turn that drew the first plan.
  const path: number[] = [];
  let n = h.head;
  while (n !== target) {
    const cur = n === 0 ? undefined : core.getVersion(h, n);
    if (!cur)
      throw new AppFailure("validation", `v${String(target)} is not an earlier version of the current plan.`);
    path.push(cur.number);
    n = cur.parentNumber;
  }
  const gone = new Set(path);
  h.undone = [...h.undone.filter((n) => !gone.has(n)), ...path];
  h.head = target;
  return h.head;
}

/** Rebuilds version n from its nearest keyframe ancestor (core replay with the project's plan rules). */
export function reconstruct(
  h: PlanHistory,
  n: number,
  rules: PlanRules,
  cache?: Map<number, MapPlan>,
): MapPlan {
  const r = core.reconstruct(h, n, rules, cache);
  if (r.ok) return r.plan;
  if (r.error.code === "no_version") throw new AppFailure("not_found", `Version ${String(n)} doesn't exist.`);
  throw new AppFailure("internal", `Version ${String(n)} can't be rebuilt: ${r.error.message}.`);
}
