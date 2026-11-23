/**
 * The sweep's allowance for a plan's own playability issues (test/sweep/seeds.ts KNOWN_PLAN_ISSUES) is counted the way
 * KNOWN_WARNINGS is: more seeds than listed fail a sweep of up to WARNING_BASIS seeds, fewer are stale at the basis.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_PLAN_ISSUES, unexpectedPlanIssues, WARNING_BASIS, type SweepCollect } from "../../sweep/seeds";

const KEY = "unreachable hill/walk";
const listed = KNOWN_PLAN_ISSUES["hillside-v5"]?.[KEY]?.seeds ?? 0;
const raised = (n: number): SweepCollect["planOwn"] =>
  new Map([
    [KEY, { seeds: Array.from({ length: n }, (_, i) => i), first: "-" }],
    ["unreachable hill/tower", { seeds: Array.from({ length: n }, (_, i) => i), first: "-" }],
    ["area_sealed hill/tower", { seeds: [0], first: "-" }],
  ]);

describe("KNOWN_PLAN_ISSUES are counted", () => {
  it("lists hillside's walkway with a seed count", () => {
    expect(listed).toBeGreaterThan(0);
  });

  it("passes at the listed count and fails one seed over it, at or under the basis", () => {
    expect(unexpectedPlanIssues("hillside-v5", raised(listed), WARNING_BASIS)).toEqual({
      failed: [],
      stale: [],
    });
    expect(unexpectedPlanIssues("hillside-v5", raised(listed + 1), WARNING_BASIS).failed).toHaveLength(2);
    expect(unexpectedPlanIssues("hillside-v5", raised(listed + 60), 30).failed).toHaveLength(2);
  });

  it("calls a lower count stale only at the basis, and an unlisted issue a failure always", () => {
    expect(unexpectedPlanIssues("hillside-v5", raised(listed - 1), WARNING_BASIS).stale).toHaveLength(2);
    expect(unexpectedPlanIssues("hillside-v5", raised(listed - 1), 30).stale).toEqual([]);
    const other = new Map([["unreachable hill/plateau", { seeds: [1], first: "-" }]]);
    expect(unexpectedPlanIssues("hillside-v5", other).failed).toHaveLength(1);
  });
});
