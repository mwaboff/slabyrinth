/**
 * What hides a cliff face (gen/cover.ts) and the review checks built on it: a face counts as covered only when rock
 * of the right width and height stands over it, low rises and the board's outer edge are judged as strictly as tall
 * cliffs, and a level with no band (the state the owner's terraced-hill-v2 was in) fails the checks that the
 * generator-3 band passes.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { edgeHidden, type RockShape } from "../../../src/gen/index";
import { resolvePlan } from "../../../src/resolve/index";
import { reviewDesign, type CliffCoverage } from "../../../src/review/index";
import { loadPlan } from "../../fixtures";

const fixture = (): MapPlan => loadPlan("terraced-hill");

/** The terraced hill with one-tile terraces (rises of 1 tile: the low class) and no routes across them. */
const lowHill = (): MapPlan => {
  const plan = fixture();
  const lvl = plan.levels[0];
  if (!lvl) throw new Error("fixture has no level");
  lvl.terrain = lvl.terrain.flatMap((o) => (o.op === "platform" ? [{ ...o, rise: 1 }] : []));
  return plan;
};

const run = (plan: MapPlan): { codes: string[]; cover: CliffCoverage | undefined } => {
  let cover: CliffCoverage | undefined;
  const notes = reviewDesign(plan, resolvePlan(plan), { onCoverage: (c) => (cover = c), limit: 99 });
  return { codes: notes.map((n) => n.code), cover };
};

const share = (c: { edges: number; bare: number }): number => (c.edges === 0 ? 0 : c.bare / c.edges);

describe("edgeHidden", () => {
  // a face along y = 10 (x from 0 to 8), the low ground at 0 and the upper at 2; rocks are rectangles along x
  const rock = (cx: number, base: number, top: number, w = 4, rot = 0): RockShape => ({
    cx,
    cy: 10,
    rot,
    w,
    d: 3,
    base,
    top,
  });
  const hidden = (shapes: RockShape[], x: number): boolean => edgeHidden(shapes, x, 10, 1, 0, 0, 2);

  it("a rock over the cell, as tall as the drop, hides it", () => {
    expect(hidden([rock(4, 0, 2.3)], 4)).toBe(true);
  });
  it("a rock beside the cell does not, nor one turned across it", () => {
    expect(hidden([rock(4, 0, 2.3)], 8)).toBe(false);
    expect(hidden([rock(4, 0, 2.3, 4, 90)], 7)).toBe(false);
  });
  it("a rock that stops halfway up does not; a second course on it does", () => {
    expect(hidden([rock(4, 0, 0.8)], 4)).toBe(false);
    expect(hidden([rock(4, 0, 0.8), rock(4, 0.8, 2.4)], 4)).toBe(true);
  });
  it("a boulder resting on the upper ground hides nothing below the lip", () => {
    expect(hidden([rock(4, 2, 3.6)], 4)).toBe(false);
  });
  it("two rocks side by side must overlap across the cell's width", () => {
    expect(hidden([rock(2, 0, 2.3, 2), rock(6, 0, 2.3, 2)], 4)).toBe(false);
    expect(hidden([rock(3, 0, 2.3, 3), rock(5, 0, 2.3, 3)], 4)).toBe(true);
  });
});

describe("review of cliff cover", () => {
  it("a generator-3 level with no band (the owner's terraced-hill-v2) fails the new checks", () => {
    for (const rise of [2, 1]) {
      const plan = rise === 2 ? fixture() : lowHill();
      const lvl = plan.levels[0];
      if (!lvl) throw new Error("no level");
      lvl.cliffBands = false;
      // the dress ops of the fixture would lay the band at generator 3: take them out as well
      lvl.terrain = lvl.terrain.filter((o) => o.op !== "dress");
      const { codes, cover } = run(plan);
      expect(cover).toBeDefined();
      expect(share(cover?.board ?? { edges: 0, bare: 0 })).toBeGreaterThan(0.9);
      expect(codes).toContain(rise === 2 ? "cliff_unclad" : "cliff_unclad_low");
    }
  });

  it("the generation-2 band (turned alike, never checked against the face) leaves tall faces showing", () => {
    const plan = fixture();
    plan.generator = 2;
    const { codes, cover } = run(plan);
    expect(share(cover?.tall ?? { edges: 0, bare: 0 })).toBeGreaterThan(0.3);
    expect(codes).toContain("cliff_unclad");
  });

  it("the generator-3 default band hides tall cliffs, low banks and the board's edge", () => {
    for (const plan of [fixture(), lowHill()]) {
      const { codes, cover } = run(plan);
      expect(cover).toBeDefined();
      if (!cover) return;
      expect(cover.board.edges).toBeGreaterThan(20);
      // the skirt stays inside the board's bounds, so only part of the outer edge can be hidden: better than none, no more;
      // and a 1-tile edge gets no face piece taller than itself (cliffband coursesOf), so the one-tile hill has no skirt
      if (plan.levels[0]?.terrain.some((o) => o.op === "platform" && o.rise !== 1))
        expect(share(cover.board)).toBeLessThan(0.97);
      expect(share(cover.tall)).toBeLessThanOrEqual(0.1);
      expect(share(cover.low)).toBeLessThanOrEqual(0.2);
      for (const code of [
        "cliff_unclad",
        "cliff_unclad_low",
        "cliff_hanging",
        "cliff_even_spacing",
        "cliff_buries_ground",
      ])
        expect(codes).not.toContain(code);
    }
    // the one-tile hill really has low banks to judge
    expect(run(lowHill()).cover?.low.edges).toBeGreaterThan(20);
  });
});
