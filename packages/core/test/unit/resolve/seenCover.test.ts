/**
 * Cover is laid where it is seen (generator 6): no ground cover on a bed deep under the level's water (`seenCover`,
 * resolve/recipes/ground.ts). (A stall's lantern hanging under its canopy, `hangUnderCover`:
 * test/unit/compile/hangUnderCover.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { loadPalettes } from "../../../src/palette";
import { resolveWithObjects } from "../../../src/resolve/objectSite";
import { HARBOUR_SPECS, harbourPlan } from "../../fixtures/harbour";

describe("no ground cover where the water hides it (generator 6, seenCover)", () => {
  /** Pieces of ground cover on the harbour basin's bed, 5 tiles under the vessels' waterline. */
  const bedCover = (generator: 5 | 6): number =>
    resolveWithObjects({ ...harbourPlan(), generator }, HARBOUR_SPECS, loadPalettes())
      .resolved.levels.filter((l) => l.id === "harbour")
      .flatMap((l) => l.arrangements ?? [])
      .filter((a) => a.recipe === "layeredGround")
      .reduce((n, a) => n + a.pieces.length, 0);

  it("generator 5 strews rocks over the deep bed; generator 6 lays none", () => {
    expect(bedCover(5)).toBeGreaterThan(100);
    expect(bedCover(6)).toBe(0);
  });
});
