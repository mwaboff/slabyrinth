/**
 * Object recipes (generator 5): things that are objects, not rooms or buildings (a vessel, a market stall; later a
 * wagon, a siege engine, a machine), built in their own frame from slots of arrangement-engine parts over the stand-in
 * lexicon, held to a piece budget, and placed whole. recipe.ts is the mechanism, lexicon.ts and kit.ts the stand-ins,
 * outline.ts and deck.ts shared geometry, place.ts the placement, `OBJECT_RECIPES` the recipes. Nothing in the plan
 * asks for them yet (that needs a plan word: the owner's call).
 */
import { stall } from "./stall";
import { vessel } from "./vessel";

export * from "./recipe";
export * from "./lexicon";
export * from "./kit";
export * from "./outline";
export * from "./deck";
export * from "./place";
export * from "./vessel";
export * from "./vesselProgramme";
export * from "./stall";

export const OBJECT_RECIPES = { vessel, stall } as const;
export type ObjectKind = keyof typeof OBJECT_RECIPES;
