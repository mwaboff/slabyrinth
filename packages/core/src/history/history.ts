/**
 * Plan version history (contracts/ops.ts PlanHistory; semantics: docs/ux-design.md §7, architecture §3.6).
 *
 * All functions are pure: they return a NEW PlanHistory and never mutate their input. Timestamps are passed in
 * (`createdAt`): core never reads the clock.
 *
 * Pointer semantics (UX §7.2):
 *  - Undo: head ← head.parentNumber; the left version is pushed onto `undone`. The first version (parent 0)
 *    cannot be undone.
 *  - Redo: head ← the most recently undone version whose parentNumber == head; it leaves `undone`.
 *  - A new version while head is back gets the next number with parentNumber = head; undone ones stay listed.
 *  - Restore vN creates a NEW version (cause restore, author "restore") whose content equals vN.
 *  - Approve moves the single approved pointer; it is independent of head.
 *
 * Storage: keyframe versions carry a full `snapshot`; the others store only their ops and are rebuilt by replaying
 * ops from the nearest keyframe ancestor. Keyframes: the first version, creates, restores, migrations, every 20th
 * version along a parent chain, any version whose ops contain `materialize` (it depends on the resolver), and any
 * version whose ops do not reproduce the committed plan when replayed.
 *
 * Replay applies ops without validating them, but an op that removes generated features by their shown id
 * ("rocks#5") materializes their op first, so the functions that replay take the caller's `PlanRules` (the
 * palettes the project builds with, as when the version was committed).
 */
import type { MapPlan } from "../contracts/plan";
import type { PlanIssue } from "../contracts/plan";
import type { OpError, PlanHistory, PlanOp, PlanVersion, VersionAuthor } from "../contracts/ops";
import { canonicalJson, cloneJson } from "../util/canonical";
import { applyOps, type PlanRules } from "../ops/apply";

/** A keyframe at least every KEYFRAME_INTERVAL versions along any parent chain. */
export const KEYFRAME_INTERVAL = 20;

export function createHistory(): PlanHistory {
  return { head: 0, versions: [], undone: [], approvedVersion: null };
}

export function getVersion(history: PlanHistory, n: number): PlanVersion | undefined {
  return history.versions.find((v) => v.number === n);
}

export function latestNumber(history: PlanHistory): number {
  return history.versions.reduce((m, v) => Math.max(m, v.number), 0);
}

/** The number the next committed version gets (numbers are never reused). */
export function nextVersionNumber(history: PlanHistory): number {
  return latestNumber(history) + 1;
}

export type HistoryError =
  | { code: "no_version"; message: string; number: number }
  | { code: "nothing_to_undo"; message: string }
  | { code: "nothing_to_redo"; message: string }
  | { code: "replay_failed"; message: string; number: number; opErrors: OpError[]; issues: PlanIssue[] }
  | { code: "corrupt"; message: string };

// ───────────────────────────── reconstruction ─────────────────────────────

export type ReconstructResult = { ok: true; plan: MapPlan } | { ok: false; error: HistoryError };

/** Optional memo shared across calls (number → plan). Plans in it must be treated as immutable. */
export type PlanCache = Map<number, MapPlan>;

/** Rebuilds the plan of version `n` from its nearest keyframe ancestor. */
export function reconstruct(
  history: PlanHistory,
  n: number,
  rules: PlanRules,
  cache?: PlanCache,
): ReconstructResult {
  const cached = cache?.get(n);
  if (cached !== undefined) return { ok: true, plan: cached };
  const chain: PlanVersion[] = [];
  const seen = new Set<number>();
  let cur = getVersion(history, n);
  if (cur === undefined)
    return { ok: false, error: { code: "no_version", message: `no version v${n}`, number: n } };
  let base: MapPlan | undefined;
  for (;;) {
    if (seen.has(cur.number))
      return { ok: false, error: { code: "corrupt", message: `parent cycle at v${cur.number}` } };
    seen.add(cur.number);
    const hit = cache?.get(cur.number);
    if (hit !== undefined) {
      base = hit;
      break;
    }
    if (cur.snapshot !== undefined) {
      base = cur.snapshot;
      cache?.set(cur.number, base);
      break;
    }
    chain.push(cur);
    const parentNumber = cur.parentNumber;
    cur = getVersion(history, parentNumber);
    if (cur === undefined) {
      return {
        ok: false,
        error: {
          code: "corrupt",
          message: `v${chain[chain.length - 1]?.number ?? n} has no keyframe ancestor (parent v${parentNumber} missing)`,
        },
      };
    }
  }
  let plan = base;
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = chain[i] as PlanVersion;
    if (v.cause.type !== "ops") {
      return {
        ok: false,
        error: { code: "corrupt", message: `v${v.number} (${v.cause.type}) has no snapshot` },
      };
    }
    const r = applyOps(plan, v.cause.ops, rules, { validate: false });
    if (!r.ok) {
      return {
        ok: false,
        error: {
          code: "replay_failed",
          message: `replaying v${v.number} failed`,
          number: v.number,
          opErrors: r.opErrors,
          issues: r.issues,
        },
      };
    }
    plan = r.plan;
    cache?.set(v.number, plan);
  }
  return { ok: true, plan };
}

/** Plan at head, or null when there is no version yet. */
export function headPlan(
  history: PlanHistory,
  rules: PlanRules,
  cache?: PlanCache,
): ReconstructResult | { ok: true; plan: null } {
  if (history.head === 0) return { ok: true, plan: null };
  return reconstruct(history, history.head, rules, cache);
}

/** Versions since the nearest keyframe along the parent chain of `n` (0 if `n` is a keyframe). */
function depthSinceKeyframe(history: PlanHistory, n: number): number {
  let depth = 0;
  let cur = getVersion(history, n);
  const seen = new Set<number>();
  while (cur !== undefined && cur.snapshot === undefined && !seen.has(cur.number)) {
    seen.add(cur.number);
    depth++;
    cur = getVersion(history, cur.parentNumber);
  }
  return depth;
}

// ───────────────────────────── commit ─────────────────────────────

export interface CommitInput {
  /** The new plan (already validated, e.g. ApplyResult.plan). */
  plan: MapPlan;
  author: VersionAuthor;
  createdAt: string;
  summary: string;
  changeSummary?: string[];
  cause: PlanVersion["cause"];
  messageId?: string;
  cost?: PlanVersion["cost"];
}

export interface CommitResult {
  history: PlanHistory;
  version: PlanVersion;
}

/**
 * Appends a new immutable version derived from the current head and moves head to it. `undone` is kept.
 * Ops-caused versions are verified by replay against the head plan; if replay does not reproduce `plan`
 * exactly, the version is stored as a keyframe so it can always be reconstructed.
 */
export function commitVersion(
  history: PlanHistory,
  input: CommitInput,
  rules: PlanRules,
  cache?: PlanCache,
): CommitResult {
  const number = nextVersionNumber(history);
  const parentNumber = history.head;
  const version: PlanVersion = {
    number,
    parentNumber,
    author: input.author,
    createdAt: input.createdAt,
    summary: input.summary,
    changeSummary: (input.changeSummary ?? []).slice(0, 6),
    cause: cloneJson(input.cause),
  };
  if (input.messageId !== undefined) version.messageId = input.messageId;
  if (input.cost !== undefined) version.cost = input.cost;
  if (needsKeyframe(history, version, input.plan, rules, cache)) version.snapshot = cloneJson(input.plan);
  cache?.set(number, input.plan);
  return {
    history: {
      ...history,
      head: number,
      versions: [...history.versions, version],
      undone: [...history.undone],
    },
    version,
  };
}

function needsKeyframe(
  history: PlanHistory,
  version: PlanVersion,
  plan: MapPlan,
  rules: PlanRules,
  cache?: PlanCache,
): boolean {
  if (version.parentNumber === 0 || version.cause.type !== "ops") return true;
  if (version.cause.ops.some((o) => o.op === "materialize")) return true;
  if (depthSinceKeyframe(history, version.parentNumber) + 1 >= KEYFRAME_INTERVAL) return true;
  const parent = reconstruct(history, version.parentNumber, rules, cache);
  if (!parent.ok) return true;
  const replay = applyOps(parent.plan, version.cause.ops, rules, { validate: false });
  return !replay.ok || canonicalJson(replay.plan) !== canonicalJson(plan);
}

/** Convenience: commit the result of applyOps on the head plan as an ops-caused version. */
export function commitOps(
  history: PlanHistory,
  plan: MapPlan,
  ops: PlanOp[],
  meta: Omit<CommitInput, "plan" | "cause">,
  rules: PlanRules,
  cache?: PlanCache,
): CommitResult {
  return commitVersion(history, { ...meta, plan, cause: { type: "ops", ops } }, rules, cache);
}

// ───────────────────────────── the GM's text edits ─────────────────────────────

/** UX §6.8: a text edit of the same element within this long joins the one before it. */
export const TEXT_EDIT_MERGE_MS = 2 * 60 * 1000;

/** The fields a GM text edit (plan:editText) may set. */
export const TEXT_EDIT_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "notes",
  "readAloud",
  "encounter",
  "label",
  "text",
  "description",
]);

type UpdateOp = Extract<PlanOp, { op: "update" }>;

export interface TextEditPlan {
  /** The one op to apply to the plan of `base`. */
  op: UpdateOp;
  /** The version the op applies to: head, or head's parent when the edit joins the head. */
  base: number;
  /** The version the edit replaces (commit with `supersedeHead`), or null for a plain new version. */
  supersedes: number | null;
}

/**
 * How a GM text edit (`set` of text fields on element `id`) is committed. It joins the head when the head is the GM's
 * own single-element text edit of the same element, is the latest version, is not approved, was made within
 * TEXT_EDIT_MERGE_MS of `nowMs`, and is not `pinned` (versions something outside history already refers to by number:
 * the version the model last saw, a build). Joined edits become one op on the head's parent, committed under a NEW
 * number by `supersedeHead`: a version number is never given to two different plans, so (plan id, version) stays an
 * identity for every cache, the thumbnail and the model's "last seen".
 */
export function textEditPlan(
  history: PlanHistory,
  edit: { id: string; set: Record<string, unknown> },
  nowMs: number,
  pinned: ReadonlySet<number>,
): TextEditPlan {
  const head = history.head === 0 ? undefined : getVersion(history, history.head);
  const prev = head?.cause.type === "ops" && head.cause.ops.length === 1 ? head.cause.ops[0] : undefined;
  const joins =
    head !== undefined &&
    head.author === "user" &&
    head.number === latestNumber(history) &&
    history.approvedVersion !== head.number &&
    !pinned.has(head.number) &&
    prev?.op === "update" &&
    prev.id === edit.id &&
    nowMs - Date.parse(head.createdAt) <= TEXT_EDIT_MERGE_MS;
  if (!joins)
    return { op: { op: "update", id: edit.id, set: { ...edit.set } }, base: history.head, supersedes: null };
  return {
    op: { op: "update", id: edit.id, set: { ...prev.set, ...edit.set } },
    base: head.parentNumber,
    supersedes: head.number,
  };
}

/**
 * Commits `input` in place of the head version: the new version takes the next number and the head's parent, and the
 * old head (the latest version, which no other version descends from) is dropped. Nothing is renumbered or rewritten.
 */
export function supersedeHead(
  history: PlanHistory,
  input: CommitInput,
  rules: PlanRules,
  cache?: PlanCache,
): CommitResult {
  const old = getVersion(history, history.head);
  if (old === undefined) return commitVersion(history, input, rules, cache);
  const r = commitVersion({ ...history, head: old.parentNumber }, input, rules, cache);
  cache?.delete(old.number);
  return {
    history: { ...r.history, versions: r.history.versions.filter((v) => v.number !== old.number) },
    version: r.version,
  };
}

// ───────────────────────────── pointers ─────────────────────────────

export type PointerResult =
  { ok: true; history: PlanHistory; from: number; to: number } | { ok: false; error: HistoryError };

export function canUndo(history: PlanHistory): boolean {
  const head = getVersion(history, history.head);
  return head !== undefined && head.parentNumber !== 0;
}

/** The version redo would move to, or undefined. */
export function redoTarget(history: PlanHistory): number | undefined {
  for (let i = history.undone.length - 1; i >= 0; i--) {
    const n = history.undone[i] as number;
    if (getVersion(history, n)?.parentNumber === history.head) return n;
  }
  return undefined;
}

export function canRedo(history: PlanHistory): boolean {
  return redoTarget(history) !== undefined;
}

export function undo(history: PlanHistory): PointerResult {
  const head = getVersion(history, history.head);
  if (head === undefined || head.parentNumber === 0) {
    return {
      ok: false,
      error: {
        code: "nothing_to_undo",
        message: head === undefined ? "there is no plan yet" : `v${head.number} is the first version`,
      },
    };
  }
  return {
    ok: true,
    from: head.number,
    to: head.parentNumber,
    history: {
      ...history,
      head: head.parentNumber,
      undone: [...history.undone.filter((n) => n !== head.number), head.number],
    },
  };
}

export function redo(history: PlanHistory): PointerResult {
  const target = redoTarget(history);
  if (target === undefined)
    return {
      ok: false,
      error: { code: "nothing_to_redo", message: `nothing to redo from v${history.head}` },
    };
  return {
    ok: true,
    from: history.head,
    to: target,
    history: { ...history, head: target, undone: history.undone.filter((n) => n !== target) },
  };
}

/**
 * Moves head back to `target`, an ancestor of head (0 = before the first version, no plan): Retry of a turn that made
 * versions (architecture §3.2). Recorded as an undo of every version in between, each pushed onto `undone` (oldest
 * last) so Redo can bring the discarded turn back.
 */
export function moveHeadBack(history: PlanHistory, target: number): PointerResult {
  const path: number[] = [];
  let n = history.head;
  while (n !== target) {
    const cur = n === 0 ? undefined : getVersion(history, n);
    if (cur === undefined)
      return {
        ok: false,
        error: {
          code: "no_version",
          message: `v${target} is not an earlier version of v${history.head}`,
          number: target,
        },
      };
    path.push(cur.number);
    n = cur.parentNumber;
  }
  if (path.length === 0) return { ok: true, history, from: history.head, to: target };
  const gone = new Set(path);
  return {
    ok: true,
    from: history.head,
    to: target,
    history: { ...history, head: target, undone: [...history.undone.filter((u) => !gone.has(u)), ...path] },
  };
}

export type RestoreResult =
  | { ok: true; history: PlanHistory; version: PlanVersion; plan: MapPlan }
  | { ok: false; error: HistoryError };

/** Restore vN: a NEW version (keyframe) equal to vN, summary "Restored vN". */
export function restore(
  history: PlanHistory,
  n: number,
  createdAt: string,
  rules: PlanRules,
  cache?: PlanCache,
): RestoreResult {
  const r = reconstruct(history, n, rules, cache);
  if (!r.ok) return r;
  const { history: h, version } = commitVersion(
    history,
    {
      plan: r.plan,
      author: "restore",
      createdAt,
      summary: `Restored v${n}`,
      changeSummary: [],
      cause: { type: "restore", from: n },
    },
    rules,
    cache,
  );
  return { ok: true, history: h, version, plan: r.plan };
}

/** Moves the approved pointer (null clears it). */
export function approve(
  history: PlanHistory,
  n: number | null,
): { ok: true; history: PlanHistory } | { ok: false; error: HistoryError } {
  if (n !== null && getVersion(history, n) === undefined)
    return { ok: false, error: { code: "no_version", message: `no version v${n}`, number: n } };
  return { ok: true, history: { ...history, approvedVersion: n } };
}

/** UI row for the History panel (newest first). */
export interface VersionRow {
  version: PlanVersion;
  isHead: boolean;
  isUndone: boolean;
  isApproved: boolean;
}

export function listVersions(history: PlanHistory): VersionRow[] {
  const undone = new Set(history.undone);
  return [...history.versions]
    .sort((a, b) => b.number - a.number)
    .map((version) => ({
      version,
      isHead: version.number === history.head,
      isUndone: undone.has(version.number),
      isApproved: version.number === history.approvedVersion,
    }));
}

/**
 * Structural invariants (for project open): unique increasing numbers, parents earlier and present, head/undone/
 * approved present, undone excludes head, every version reachable to a keyframe. Returns problems (empty = ok).
 */
export function checkHistory(history: PlanHistory): string[] {
  const problems: string[] = [];
  const nums = new Set<number>();
  let prev = 0;
  for (const v of history.versions) {
    if (!Number.isInteger(v.number) || v.number < 1) problems.push(`invalid version number ${v.number}`);
    if (nums.has(v.number)) problems.push(`duplicate version v${v.number}`);
    if (v.number <= prev) problems.push(`versions out of order at v${v.number}`);
    prev = Math.max(prev, v.number);
    nums.add(v.number);
    if (v.parentNumber !== 0 && (!nums.has(v.parentNumber) || v.parentNumber >= v.number))
      problems.push(`v${v.number} has invalid parent v${v.parentNumber}`);
    if (v.parentNumber === 0 && v.snapshot === undefined)
      problems.push(`v${v.number} is a root without snapshot`);
    if (v.cause.type !== "ops" && v.snapshot === undefined)
      problems.push(`v${v.number} (${v.cause.type}) has no snapshot`);
  }
  if (history.head !== 0 && !nums.has(history.head)) problems.push(`head v${history.head} does not exist`);
  if (history.head === 0 && history.versions.length > 0) problems.push("head is 0 but versions exist");
  for (const u of history.undone) {
    if (!nums.has(u)) problems.push(`undone v${u} does not exist`);
    if (u === history.head) problems.push(`head v${u} is marked undone`);
  }
  if (history.approvedVersion !== null && !nums.has(history.approvedVersion))
    problems.push(`approved v${history.approvedVersion} does not exist`);
  return problems;
}
