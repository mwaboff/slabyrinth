/**
 * util/lists.ts: minOf, maxOf and pushAll give the spread form's exact results (empty lists, NaN, signed zeros
 * included) and take lists far longer than a call may have arguments: one entry per cell of a 1024-tier level.
 */
import { describe, expect, it } from "vitest";
import { maxOf, minOf, pushAll } from "../../../src/util/lists";
import { boxFill, longestStraight, outline } from "../../../src/review/metrics";

/** More entries than V8 takes as arguments (it throws somewhere above 100,000). */
const LONG = 300_000;

describe("util/lists", () => {
  it("gives the spread form's results on short lists", () => {
    const cases: number[][] = [
      [],
      [3],
      [2, -1, 7],
      [0, -0],
      [-0, 0],
      [1, NaN, 2],
      [-Infinity],
      [Infinity, 5],
    ];
    for (const xs of cases) {
      expect(Object.is(minOf(xs), Math.min(...xs))).toBe(true);
      expect(Object.is(maxOf(xs), Math.max(...xs))).toBe(true);
    }
    expect(minOf(new Set([4, 1, 9]).values())).toBe(1);
    expect(
      maxOf(
        new Map([
          [1, 4],
          [2, 9],
        ]).values(),
      ),
    ).toBe(9);
    const out = [1];
    expect(pushAll(out, [2, 3], new Set([4]), [])).toBe(4);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it("takes lists longer than a call's arguments", () => {
    const xs = Array.from({ length: LONG }, (_, i) => (i * 7919) % LONG);
    expect(() => Math.max(...xs)).toThrow(RangeError);
    expect(minOf(xs)).toBe(0);
    expect(maxOf(xs)).toBe(LONG - 1);
    const out: number[] = [];
    pushAll(out, xs);
    expect(out.length).toBe(LONG);
    expect(out[LONG - 1]).toBe(xs[LONG - 1]);
  });

  it("the review's cell measures take a 1024-tier area", () => {
    const side = 560;
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) cells.push([x + 3, y - 2]);
    expect(cells.length).toBeGreaterThan(LONG);
    expect(boxFill(cells)).toBe(1);
    expect(outline(cells)).toHaveLength(1);
    expect(longestStraight(cells)).toBe(side);
  });
});
