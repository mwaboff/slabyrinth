/**
 * Every object any recipe builds at generator 6 (`railedDeckEdges`) is held to objects/facing.ts openDeckEdges: no raised
 * walking surface has an edge over a drop longer than one way across it without a rail. One table over every recipe in
 * OBJECT_RECIPES, a spread of sizes and seeds (every kind of vessel), with and without a gangway, so a new recipe (or a
 * new size of an old one) with an open raised edge fails here. (The harbour's moored objects: partRules.test.ts.)
 */
import { describe, expect, it } from "vitest";
import {
  OBJECT_KITS,
  OBJECT_RECIPES,
  buildObject,
  createKit,
  openDeckEdges,
  type ObjectRecipe,
} from "../../../src/objects";
import { loadPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";

/** The open raised edges of every case of a recipe, built with the palettes of `generator`. */
const openEdges = (id: keyof typeof OBJECT_RECIPES, generator: 5 | 6): string[] => {
  const recipe = OBJECT_RECIPES[id] as ObjectRecipe<Record<string, unknown>>;
  const kit = createKit(createPlanRoles(loadPalettes(), generator), "wood_town", OBJECT_KITS[id]);
  return CASES[id].flatMap((params) =>
    openDeckEdges(buildObject(recipe, params as never, kit)).map((e) => `${JSON.stringify(params)}: ${e}`),
  );
};

/** Each recipe's spread of parameters: sizes across its range, seeds, and its own variations. */
const CASES: Readonly<Record<keyof typeof OBJECT_RECIPES, ReadonlyArray<Record<string, unknown>>>> = {
  vessel: [6, 12, 18, 24, 30, 40].flatMap((size) =>
    ["a", "b", "c"].flatMap((seed) => [
      { size, seed },
      { size, seed, gangway: { x: 0.5, side: 1 } },
    ]),
  ),
  stall: [2, 3, 4].flatMap((size) => ["a", "b", "c"].map((seed) => ({ size, seed }))),
  platform: [4, 6, 8, 10].flatMap((size) => ["a", "b", "c"].map((seed) => ({ size, seed }))),
};

describe("no object leaves a raised edge over a drop unrailed (generator 6, railedDeckEdges)", () => {
  it.each(Object.keys(OBJECT_RECIPES) as Array<keyof typeof OBJECT_RECIPES>)("every %s", (id) => {
    expect(openEdges(id, 6)).toEqual([]);
  });

  it("the table finds the fault it is for: generator 5's vessels leave a raised deck's break open", () => {
    expect(openEdges("vessel", 5).length).toBeGreaterThan(0);
  });
});
