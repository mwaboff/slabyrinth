import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { PlanOp } from "../../../src/contracts/ops";
import { STRUCTURAL_RULES, applyOps, diffPlans, summarizeDiff } from "../../../src/ops";
import { loadPlan } from "../../fixtures";

function edit(plan: MapPlan, ops: PlanOp[]): MapPlan {
  const r = applyOps(plan, ops, STRUCTURAL_RULES);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.plan;
}

describe("diffPlans", () => {
  it("identical plans have an empty diff", () => {
    const p = loadPlan("example-a");
    expect(diffPlans(p, loadPlan("example-a"))).toEqual({
      added: [],
      removed: [],
      changed: [],
      areas: { added: [], changed: [], removed: [] },
    });
  });

  it("null before: everything is added", () => {
    const d = diffPlans(null, loadPlan("two-rooms-door"));
    expect(d.added.map((e) => [e.id, e.kind, e.levelId])).toEqual([
      ["l1", "level", "l1"],
      ["front", "area", "l1"],
      ["back", "area", "l1"],
      ["door1", "opening", "l1"],
      ["bed", "feature", "l1"],
      ["rug", "feature", "l1"],
    ]);
    expect(d.areas.added).toEqual(["front", "back"]);
  });

  it("reports fields, moves between levels, order and meta; rolls up to rooms", () => {
    const before = loadPlan("example-a");
    const after = edit(before, [
      { op: "update", id: "hall", set: { notes: "new" } },
      { op: "update", id: "abbot", set: { label: "The Prior" } },
      { op: "remove", ids: ["bones1"] },
      {
        op: "add",
        element: { kind: "feature", level: "l2", value: { id: "skull", type: "bones", at: [5, 10] } },
      },
      { op: "reorder", id: "pool", index: 0 },
      { op: "set_meta", title: "Abbey" },
      { op: "update", id: "l1", set: { name: "Crypts" } },
    ]);
    const d = diffPlans(before, after);
    expect(d.added).toEqual([{ id: "skull", kind: "feature", levelId: "l2" }]);
    expect(d.removed).toEqual([{ id: "bones1", kind: "feature", levelId: "l1" }]);
    expect(d.changed).toEqual([
      { id: "l1", kind: "level", levelId: "l1", fields: ["name"] },
      { id: "hall", kind: "area", levelId: "l1", fields: ["notes"] },
      { id: "abbot", kind: "feature", levelId: "l1", fields: ["label"] },
      { id: "pool", kind: "terrain", levelId: "l2", fields: ["order"] },
      { id: "flood", kind: "terrain", levelId: "l2", fields: ["order"] },
      { id: before.id, kind: "meta", fields: ["title"] },
    ]);
    // abbot (15,6) is in the hall, bones1 (27,12) in the ossuary, skull (5,10) in the chapel.
    expect(d.areas).toEqual({ added: [], changed: ["hall", "ossuary", "chapel"], removed: [] });
    expect(summarizeDiff(d)).toBe("0 added · 3 changed · 0 removed");
  });

  it("uses a caller-provided containment function", () => {
    const before = loadPlan("single-room");
    const after = edit(before, [{ op: "update", id: "chest", set: { rot: 0 } }]);
    const d = diffPlans(before, after, { containingArea: () => "elsewhere" });
    expect(d.areas.changed).toEqual([]);
    expect(diffPlans(before, after).areas.changed).toEqual(["cellar"]);
  });

  it("detects elements moved to another level", () => {
    const before = loadPlan("multi-level-stairs");
    const after = edit(before, [{ op: "move", ids: ["statue"], dx: 0, dy: 0, toLevel: "study_lvl" }]);
    expect(diffPlans(before, after).changed).toEqual([
      { id: "statue", kind: "feature", levelId: "study_lvl", fields: ["level"] },
    ]);
  });
});
