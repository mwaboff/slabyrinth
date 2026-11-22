import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { PlanHistory } from "../../../src/contracts/ops";
import {
  TEXT_EDIT_MERGE_MS,
  checkHistory,
  commitVersion,
  createHistory,
  moveHeadBack,
  reconstruct,
  supersedeHead,
  textEditPlan,
} from "../../../src/history";
import { STRUCTURAL_RULES as R, applyOps } from "../../../src/ops";
import { loadPlan } from "../../fixtures";

const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Commits the GM's text edit as main does: textEditPlan, apply on its base, commit or supersede. */
function gmEdit(
  h: PlanHistory,
  id: string,
  set: Record<string, string>,
  at: number,
  pinned = new Set<number>(),
) {
  const e = textEditPlan(h, { id, set }, at, pinned);
  const base = reconstruct(h, e.base, R);
  if (!base.ok) throw new Error("no base");
  const r = applyOps(base.plan, [e.op], R);
  if (!r.ok) throw new Error("edit failed");
  const input = {
    plan: r.plan,
    author: "user" as const,
    createdAt: iso(at),
    summary: "edit",
    cause: { type: "ops" as const, ops: [e.op] },
  };
  return (e.supersedes === null ? commitVersion : supersedeHead)(h, input, R).history;
}

describe("GM text edits: joined, never rewritten in place", () => {
  const plan: MapPlan = loadPlan("example-a");
  const room = plan.levels[0]?.areas[0]?.id ?? "";
  const start = commitVersion(
    createHistory(),
    { plan, author: "ai", createdAt: iso(T0), summary: "v1", cause: { type: "create" } },
    R,
  ).history;

  it("a second edit of the same element within the window takes a new number and drops the one it joins", () => {
    const v2 = gmEdit(start, room, { name: "Crypt" }, T0);
    const v3 = gmEdit(v2, room, { notes: "Cold." }, T0 + 1000);
    expect(v3.head).toBe(3);
    expect(v3.versions.map((v) => [v.number, v.parentNumber])).toEqual([
      [1, 0],
      [3, 1],
    ]);
    expect(checkHistory(v3)).toEqual([]);
    const shown = reconstruct(v3, 3, R);
    expect(shown.ok && shown.plan.levels[0]?.areas[0]).toMatchObject({ name: "Crypt", notes: "Cold." });
  });

  it("does not join after the window, for another element, an approved or a pinned version", () => {
    const v2 = gmEdit(start, room, { name: "Crypt" }, T0);
    expect(
      textEditPlan(v2, { id: room, set: { notes: "x" } }, T0 + TEXT_EDIT_MERGE_MS + 1, new Set()).supersedes,
    ).toBeNull();
    expect(textEditPlan(v2, { id: "other", set: { notes: "x" } }, T0, new Set()).supersedes).toBeNull();
    expect(
      textEditPlan({ ...v2, approvedVersion: 2 }, { id: room, set: { notes: "x" } }, T0, new Set())
        .supersedes,
    ).toBeNull();
    expect(textEditPlan(v2, { id: room, set: { notes: "x" } }, T0, new Set([2])).supersedes).toBeNull();
    expect(textEditPlan(v2, { id: room, set: { notes: "x" } }, T0, new Set()).supersedes).toBe(2);
  });
});

describe("moveHeadBack (Retry)", () => {
  const plan: MapPlan = loadPlan("example-a");
  const room = plan.levels[0]?.areas[0]?.id ?? "";
  const h1 = commitVersion(
    createHistory(),
    { plan, author: "ai", createdAt: iso(T0), summary: "v1", cause: { type: "create" } },
    R,
  ).history;
  const other = plan.levels[0]?.areas[1]?.id ?? "";
  const h3 = gmEdit(gmEdit(h1, room, { name: "A" }, T0), other, { name: "B" }, T0);

  it("undoes every version between head and the target, oldest last", () => {
    const r = moveHeadBack(h3, 1);
    expect(r.ok && r.history.head).toBe(1);
    expect(r.ok && r.history.undone).toEqual([3, 2]);
    const none = moveHeadBack(h3, 0);
    expect(none.ok && none.history.head).toBe(0);
  });

  it("refuses a version that is not an ancestor", () => {
    expect(moveHeadBack(h1, 3).ok).toBe(false);
  });
});
