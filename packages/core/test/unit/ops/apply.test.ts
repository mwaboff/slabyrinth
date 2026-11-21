import { describe, expect, it } from "vitest";
import type { Area, Level, MapPlan } from "../../../src/contracts/plan";
import type { ApplyResult, PlanOp } from "../../../src/contracts/ops";
import { STRUCTURAL_RULES, applyOps, renumberLevelOrder, type PlanRules } from "../../../src/ops";
import { canonicalJson } from "../../../src/util";
import { loadPlan } from "../../fixtures";

type Ok = Extract<ApplyResult, { ok: true }>;
type Fail = Extract<ApplyResult, { ok: false }>;

function ok(plan: MapPlan, ops: PlanOp[], rules: PlanRules = STRUCTURAL_RULES): Ok {
  const r = applyOps(plan, ops, rules);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
  return r;
}
function fail(plan: MapPlan, ops: unknown[]): Fail {
  const before = canonicalJson(plan);
  const r = applyOps(plan, ops as PlanOp[], STRUCTURAL_RULES);
  if (r.ok) throw new Error("expected failure");
  expect(canonicalJson(plan)).toBe(before); // input never mutated
  return r;
}
const area = (p: MapPlan, id: string): Area | undefined =>
  p.levels.flatMap((l) => l.areas).find((a) => a.id === id);

describe("add", () => {
  it("adds an area with an automatic key that continues across levels", () => {
    const plan = loadPlan("example-a");
    const r = ok(plan, [
      {
        op: "add",
        element: {
          kind: "area",
          level: "l2",
          value: { id: "vault", kind: "room", shape: { type: "rect", x: 2, y: 18, w: 4, h: 4 } },
        },
      },
      {
        op: "add",
        element: {
          kind: "area",
          level: "l1",
          value: { id: "nook", kind: "zone", shape: { type: "rect", x: 9, y: 7, w: 2, h: 2 } },
        },
      },
      {
        op: "add",
        element: {
          kind: "area",
          level: "l1",
          value: { id: "cell", kind: "cave", shape: { type: "rect", x: 1, y: 15, w: 3, h: 3 } },
          index: 0,
        },
      },
    ]);
    expect(area(r.plan, "vault")?.key).toBe("8");
    expect(area(r.plan, "nook")?.key).toBeUndefined();
    expect(area(r.plan, "cell")?.key).toBe("9");
    expect(r.plan.levels[0]?.areas[0]?.id).toBe("cell");
    expect(r.changed).toEqual({ added: ["vault", "nook", "cell"], updated: [], removed: [] });
    expect(r.dirtyLevels).toEqual(["l1", "l2"]);
    expect(area(plan, "vault")).toBeUndefined();
  });

  it("adds every element kind including a level with contents and a link", () => {
    const plan = loadPlan("multi-level-stairs");
    const r = ok(plan, [
      {
        op: "add",
        element: {
          kind: "level",
          value: {
            id: "cellar",
            name: "Cellar",
            elevation: -2.5,
            bounds: { x: 0, y: 0, w: 10, h: 10 },
            base: { type: "solid" },
            areas: [{ id: "cellar_room", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 8, h: 8 } }],
          },
        },
      },
      {
        op: "add",
        element: {
          kind: "opening",
          level: "ground",
          value: { id: "win", kind: "window", at: { x: 1, y: 3, side: "W" } },
        },
      },
      {
        op: "add",
        element: {
          kind: "wall_run",
          level: "ground",
          value: {
            id: "screen",
            op: "add",
            points: [
              [4, 1],
              [4, 3],
            ],
          },
        },
      },
      {
        op: "add",
        element: { kind: "feature", level: "ground", value: { id: "chest2", type: "chest", at: [3, 2] } },
      },
      {
        op: "add",
        element: {
          kind: "terrain",
          level: "ground",
          value: { id: "rugs", op: "dress", area: "foyer", preset: "library" },
        },
      },
      {
        op: "add",
        element: { kind: "label", level: "ground", value: { id: "lbl", text: "Hall", at: [5, 5] } },
      },
      {
        op: "add",
        element: {
          kind: "link",
          value: {
            id: "down",
            kind: "ladder",
            from: { level: "cellar", at: [2, 2] },
            to: { level: "ground" },
          },
        },
      },
      {
        op: "add_features",
        level: "study_lvl",
        features: [
          { id: "b2", type: "bookshelf", at: [2, 1] },
          { id: "b3", type: "bookshelf", at: [3, 1] },
        ],
      },
    ]);
    expect(r.plan.levels.map((l) => l.id)).toEqual(["ground", "study_lvl", "roof", "cellar"]);
    expect(area(r.plan, "cellar_room")?.key).toBe("4");
    expect(r.changed.added).toEqual([
      "cellar",
      "cellar_room",
      "win",
      "screen",
      "chest2",
      "rugs",
      "lbl",
      "down",
      "b2",
      "b3",
    ]);
  });

  it("rejects duplicate ids and unknown levels with hints, committing nothing", () => {
    const plan = loadPlan("two-rooms-door");
    const r = fail(plan, [
      {
        op: "add",
        element: { kind: "feature", level: "l1", value: { id: "front", type: "chest", at: [2, 2] } },
      },
      {
        op: "add",
        element: { kind: "feature", level: "l9", value: { id: "c9", type: "chest", at: [2, 2] } },
      },
      {
        op: "add_features",
        level: "l1",
        features: [
          { id: "x1", type: "chest", at: [2, 2] },
          { id: "x1", type: "crate", at: [3, 2] },
        ],
      },
    ]);
    expect(r.opErrors).toEqual([
      expect.objectContaining({
        opIndex: 0,
        code: "duplicate_id",
        path: "/ops/0/element/value/id",
        hint: expect.stringContaining('"front_2"') as string,
      }),
      expect.objectContaining({
        opIndex: 1,
        code: "unknown_level",
        path: "/ops/1/element/level",
        hint: expect.stringContaining('did you mean "l1"') as string,
      }),
      expect.objectContaining({ opIndex: 2, code: "duplicate_id", path: "/ops/2/features/1/id" }),
    ]);
  });
});

describe("update / reshape / set_meta", () => {
  it("shallow-merges, deletes optional fields with null, replaces nested objects", () => {
    const plan = loadPlan("example-a");
    const r = ok(plan, [
      {
        op: "update",
        id: "hall",
        set: { name: "Hall of Monks", notes: null, shape: { type: "rect", x: 8, y: 6, w: 16, h: 7 } },
      },
      { op: "update", id: "l2", set: { name: "The Cistern" } },
      { op: "update", id: "stair_main", set: { label: null } },
      { op: "reshape", id: "guard", shape: { type: "rect", x: 1, y: 7, w: 5, h: 5 } },
      { op: "set_meta", title: "Abbey", summary: null, seed: 5 },
    ]);
    const hall = area(r.plan, "hall");
    expect(hall?.name).toBe("Hall of Monks");
    expect(hall && "notes" in hall).toBe(false);
    expect(hall?.shape).toEqual({ type: "rect", x: 8, y: 6, w: 16, h: 7 });
    expect(r.plan.levels[1]?.name).toBe("The Cistern");
    expect(r.plan.links[0] && "label" in r.plan.links[0]).toBe(false);
    expect(r.plan.title).toBe("Abbey");
    expect("summary" in r.plan).toBe(false);
    expect(r.changed.updated).toEqual(["hall", "l2", "stair_main", "guard"]);
    expect(r.dirtyLevels).toEqual(["l1", "l2"]); // seed change dirties every level
  });

  it("guards immutable fields, required fields, level contents and bad values", () => {
    const plan = loadPlan("example-a");
    const r = fail(plan, [
      { op: "update", id: "hall", set: { id: "hall2" } },
      { op: "update", id: "hall", set: { kind: "cave" } },
      { op: "update", id: "flood", set: { op: "noise" } },
      { op: "update", id: "l1", set: { areas: [] } },
      { op: "update", id: "hall", set: { shape: null } },
      { op: "update", id: "hall", set: { floorheight: 1 } },
      { op: "update", id: "hal", set: { name: "x" } },
      { op: "reshape", id: "p1", shape: { type: "rect", x: 1, y: 1, w: 1, h: 1 } },
    ]);
    expect(r.opErrors.map((e) => [e.opIndex, e.code])).toEqual([
      [0, "immutable_field"],
      [1, "immutable_field"],
      [2, "immutable_field"],
      [3, "not_applicable"],
      [4, "invalid_value"],
      [5, "invalid_value"],
      [6, "unknown_id"],
      [7, "wrong_kind"],
    ]);
    expect(r.opErrors[4]?.message).toMatch(/required/);
    expect(r.opErrors[5]?.hint).toContain('did you mean "floorHeight"');
    expect(r.opErrors[6]?.hint).toBe('did you mean "hall"? areas on l1: entry, hall, guard, ossuary, c1, c2');
  });
});

describe("remove (cascades)", () => {
  it("removing an area removes its between-openings and dress ops", () => {
    const plan = loadPlan("example-a");
    const r = ok(plan, [{ op: "remove", ids: ["ossuary"] }]);
    expect(r.changed.removed).toEqual(["ossuary", "d_secret"]);
    const r2 = ok(plan, [{ op: "remove", ids: ["guard", "c2"] }]);
    expect(r2.changed.removed).toEqual(["guard", "dress_guard", "c2"]);
  });

  it("keepDependents leaves dependents (validation then reports the dangling refs)", () => {
    const r = fail(loadPlan("example-a"), [{ op: "remove", ids: ["ossuary"], keepDependents: true }]);
    expect(r.opErrors).toEqual([]);
    expect(r.issues).toEqual([expect.objectContaining({ code: "ref_unknown", elementId: "d_secret" })]);
  });

  it("refuses to orphan a route corridor", () => {
    const r = fail(loadPlan("example-a"), [{ op: "remove", ids: ["guard"] }]);
    expect(r.opErrors[0]).toMatchObject({
      code: "not_applicable",
      path: "/ops/0/ids/0",
      hint: expect.stringContaining('also remove "c2"') as string,
    });
  });

  it("removing a level removes contents and links and clears entryLevel", () => {
    const plan = loadPlan("example-a");
    const r = ok(plan, [{ op: "remove", ids: ["l1"] }]);
    expect(r.plan.levels.map((l) => l.id)).toEqual(["l2"]);
    expect(r.plan.links).toEqual([]);
    expect(r.plan.entryLevel).toBeUndefined();
    expect(r.changed.removed).toContain("stair_main");
    expect(r.changed.removed).toContain("abbot");
    expect(r.dirtyLevels).toEqual(["l2", "l1"]);
  });

  it("add then remove in one batch nets out", () => {
    const r = ok(loadPlan("single-room"), [
      {
        op: "add",
        element: { kind: "feature", level: "l1", value: { id: "tmp", type: "crate", at: [3, 3] } },
      },
      { op: "remove", ids: ["tmp", "tmp"] },
    ]);
    expect(r.changed).toEqual({ added: [], updated: [], removed: [] });
  });
});

describe("move", () => {
  it("moves an area with its contents (features, labels, at-openings)", () => {
    const plan = loadPlan("multi-level-stairs");
    plan.links = [];
    const r = ok(plan, [{ op: "move", ids: ["foyer"], dx: 0, dy: -1 }]);
    expect(area(r.plan, "foyer")?.shape).toEqual({ type: "rect", x: 1, y: 0, w: 8, h: 8 });
    expect(r.plan.levels[0]?.features[0]?.at).toEqual([2, 6]);
    expect(r.plan.levels[0]?.openings[0]?.at).toEqual({ x: 4, y: 7, side: "S" });
    expect(r.changed.updated).toEqual(["foyer", "front_door", "statue"]);
  });

  it("withContents:false moves only the area; toLevel re-homes elements", () => {
    const plan = loadPlan("single-room");
    plan.levels.push({
      id: "l2",
      name: "Up",
      elevation: 2.5,
      bounds: { x: 0, y: 0, w: 12, h: 10 },
      base: { type: "void" },
      areas: [],
      openings: [],
      walls: [],
      features: [],
      terrain: [],
      labels: [],
    });
    const r = ok(plan, [{ op: "move", ids: ["cellar"], dx: 0, dy: 0, toLevel: "l2" }]);
    expect(r.plan.levels[1]?.areas.map((a) => a.id)).toEqual(["cellar"]);
    expect(r.plan.levels[1]?.features.map((f) => f.id)).toEqual(["table", "chair", "cask", "chest", "torch"]);
    expect(r.plan.levels[0]?.labels.map((l) => l.id)).toEqual(["lbl_cellar"]); // label at y 8 is outside the room
    const r2 = ok(plan, [{ op: "move", ids: ["cellar"], dx: 1, dy: 0, withContents: false }]);
    expect(r2.plan.levels[0]?.features[0]?.at).toEqual([5, 4]);
  });

  it("moves a whole level with its links", () => {
    const r = ok(loadPlan("multi-level-stairs"), [
      { op: "move", ids: ["ground", "study_lvl", "roof"], dx: 3, dy: 2 },
    ]);
    expect(r.plan.levels[0]?.bounds).toEqual({ x: 3, y: 2, w: 10, h: 10 });
    expect(r.plan.links[0]?.from.at).toEqual([10, 8]);
    expect(r.plan.links[0]?.to.at).toEqual([10, 5]);
  });

  it("rejects moving between-openings, links across levels and unknown targets", () => {
    const r = fail(loadPlan("two-rooms-door"), [
      { op: "move", ids: ["door1"], dx: 1, dy: 0 },
      { op: "move", ids: ["nope"], dx: 1, dy: 0 },
      { op: "move", ids: ["bed"], dx: 1, dy: 0, toLevel: "l7" },
    ]);
    expect(r.opErrors.map((e) => e.code)).toEqual(["not_applicable", "unknown_id", "unknown_level"]);
  });

  it("a move that breaks the plan is rejected by validation", () => {
    const r = fail(loadPlan("single-room"), [{ op: "move", ids: ["cask"], dx: 10, dy: 0 }]);
    expect(r.issues[0]).toMatchObject({ code: "bounds_exceeded", elementId: "cask" });
  });
});

describe("duplicate", () => {
  it("copies an area with contents, remaps references and assigns fresh keys", () => {
    const plan = loadPlan("two-rooms-door");
    plan.levels[0] = {
      ...(plan.levels[0] as MapPlan["levels"][number]),
      bounds: { x: 0, y: 0, w: 14, h: 16 },
    };
    const r = ok(plan, [{ op: "duplicate", ids: ["front", "back"], dx: 0, dy: 7, idSuffix: "_b" }]);
    const lvl = r.plan.levels[0];
    expect(lvl?.areas.map((a) => [a.id, a.key])).toEqual([
      ["front", "1"],
      ["back", "2"],
      ["front_b", "3"],
      ["back_b", "4"],
    ]);
    expect(lvl?.openings.find((o) => o.id === "door1_b")?.between).toEqual(["front_b", "back_b"]);
    expect(lvl?.features.find((f) => f.id === "bed_b")?.at).toEqual([9, 9]);
    expect(r.changed.added).toEqual(["front_b", "back_b", "door1_b", "bed_b", "rug_b"]);
  });

  it("duplicates a level above the top one", () => {
    const r = ok(loadPlan("multi-level-stairs"), [
      { op: "duplicate", ids: ["study_lvl"], dx: 0, dy: 0, idSuffix: "_2" },
    ]);
    const copy = r.plan.levels[3];
    expect(copy?.id).toBe("study_lvl_2");
    expect(copy?.elevation).toBe(7.5);
    expect(copy?.areas[0]).toMatchObject({ id: "study_2", key: "4" });
  });

  it("rejects colliding or overlong ids", () => {
    const plan = loadPlan("single-room");
    const r = fail(plan, [
      { op: "duplicate", ids: ["table"], dx: 0, dy: 1, idSuffix: "" },
      { op: "duplicate", ids: ["table"], dx: 0, dy: 1, idSuffix: "_abcdefghijklmnopqrstuvwxyz0123" },
    ]);
    expect(r.opErrors.map((e) => e.code)).toEqual(["invalid_value", "invalid_value"]);
  });
});

describe("reorder / renumber / materialize", () => {
  it("reorders areas and terrain ops; checks kind and range", () => {
    const r = ok(loadPlan("example-a"), [
      { op: "reorder", id: "ossuary", index: 0 },
      { op: "reorder", id: "rocks", index: 0 },
    ]);
    expect(r.plan.levels[0]?.areas.map((a) => a.id)).toEqual([
      "ossuary",
      "entry",
      "hall",
      "guard",
      "c1",
      "c2",
    ]);
    expect(r.plan.levels[1]?.terrain[0]?.id).toBe("rocks");
    const f = fail(loadPlan("example-a"), [
      { op: "reorder", id: "p1", index: 0 },
      { op: "reorder", id: "hall", index: 6 },
    ]);
    expect(f.opErrors.map((e) => [e.code, e.hint])).toEqual([
      ["wrong_kind", "reorder an area or a terrain op"],
      ["invalid_value", "use 0..5"],
    ]);
  });

  it("renumbers numeric keys: entry level first, then painter order", () => {
    const plan = loadPlan("example-a");
    const r = ok(plan, [{ op: "update", id: "hall", set: { key: "A" } }, { op: "renumber" }]);
    const keys = r.plan.levels.flatMap((l) => l.areas.map((a) => [a.id, a.key]));
    expect(keys).toEqual([
      ["entry", "1"],
      ["hall", "A"],
      ["guard", "2"],
      ["ossuary", "3"],
      ["c1", undefined],
      ["c2", undefined],
      ["cistern", "4"],
      ["landing", "5"],
      ["chapel", "6"],
      ["c3", undefined],
    ]);
    expect(r.changed.updated).toEqual(["hall", "guard", "ossuary", "cistern", "landing", "chapel"]);
  });

  it("level order: entry, then above ascending, then below descending", () => {
    const lv = (id: string, elevation: number): Level => ({
      id,
      name: id,
      elevation,
      bounds: { x: 0, y: 0, w: 4, h: 4 },
      base: { type: "solid" },
      areas: [],
      openings: [],
      walls: [],
      features: [],
      terrain: [],
      labels: [],
    });
    const plan = loadPlan("single-room");
    plan.levels = [lv("a", -5), lv("b", 2.5), lv("c", -2.5), lv("d", 5), lv("e", 7.5)];
    // No entryLevel: nearest 0 is b (2.5) and c (-2.5); the tie goes to b (first in plan order).
    expect(renumberLevelOrder(plan).map((l) => l.id)).toEqual(["b", "d", "e", "c", "a"]);
    plan.entryLevel = "c";
    expect(renumberLevelOrder(plan).map((l) => l.id)).toEqual(["c", "b", "d", "e", "a"]);
    plan.entryLevel = "missing";
    expect(renumberLevelOrder(plan).map((l) => l.id)).toEqual(["b", "d", "e", "c", "a"]);
  });

  describe("materialize", () => {
    it("needs the caller's materialize generator", () => {
      const r = fail(loadPlan("example-a"), [{ op: "materialize", id: "rocks" }]);
      expect(r.opErrors[0]?.code).toBe("not_applicable");
      expect(fail(loadPlan("example-a"), [{ op: "materialize", id: "flood" }]).opErrors[0]?.code).toBe(
        "wrong_kind",
      );
    });
    it("converts generated features to explicit ones and removes the op", () => {
      const rules: PlanRules = {
        checks: [],
        materialize: (_plan, _levelId, opId) => ({
          ok: true,
          features: [
            { id: `${opId}#0`, type: "rock", at: [20, 10] },
            { id: `${opId}#1`, type: "rock", at: [22, 12], rot: 90 },
          ],
        }),
      };
      const r = ok(loadPlan("example-a"), [{ op: "materialize", id: "rocks" }], rules);
      expect(r.changed).toEqual({ added: ["rocks_0", "rocks_1"], updated: [], removed: ["rocks"] });
      expect(r.plan.levels[1]?.terrain.map((t) => t.id)).toEqual(["flood", "pool", "dais"]);
      const kept = ok(loadPlan("example-a"), [{ op: "materialize", id: "rocks", keepOp: true }], rules);
      expect(kept.plan.levels[1]?.terrain).toHaveLength(4);
    });
  });
});

describe("transactions", () => {
  it("one bad op rolls back the whole batch and reports every error", () => {
    const plan = loadPlan("example-a");
    const r = fail(plan, [
      { op: "update", id: "hall", set: { name: "Renamed" } },
      {
        op: "add",
        element: {
          kind: "area",
          level: "l1",
          value: { id: "new_room", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 3, h: 3 } },
        },
      },
      { op: "update", id: "hal", set: { name: "x" } },
      { op: "frobnicate" },
      { op: "update", id: "new_room", set: { name: "ok" } },
    ]);
    expect(r.opErrors.map((e) => [e.opIndex, e.code])).toEqual([
      [2, "unknown_id"],
      [3, "invalid_value"],
    ]);
    expect(r.opErrors[1]?.hint).toContain("valid op values: add, add_features");
    expect(area(plan, "hall")?.name).toBe("Hall of Pillars");
  });

  it("validation errors of the would-be plan reject the batch", () => {
    const r = fail(loadPlan("example-a"), [
      { op: "update", id: "stair_main", set: { to: { level: "l1", at: [26, 7] } } },
    ]);
    expect(r.opErrors).toEqual([]);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: "link_mismatch", hint: "omit to.at or set it to [26,8]" }),
    ]);
  });

  it("suppresses follow-on unknown_id errors for ids a failed op tried to add", () => {
    const r = fail(loadPlan("single-room"), [
      {
        op: "add",
        element: { kind: "feature", level: "nope", value: { id: "lamp", type: "brazier", at: [3, 3] } },
      },
      { op: "update", id: "lamp", set: { rot: 90 } },
    ]);
    expect(r.opErrors.map((e) => e.code)).toEqual(["unknown_level"]);
  });

  it("an empty batch is a no-op", () => {
    const plan = loadPlan("cave");
    const r = ok(plan, []);
    expect(r.plan).toEqual(plan);
    expect(r.plan).not.toBe(plan);
  });
});
