import { describe, expect, it } from "vitest";
import { migratePlan, migrateProject, planSchemaVersion, runMigrations } from "../../../src/plan";
import type { PlanMigrationStep } from "../../../src/plan";
import { commitVersion, createHistory } from "../../../src/history";
import { loadPlan } from "../../fixtures";

describe("migration framework", () => {
  it("parses plan schema versions", () => {
    expect(planSchemaVersion("slabyrinth/plan@1")).toBe(1);
    expect(planSchemaVersion("slabyrinth/plan@x")).toBeNull();
    expect(planSchemaVersion(3)).toBeNull();
  });

  it("current plans pass through unchanged", () => {
    const plan = loadPlan("example-b");
    const r = migratePlan(plan);
    expect(r).toMatchObject({ ok: true, migrated: false, fromSchema: "slabyrinth/plan@1" });
    expect(r.ok && r.plan).toEqual(plan);
  });

  it("rejects newer, unknown and structurally invalid plans", () => {
    expect(migratePlan({ ...loadPlan("cave"), schema: "slabyrinth/plan@9" })).toMatchObject({
      ok: false,
      error: { code: "newer_version", version: 9, supported: 1 },
    });
    expect(migratePlan({ schema: "other" })).toMatchObject({ ok: false, error: { code: "unknown_version" } });
    expect(migratePlan([])).toMatchObject({ ok: false, error: { code: "not_an_object" } });
    expect(migratePlan({ ...loadPlan("cave"), title: "" })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("runs steps in order and stamps versions (simulated plan@0 → plan@1)", () => {
    const plan = loadPlan("single-room");
    const old = { ...plan, schema: "slabyrinth/plan@0", name: plan.title } as Record<string, unknown>;
    delete old.title;
    const steps: PlanMigrationStep[] = [
      {
        from: 0,
        description: "rename name → title",
        migrate: (o) => {
          const { name, ...rest } = o;
          return { ...rest, title: name };
        },
        migrateOps: (ops) => ops.map((op) => ({ ...(op as object), migrated: true })),
      },
    ];
    const r = migratePlan(old, steps);
    expect(r).toMatchObject({
      ok: true,
      migrated: true,
      fromSchema: "slabyrinth/plan@0",
      applied: ["rename name → title"],
    });
    expect(r.ok && r.plan).toEqual(plan);
    expect(
      runMigrations({ v: 0 }, { current: 2, steps: [], versionOf: (o) => o.v as number, stamp: (o) => o }),
    ).toMatchObject({ ok: false, error: { code: "missing_step", version: 0 } });
  });

  it("migrateProject upgrades plans inside a project and preserves unknown keys", () => {
    const plan = loadPlan("single-room");
    const { history } = commitVersion(createHistory(), {
      plan,
      author: "ai",
      createdAt: "2026-11-18T00:00:00Z",
      summary: "Created",
      cause: { type: "create" },
    });
    const project = { formatVersion: 1, plan, history, "x-extra": { keep: true } };
    const r = migrateProject(project);
    expect(r).toMatchObject({ ok: true, migrated: false, fromVersion: 1 });
    expect(r.ok && r.project["x-extra"]).toEqual({ keep: true });
    expect(migrateProject({ ...project, formatVersion: 2 })).toMatchObject({
      ok: false,
      error: { code: "newer_version" },
    });
    const broken = {
      ...project,
      history: {
        ...history,
        versions: [{ ...history.versions[0], snapshot: { schema: "slabyrinth/plan@1" } }],
      },
    };
    expect(migrateProject(broken)).toMatchObject({
      ok: false,
      error: { code: "invalid_plan", path: "/history/versions/0/snapshot" },
    });
  });
});
