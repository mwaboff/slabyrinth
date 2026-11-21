import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { PlanHistory, PlanOp } from "../../../src/contracts/ops";
import {
  KEYFRAME_INTERVAL,
  approve,
  canRedo,
  canUndo,
  checkHistory,
  commitOps,
  commitVersion,
  createHistory,
  describeChanges,
  headPlan,
  listVersions,
  reconstruct,
  redo,
  restore,
  undo,
} from "../../../src/history";
import { STRUCTURAL_RULES, applyOps } from "../../../src/ops";
import { canonicalJson } from "../../../src/util";
import { loadPlan } from "../../fixtures";

const T = "2026-11-18T12:00:00.000Z";
/** These histories hold no op that materializes generated features: no resolver needed. */
const R = STRUCTURAL_RULES;

function create(plan: MapPlan): PlanHistory {
  return commitVersion(
    createHistory(),
    { plan, author: "ai", createdAt: T, summary: "Created", cause: { type: "create" } },
    R,
  ).history;
}

/** Applies ops to head and commits; returns the new history. */
function edit(h: PlanHistory, ops: PlanOp[], author: "ai" | "user" = "ai"): PlanHistory {
  const head = headPlan(h, R);
  if (!head.ok || head.plan === null) throw new Error("no head");
  const r = applyOps(head.plan, ops, R);
  if (!r.ok) throw new Error(JSON.stringify(r));
  const summary = describeChanges(head.plan, r.plan, author).summary;
  return commitOps(h, r.plan, ops, { author, createdAt: T, summary }, R).history;
}
const rename = (name: string): PlanOp[] => [{ op: "update", id: "cellar", set: { name } }];
const nameAt = (h: PlanHistory, n: number): string | undefined => {
  const r = reconstruct(h, n, R);
  return r.ok ? r.plan.levels[0]?.areas[0]?.name : undefined;
};

describe("versions and keyframes", () => {
  it("numbers are monotonic; first version is a keyframe, op versions store only ops", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A"));
    h = edit(h, rename("B"));
    expect(h.versions.map((v) => [v.number, v.parentNumber, v.snapshot !== undefined])).toEqual([
      [1, 0, true],
      [2, 1, false],
      [3, 2, false],
    ]);
    expect(h.head).toBe(3);
    expect(nameAt(h, 1)).toBe("Wine Cellar");
    expect(nameAt(h, 2)).toBe("A");
    expect(nameAt(h, 3)).toBe("B");
    expect(checkHistory(h)).toEqual([]);
  });

  it(`stores a keyframe every ${KEYFRAME_INTERVAL} versions along a chain`, () => {
    let h = create(loadPlan("single-room"));
    for (let i = 0; i < 45; i++) h = edit(h, rename(`N${i}`));
    const keyframes = h.versions.filter((v) => v.snapshot !== undefined).map((v) => v.number);
    expect(keyframes).toEqual([1, 21, 41]);
    expect(nameAt(h, 46)).toBe("N44");
  });

  it("stores a keyframe when ops do not reproduce the committed plan", () => {
    const plan = loadPlan("single-room");
    let h = create(plan);
    const other = { ...plan, title: "Not what the ops say" };
    h = commitOps(h, other, rename("X"), { author: "user", createdAt: T, summary: "edit" }, R).history;
    expect(h.versions[1]?.snapshot).toEqual(other);
    expect(reconstruct(h, 2, R)).toEqual({ ok: true, plan: other });
  });

  it("caches reconstructions", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A"));
    const cache = new Map<number, MapPlan>();
    const a = reconstruct(h, 2, R, cache);
    expect(cache.has(2)).toBe(true);
    expect(reconstruct(h, 2, R, cache)).toEqual(a);
  });

  it("reports missing versions and corrupt chains", () => {
    const h = create(loadPlan("single-room"));
    expect(reconstruct(h, 9, R)).toMatchObject({ ok: false, error: { code: "no_version" } });
    const broken: PlanHistory = {
      ...h,
      versions: [{ ...(h.versions[0] as PlanHistory["versions"][number]), snapshot: undefined as never }],
    };
    delete (broken.versions[0] as { snapshot?: unknown }).snapshot;
    expect(reconstruct(broken, 1, R)).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(checkHistory(broken).length).toBeGreaterThan(0);
  });
});

describe("pointer semantics (UX §7.2)", () => {
  it("undo moves head back and marks undone; redo moves forward", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A")); // v2
    h = edit(h, rename("B")); // v3
    const u = undo(h);
    if (!u.ok) throw new Error();
    expect([u.from, u.to, u.history.head, u.history.undone]).toEqual([3, 2, 2, [3]]);
    const u2 = undo(u.history);
    if (!u2.ok) throw new Error();
    expect(u2.history).toMatchObject({ head: 1, undone: [3, 2] });
    expect(canUndo(u2.history)).toBe(false);
    expect(undo(u2.history)).toMatchObject({ ok: false, error: { code: "nothing_to_undo" } });
    const r = redo(u2.history);
    if (!r.ok) throw new Error();
    expect(r.history).toMatchObject({ head: 2, undone: [3] });
    const r2 = redo(r.history);
    if (!r2.ok) throw new Error();
    expect(r2.history).toMatchObject({ head: 3, undone: [] });
    expect(redo(r2.history)).toMatchObject({ ok: false, error: { code: "nothing_to_redo" } });
    expect(undo(createHistory())).toMatchObject({ ok: false });
  });

  it("a new version while head is back takes the next number; undone versions stay listed", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A")); // v2
    h = edit(h, rename("B")); // v3
    const u = undo(h);
    if (!u.ok) throw new Error();
    h = edit(u.history, rename("C")); // v4, parent 2
    expect(h.versions.map((v) => [v.number, v.parentNumber])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
    expect(h).toMatchObject({ head: 4, undone: [3] });
    expect(canRedo(h)).toBe(false);
    const back = undo(h);
    if (!back.ok) throw new Error();
    expect(back.history).toMatchObject({ head: 2, undone: [3, 4] });
    const fwd = redo(back.history);
    expect(fwd.ok && fwd.to).toBe(4); // most recently undone child of v2
    expect(listVersions(h).map((r) => [r.version.number, r.isHead, r.isUndone])).toEqual([
      [4, true, false],
      [3, false, true],
      [2, false, false],
      [1, false, false],
    ]);
  });

  it("restore creates a new keyframe version equal to the old one", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A"));
    h = edit(h, rename("B"));
    const r = restore(h, 1, T, R);
    if (!r.ok) throw new Error();
    expect(r.version).toMatchObject({
      number: 4,
      parentNumber: 3,
      author: "restore",
      summary: "Restored v1",
      cause: { type: "restore", from: 1 },
    });
    expect(r.version.snapshot).toBeDefined();
    expect(canonicalJson(headPlan(r.history, R))).toBe(
      canonicalJson({ ok: true, plan: loadPlan("single-room") }),
    );
    expect(restore(h, 99, T, R)).toMatchObject({ ok: false, error: { code: "no_version" } });
  });

  it("approve moves a single pointer independent of head", () => {
    let h = create(loadPlan("single-room"));
    h = edit(h, rename("A"));
    const a = approve(h, 1);
    expect(a.ok && a.history).toMatchObject({ approvedVersion: 1, head: 2 });
    const b = a.ok ? approve(a.history, 2) : a;
    expect(b.ok && b.history.approvedVersion).toBe(2);
    expect(approve(h, 7)).toMatchObject({ ok: false });
    expect(
      b.ok &&
        listVersions(b.history)
          .filter((r) => r.isApproved)
          .map((r) => r.version.number),
    ).toEqual([2]);
  });

  it("functions never mutate their input", () => {
    const h = edit(create(loadPlan("single-room")), rename("A"));
    const snap = JSON.stringify(h);
    undo(h);
    redo(h);
    restore(h, 1, T, R);
    approve(h, 1);
    commitVersion(
      h,
      { plan: loadPlan("cave"), author: "ai", createdAt: T, summary: "x", cause: { type: "create" } },
      R,
    );
    expect(JSON.stringify(h)).toBe(snap);
  });
});

describe("change summaries", () => {
  it("describes AI and user edits", () => {
    const before = loadPlan("example-a");
    const r = applyOps(before, [{ op: "update", id: "ossuary", set: { notes: "Bones everywhere." } }], R);
    if (!r.ok) throw new Error();
    expect(describeChanges(before, r.plan, "user").summary).toBe("You edited notes for 4");
    const r2 = applyOps(
      before,
      [
        {
          op: "add",
          element: {
            kind: "level",
            value: {
              id: "l3",
              name: "Deep Vault",
              elevation: -5,
              bounds: { x: 0, y: 0, w: 10, h: 10 },
              base: { type: "solid" },
            },
          },
        },
        {
          op: "add",
          element: {
            kind: "area",
            level: "l3",
            value: {
              id: "vault",
              kind: "room",
              name: "Vault",
              shape: { type: "rect", x: 1, y: 1, w: 4, h: 4 },
            },
          },
        },
      ],
      R,
    );
    if (!r2.ok) throw new Error();
    const d = describeChanges(before, r2.plan, "ai");
    expect(d.summary).toBe("Added Deep Vault level (+1 more)");
    expect(d.bullets).toEqual(["Added Deep Vault level", "Added 8"]);
    expect(describeChanges(null, before, "ai")).toEqual({
      summary: 'Created "The Drowned Abbey"',
      bullets: ["2 levels, 7 rooms"],
    });
    expect(describeChanges(before, before, "user").summary).toBe("You made no changes");
  });
});
