import { describe, expect, it } from "vitest";
import type { ResolvedLink } from "../../../src/contracts/resolved";
import { StairRuns } from "../../../src/compile/verify/runs";

const link = (over: Partial<ResolvedLink>): ResolvedLink => ({
  id: "s",
  kind: "stairs",
  fromLevel: "lo",
  toLevel: "hi",
  lowerCells: [],
  upperCells: [],
  arrival: [0, 0],
  dir: "N",
  rise: 2.5,
  theme: "generic",
  ...over,
});

describe("verify's stair runs", () => {
  it("number the steps from the foot along the run's direction and arrive one cell past the top", () => {
    // climbing north: the foot is the southernmost cell
    const north = link({
      lowerCells: [
        [4, 7],
        [4, 6],
        [4, 5],
      ],
      dir: "N",
    });
    // climbing west: the foot is the easternmost cell
    const west = link({
      id: "w",
      lowerCells: [
        [9, 2],
        [8, 2],
      ],
      dir: "W",
    });
    const runs = new StairRuns([north, west]);
    expect([7, 6, 5].map((y) => runs.at("lo", 4, y)?.k)).toEqual([0, 1, 2]);
    expect(runs.at("lo", 4, 5)?.last).toBe(true);
    expect(runs.arrivals(north)).toEqual([{ top: [4, 5], arrival: [4, 4] }]);
    expect(runs.at("lo", 9, 2)).toEqual({ linkId: "w", k: 0, last: false });
    expect(runs.arrivals(west)).toEqual([{ top: [8, 2], arrival: [7, 2] }]);
  });

  it("leave links that stand in one place out", () => {
    const ladder = link({ kind: "ladder", lowerCells: [[1, 1]] });
    const runs = new StairRuns([ladder]);
    expect(runs.at("lo", 1, 1)).toBeUndefined();
    expect(runs.arrivals(ladder)).toEqual([]);
  });
});
