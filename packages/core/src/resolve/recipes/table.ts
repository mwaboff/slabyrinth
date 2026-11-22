/**
 * The detail recipes, in the order the engine runs them (the order is part of the output: instances are attached in
 * it). A new recipe is one entry here (its own file by kind: walls.ts, ground.ts, ...), its switch in
 * plan/generator.ts, its option in a treatment family (treatments.ts) and its test; nothing else changes.
 */
import { layeredGround } from "./ground";
import type { AnyRecipe } from "./types";
import { bandCourses, cornerPosts, jambPosts, pilasters, plinths } from "./walls";

export const RECIPES: readonly AnyRecipe[] = [
  bandCourses,
  jambPosts,
  cornerPosts,
  plinths,
  pilasters,
  layeredGround,
];
