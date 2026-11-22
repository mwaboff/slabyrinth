/**
 * Treatments forced for behaviour tests (src/resolve/recipes/treatments.ts): one option per family, so a test of a
 * recipe sees it on every subject, and a resolved plan with a level's arrangements replaced by a recipe run's.
 */
import type { ResolvedArrangement, ResolvedPlan } from "../../src/contracts/resolved";
import type { TreatmentFamily } from "../../src/resolve/recipes/treatments";

/** Families with one option each: every wall recipe in its first variant, trims in the wall's own material. */
export function forced(
  recipes: Readonly<Record<string, Readonly<Record<string, string>>>>,
  contrast = false,
): TreatmentFamily[] {
  const fam = (id: string): TreatmentFamily => ({
    id,
    doc: "forced",
    options: [{ id: "forced", weight: () => 1, recipes: recipes[id] ?? {} }],
  });
  return [
    fam("frame"),
    fam("courses"),
    fam("ground"),
    {
      id: "trim",
      doc: "forced",
      options: [{ id: contrast ? "contrast" : "own", weight: () => 1, recipes: {}, contrast }],
    },
  ];
}

/** Every wall recipe everywhere (jambs at every opening, bands at every floor line), no ground cover. */
export const ALL_WALLS = forced({
  frame: { jambPosts: "all", cornerPosts: "all", pilasters: "bays" },
  courses: { bandCourses: "every", plinths: "base" },
});

/** The plan with one level's arrangements replaced. */
export function withArrangements(
  r: ResolvedPlan,
  levelId: string,
  arrangements: readonly ResolvedArrangement[],
): ResolvedPlan {
  return {
    ...r,
    levels: r.levels.map((L) => (L.id === levelId ? { ...L, arrangements: [...arrangements] } : L)),
  };
}
