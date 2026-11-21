/** Geometric validation (§2.8) and the rules callers pass to validatePlan and applyOps (planRules). */
import { describe, expect, it, vi } from "vitest";
import type { MapPlan, PlanIssueCode } from "../../../src/contracts/plan";
import { applyOps } from "../../../src/ops/index";
import { bundledPalettes } from "../../../src/palette/index";
import { STRUCTURE_ONLY, validatePlan } from "../../../src/plan/index";
import { geometryChecks, materializeOp, planRules, resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures/index";

const codes = (plan: MapPlan): Array<[string, PlanIssueCode, string | undefined]> =>
  geometryChecks(plan, bundledPalettes()).map((i) => [i.severity, i.code, i.elementId]);

describe("geometry checks", () => {
  it("all shared fixtures pass without errors", () => {
    for (const n of [
      "example-a",
      "example-b",
      "single-room",
      "two-rooms-door",
      "l-corridor-route",
      "multi-level-stairs",
      "outdoor-scatter",
    ] as const) {
      expect(
        geometryChecks(loadPlan(n), bundledPalettes()).filter((i) => i.severity === "error"),
        n,
      ).toEqual([]);
    }
  });

  it("feature on rock → feature_blocked with the nearest free spot", () => {
    const p = loadPlan("single-room");
    p.levels[0]?.features.push({ id: "lost", type: "barrel", at: [0, 0] });
    const is = geometryChecks(p, bundledPalettes()).find((i) => i.elementId === "lost");
    expect(is).toMatchObject({ severity: "error", code: "feature_blocked", cell: [0, 0] });
    expect(is?.hint).toMatch(/nearest free spot is \[2,2\]/);
  });

  it("two blocking features on one cell → feature_overlap", () => {
    const p = loadPlan("single-room");
    p.levels[0]?.features.push({ id: "dup", type: "crate", at: [8, 2] });
    expect(codes(p)).toContainEqual(["error", "feature_overlap", "dup"]);
  });

  it("wall-mounted feature without a wall → feature_blocked", () => {
    const p = loadPlan("single-room");
    p.levels[0]?.features.push({ id: "t2", type: "torch_wall", at: [5, 5], wall: "N" });
    expect(codes(p)).toContainEqual(["error", "feature_blocked", "t2"]);
  });

  it("opening between areas that do not touch → opening_no_boundary with nearest cells", () => {
    const p = loadPlan("l-corridor-route");
    p.levels[0]?.openings.push({ id: "far", kind: "door", between: ["west", "east"] });
    const is = geometryChecks(p, bundledPalettes()).find((i) => i.elementId === "far");
    expect(is?.code).toBe("opening_no_boundary");
    expect(is?.hint).toMatch(/nearest cells are/);
  });

  it("two openings on one edge → opening_overlap", () => {
    const p = loadPlan("two-rooms-door");
    p.levels[0]?.openings.push({ id: "door2", kind: "archway", between: ["front", "back"] });
    expect(codes(p)).toContainEqual(["error", "opening_overlap", "door2"]);
  });

  it("stairs that leave the room → link_blocked", () => {
    const p = loadPlan("multi-level-stairs");
    const link = p.links[0];
    if (!link) throw new Error("link");
    link.from.at = [7, 2];
    delete link.to.at;
    expect(codes(p).filter((c) => c[1] === "link_blocked").length).toBeGreaterThan(0);
  });

  it("a keyed room with no way in → area_sealed error (not also unreachable)", () => {
    const p = loadPlan("two-rooms-door");
    const lvl = p.levels[0];
    if (!lvl) throw new Error("level");
    lvl.openings = [];
    const issues = geometryChecks(p, bundledPalettes());
    expect(issues.find((i) => i.code === "area_sealed")).toMatchObject({
      severity: "error",
      elementId: "back",
    });
    expect(issues.some((i) => i.code === "unreachable")).toBe(false);
  });

  it("area covered by a later area → area_empty; split area → area_disconnected", () => {
    const p = loadPlan("single-room");
    p.levels[0]?.areas.unshift({
      id: "under",
      kind: "room",
      shape: { type: "rect", x: 3, y: 3, w: 2, h: 2 },
    });
    p.levels[0]?.areas.push({
      id: "wall_cut",
      kind: "room",
      walls: "perimeter",
      shape: { type: "rect", x: 5, y: 2, w: 1, h: 6 },
    });
    const c = codes(p);
    expect(c).toContainEqual(["error", "area_empty", "under"]);
    expect(c).toContainEqual(["warning", "area_disconnected", "cellar"]);
  });

  it("never throws on odd but structurally valid plans", () => {
    const p = loadPlan("example-a");
    const lvl = p.levels[0];
    if (!lvl) throw new Error("level");
    lvl.bounds = { x: 0, y: 0, w: 4, h: 4 };
    expect(() => geometryChecks(p, bundledPalettes())).not.toThrow();
  });
});

describe("planRules: the resolver's rules, passed to validatePlan and applyOps", () => {
  const lostBarrel = (): MapPlan => {
    const p = loadPlan("single-room");
    p.levels[0]?.features.push({ id: "lost", type: "barrel", at: [0, 0] });
    return p;
  };

  it("validatePlan runs the geometry check it is given, and only then", () => {
    const res = validatePlan(lostBarrel(), planRules(bundledPalettes()));
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "feature_blocked" && i.elementId === "lost")).toBe(true);
    expect(validatePlan(lostBarrel(), STRUCTURE_ONLY).ok).toBe(true);
  });

  it("validatePlan and applyOps answer the same whatever else the process imported", async () => {
    // The checks used to be registered process-wide as a side effect of importing the core entry, so the same
    // call answered differently before and after that import. Load plan and ops on their own, ask, load the core
    // entry, ask again.
    vi.resetModules();
    const plan = await import("../../../src/plan/index");
    const ops = await import("../../../src/ops/index");
    const ask = () => ({
      structure: plan.validatePlan(lostBarrel(), plan.STRUCTURE_ONLY),
      materialize: ops.applyOps(
        loadPlan("example-a"),
        [{ op: "materialize", id: "rocks" }],
        ops.STRUCTURAL_RULES,
      ),
    });
    const alone = ask();
    await import("../../../src/index");
    expect(ask()).toEqual(alone);
    expect(alone.structure.ok).toBe(true);
    expect(alone.materialize).toMatchObject({ ok: false, opErrors: [{ code: "not_applicable" }] });
  });

  it("materialize turns generated features into explicit ones that resolve identically", () => {
    const plan = loadPlan("example-a");
    const direct = materializeOp(plan, "l2", "rocks", bundledPalettes());
    expect(direct.ok).toBe(true);
    const before = resolvePlan(plan, bundledPalettes())
      .levels.find((l) => l.id === "l2")
      ?.features.filter((f) => f.generatedBy === "rocks");
    const res = applyOps(plan, [{ op: "materialize", id: "rocks" }], planRules(bundledPalettes()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const after = resolvePlan(res.plan, bundledPalettes())
      .levels.find((l) => l.id === "l2")
      ?.features.filter((f) => f.id.startsWith("rocks_"));
    expect(after?.map((f) => [f.type, f.at, f.size])).toEqual(before?.map((f) => [f.type, f.at, f.size]));
  });

  it("materialize refuses non-generating ops", () => {
    expect(materializeOp(loadPlan("example-a"), "l2", "flood", bundledPalettes()).ok).toBe(false);
  });
});
