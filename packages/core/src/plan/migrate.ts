/**
 * Migration framework (architecture §2.7 generator versioning, §6.4 read compatibility).
 *
 * - `runMigrations` is a generic, pure step runner: version N → N+1 → … → current, one function per step.
 * - Plans: schema "slabyrinth/plan@N". `migratePlan(json)` upgrades and then validates structurally.
 *   Today plan@1 is current, so PLAN_MIGRATIONS is empty; a future plan@2 adds one step here (and, if op semantics
 *   change, a `migrateOps` so stored op causes still replay).
 *   Generator changes never migrate geometry: a plan keeps its `generator` number so old maps never move.
 * - Projects: `migrateProject(json)` is the hook WP5's ProjectService calls on open. It upgrades `formatVersion`
 *   step by step (PROJECT_MIGRATIONS, empty for format 1) and runs `migratePlan` over the head plan and every
 *   history keyframe snapshot. Unknown keys (e.g. "x-*") are preserved: steps receive and return whole objects.
 */
import type { MapPlan, PlanIssue } from "../contracts/plan";
import { PLAN_SCHEMA } from "../contracts/plan";
import type { PlanOp } from "../contracts/ops";
import { parsePlan } from "./validate";

export type JsonObject = Record<string, unknown>;

export interface MigrationStep {
  /** Version this step upgrades FROM (to `from + 1`). */
  from: number;
  /** One line for logs and version summaries. */
  description: string;
  migrate(input: JsonObject): JsonObject;
}

export type MigrationError =
  | { code: "not_an_object"; message: string }
  | { code: "unknown_version"; message: string }
  | { code: "newer_version"; message: string; version: number; supported: number }
  | { code: "missing_step"; message: string; version: number };

export type RunMigrationsResult =
  | { ok: true; value: JsonObject; fromVersion: number; applied: string[] }
  | { ok: false; error: MigrationError };

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pure step runner. `versionOf` returns null when the input carries no recognizable version. */
export function runMigrations(
  input: unknown,
  opts: {
    current: number;
    steps: readonly MigrationStep[];
    versionOf: (obj: JsonObject) => number | null;
    stamp: (obj: JsonObject, version: number) => JsonObject;
  },
): RunMigrationsResult {
  if (!isObject(input))
    return { ok: false, error: { code: "not_an_object", message: "expected a JSON object" } };
  const start = opts.versionOf(input);
  if (start === null)
    return { ok: false, error: { code: "unknown_version", message: "no recognizable version field" } };
  if (start > opts.current) {
    return {
      ok: false,
      error: {
        code: "newer_version",
        message: `version ${start} is newer than supported ${opts.current}`,
        version: start,
        supported: opts.current,
      },
    };
  }
  let value = input;
  const applied: string[] = [];
  for (let v = start; v < opts.current; v++) {
    const step = opts.steps.find((s) => s.from === v);
    if (step === undefined)
      return {
        ok: false,
        error: { code: "missing_step", message: `no migration from version ${v}`, version: v },
      };
    value = opts.stamp(step.migrate(value), v + 1);
    applied.push(step.description);
  }
  return { ok: true, value, fromVersion: start, applied };
}

// ───────────────────────────── plans ─────────────────────────────

export interface PlanMigrationStep extends MigrationStep {
  /** Rewrites stored ops (history causes) whose meaning changed in this step. Identity when omitted. */
  migrateOps?: (ops: readonly unknown[]) => unknown[];
}

/** Version of the current plan schema ("slabyrinth/plan@1" → 1). */
export const CURRENT_PLAN_VERSION = 1;
export const PLAN_MIGRATIONS: readonly PlanMigrationStep[] = [];

/** "slabyrinth/plan@N" → N; anything else → null. */
export function planSchemaVersion(schema: unknown): number | null {
  if (typeof schema !== "string") return null;
  const m = /^slabyrinth\/plan@(\d+)$/.exec(schema);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

export type MigratePlanResult =
  | { ok: true; plan: MapPlan; migrated: boolean; fromSchema: string; applied: string[] }
  | { ok: false; error: MigrationError | { code: "invalid"; message: string; issues: PlanIssue[] } };

/** Upgrades plan JSON of any known schema version to the current one, then checks it structurally. */
export function migratePlan(
  json: unknown,
  steps: readonly PlanMigrationStep[] = PLAN_MIGRATIONS,
): MigratePlanResult {
  const run = runMigrations(json, {
    current: CURRENT_PLAN_VERSION,
    steps,
    versionOf: (o) => planSchemaVersion(o.schema),
    stamp: (o, v) => ({ ...o, schema: `slabyrinth/plan@${v}` }),
  });
  if (!run.ok) return { ok: false, error: run.error };
  const parsed = parsePlan(run.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "invalid", message: `plan does not match ${PLAN_SCHEMA}`, issues: parsed.issues },
    };
  }
  return {
    ok: true,
    plan: parsed.plan,
    migrated: run.applied.length > 0,
    fromSchema: `slabyrinth/plan@${run.fromVersion}`,
    applied: run.applied,
  };
}

/** Applies the `migrateOps` of every plan step from `fromVersion` on (for stored history causes). */
export function migratePlanOps(
  ops: readonly unknown[],
  fromVersion: number,
  steps: readonly PlanMigrationStep[] = PLAN_MIGRATIONS,
): PlanOp[] {
  let out: unknown[] = ops.slice();
  for (const s of steps) if (s.from >= fromVersion && s.migrateOps !== undefined) out = s.migrateOps(out);
  return out as PlanOp[];
}

// ───────────────────────────── projects ─────────────────────────────

export const CURRENT_PROJECT_VERSION = 1;
export const PROJECT_MIGRATIONS: readonly MigrationStep[] = [];

export type MigrateProjectResult =
  | { ok: true; project: JsonObject; migrated: boolean; fromVersion: number; applied: string[] }
  | {
      ok: false;
      error: MigrationError | { code: "invalid_plan"; message: string; path: string; issues: PlanIssue[] };
    };

/**
 * Hook for ProjectService (WP5): upgrades a parsed project file (formatVersion) and every plan inside it
 * (`plan`, `history.versions[i].snapshot`, and op causes). Returns a new object; the input is not mutated.
 */
export function migrateProject(
  json: unknown,
  opts: { steps?: readonly MigrationStep[]; planSteps?: readonly PlanMigrationStep[] } = {},
): MigrateProjectResult {
  const run = runMigrations(json, {
    current: CURRENT_PROJECT_VERSION,
    steps: opts.steps ?? PROJECT_MIGRATIONS,
    versionOf: (o) =>
      typeof o.formatVersion === "number" && Number.isInteger(o.formatVersion) ? o.formatVersion : null,
    stamp: (o, v) => ({ ...o, formatVersion: v }),
  });
  if (!run.ok) return { ok: false, error: run.error };
  const project: JsonObject = { ...run.value };
  const planSteps = opts.planSteps ?? PLAN_MIGRATIONS;
  const applied = [...run.applied];

  type Failed = Extract<MigrateProjectResult, { ok: false }>;
  const fix = (
    plan: unknown,
    path: string,
  ): { ok: true; plan: MapPlan; fromVersion: number } | { ok: false; result: Failed } => {
    const r = migratePlan(plan, planSteps);
    if (!r.ok) {
      const issues = r.error.code === "invalid" ? r.error.issues : [];
      return {
        ok: false,
        result: {
          ok: false,
          error: { code: "invalid_plan", message: `${path}: ${r.error.message}`, path, issues },
        },
      };
    }
    if (r.migrated) applied.push(`${path}: ${r.applied.join("; ")}`);
    return { ok: true, plan: r.plan, fromVersion: planSchemaVersion(r.fromSchema) ?? CURRENT_PLAN_VERSION };
  };

  if (project.plan !== null && project.plan !== undefined) {
    const r = fix(project.plan, "/plan");
    if (!r.ok) return r.result;
    project.plan = r.plan;
  }
  const history = project.history;
  if (isObject(history) && Array.isArray(history.versions)) {
    let planVersion = CURRENT_PLAN_VERSION;
    const versions: unknown[] = [];
    for (const [i, v] of (history.versions as unknown[]).entries()) {
      if (!isObject(v)) {
        versions.push(v);
        continue;
      }
      const nv: JsonObject = { ...v };
      if (v.snapshot !== undefined) {
        const r = fix(v.snapshot, `/history/versions/${i}/snapshot`);
        if (!r.ok) return r.result;
        nv.snapshot = r.plan;
        planVersion = r.fromVersion;
      }
      const cause = v.cause;
      if (
        isObject(cause) &&
        cause.type === "ops" &&
        Array.isArray(cause.ops) &&
        planVersion < CURRENT_PLAN_VERSION
      ) {
        nv.cause = { ...cause, ops: migratePlanOps(cause.ops as unknown[], planVersion, planSteps) };
      }
      versions.push(nv);
    }
    project.history = { ...history, versions };
  }
  return { ok: true, project, migrated: applied.length > 0, fromVersion: run.fromVersion, applied };
}
