import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanCorePort } from "../ports/core";
import { doorPlan } from "./testing/fixtures";
import { BUNDLED_RULES, projectRig, type ProjectRig } from "./testing/helpers";

/**
 * Playability findings never reject a user edit (decisions.md "Playability validation"); only blocking
 * issues do. Uses the REAL core (applyOps, validatePlan with the resolver's playability check).
 */
const realCore = () => createPlanCorePort(() => BUNDLED_RULES);
let rig: ProjectRig | null = null;
afterEach(async () => {
  if (rig) {
    await rig.projects.close({}).catch(() => undefined);
    await fsp.rm(rig.dir, { recursive: true, force: true });
  }
  rig = null;
});

async function start(altar: [number, number]): Promise<ProjectRig> {
  rig = await projectRig({ core: realCore() });
  await rig.projects.create({ name: "Playability" });
  rig.projects.commitVersion({
    plan: doorPlan(altar),
    author: "ai",
    summary: "v1",
    cause: { type: "create" },
  });
  return rig;
}

const codes = (issues: Array<{ code: string }>): string[] => issues.map((i) => i.code);

describe("user edits and playability checks (real core)", () => {
  it("the fixture really has a pre-existing opening_blocked error", () => {
    const issues = realCore().validatePlan(doorPlan([7, 3])) ?? [];
    expect(issues.find((i) => i.code === "opening_blocked")?.severity).toBe("error");
  });

  it("a map with a pre-existing playability error accepts a rename and a notes edit (plan:applyOps and plan:editText)", async () => {
    const r = await start([7, 3]);
    const res = r.projects.applyOps({
      baseVersion: 1,
      label: "Rename",
      ops: [{ op: "update", id: "hall", set: { name: "Great Hall" } }],
    });
    expect(res.ok).toBe(true);
    expect(res.version).toBe(2);
    expect(codes(res.issues)).toContain("opening_blocked"); // reported, not rejected
    // Same element within 2 min: merged into v2 (UX text-edit rule); another element: new v3.
    expect(r.projects.editText({ id: "hall", set: { notes: "Echoes." } })).toEqual({ head: 2 });
    expect(r.projects.editText({ id: "entry", set: { name: "Porch" } })).toEqual({ head: 3 });
    const hall = r.projects.snapshot().plan?.levels[0]?.areas.find((a) => a.id === "hall");
    expect(hall).toMatchObject({ name: "Great Hall", notes: "Echoes." });
  });

  it("an op that introduces a playability error is applied and reported", async () => {
    const r = await start([10, 3]);
    expect(codes(realCore().validatePlan(doorPlan([10, 3])) ?? [])).not.toContain("opening_blocked");
    const res = r.projects.applyOps({
      baseVersion: 1,
      label: "Move altar",
      ops: [{ op: "move", ids: ["altar"], dx: -3, dy: 0 }],
    });
    expect(res.ok).toBe(true);
    expect(res.version).toBe(2);
    expect(res.ok && res.issues.find((i) => i.code === "opening_blocked")?.severity).toBe("error");
    expect(r.projects.snapshot().head).toBe(2);
  });

  it("an op that introduces a blocking error is rejected and changes nothing", async () => {
    const r = await start([7, 3]);
    const before = JSON.stringify(r.projects.snapshot().plan);
    const dangling = r.projects.applyOps({
      baseVersion: 1,
      label: "Bad door",
      ops: [
        {
          op: "add",
          element: {
            kind: "opening",
            level: "l1",
            value: { id: "d2", kind: "door", between: ["entry", "ghost"] },
          },
        },
      ],
    });
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      const all = [...dangling.opErrors.map((e) => e.code), ...codes(dangling.issues)];
      expect(all.length).toBeGreaterThan(0);
      expect(codes(dangling.issues)).not.toContain("opening_blocked"); // only blocking issues are returned
    }
    const unknown = r.projects.applyOps({
      baseVersion: 1,
      label: "Ghost",
      ops: [{ op: "update", id: "ghost", set: { name: "x" } }],
    });
    expect(unknown.ok).toBe(false);
    expect(() => r.projects.editText({ id: "ghost", set: { notes: "x" } })).toThrow();
    expect(r.projects.snapshot().head).toBe(1);
    expect(JSON.stringify(r.projects.snapshot().plan)).toBe(before);
  });

  it("history replay of an ops version on a map with playability errors still works", async () => {
    const r = await start([7, 3]);
    r.projects.applyOps({
      baseVersion: 1,
      label: "Rename",
      ops: [{ op: "update", id: "hall", set: { name: "Great Hall" } }],
    });
    r.projects.applyOps({
      baseVersion: 2,
      label: "Rename",
      ops: [{ op: "update", id: "entry", set: { name: "Porch" } }],
    });
    // v2 is not a keyframe: it is rebuilt by replaying its ops from v1.
    expect(r.projects.getVersion(2).levels[0]?.areas.find((a) => a.id === "hall")?.name).toBe("Great Hall");
    expect(r.projects.undo()).toEqual({ head: 2 });
  });
});
