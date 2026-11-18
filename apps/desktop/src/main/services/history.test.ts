import { describe, expect, it } from "vitest";
import * as core from "@slabyrinth/core/history";
import type { MapPlan } from "@slabyrinth/core/contracts/plan";
import { moveHeadBack } from "./history";

const plan = (title: string): MapPlan =>
  ({
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "p",
    title,
    kind: "dungeon",
    seed: 1,
    theme: "stone_dungeon",
    levels: [],
    links: [],
  }) as unknown as MapPlan;

function twoVersions() {
  let h = core.createHistory();
  for (const t of ["one", "two"]) {
    h = core.commitVersion(h, {
      plan: plan(t),
      author: "ai",
      createdAt: "2026-11-18T00:00:00Z",
      summary: t,
      cause: { type: "restore", from: 0 },
    }).history;
  }
  return structuredClone(h);
}

describe("moveHeadBack (Retry, WP4)", () => {
  it("moves to an ancestor, recording the undone versions", () => {
    const h = twoVersions();
    expect(moveHeadBack(h, 1)).toBe(1);
    expect(h.undone).toEqual([2]);
  });

  it("can move to 0 (before the first version) and redo brings v1 back", () => {
    const h = twoVersions();
    expect(moveHeadBack(h, 0)).toBe(0);
    expect(h.head).toBe(0);
    expect(h.undone).toEqual([2, 1]);
    const r = core.redo(h);
    expect(r.ok && r.history.head).toBe(1);
  });

  it("refuses a target that is not an ancestor", () => {
    const h = twoVersions();
    expect(() => moveHeadBack(h, 7)).toThrow(/not an earlier version/);
  });
});
