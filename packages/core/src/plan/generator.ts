import type { GeneratorVersion } from "../contracts/plan";

/**
 * The one way to gate behaviour on the generator version (architecture §2.7). Takes a plan or a resolved plan.
 *
 *   if (generatorAtLeast(this.plan, 4)) { ...new behaviour, only for generator-4 plans... }
 *
 * Generators 1, 2 and 3 are released: their output is frozen (test/golden/generator2, generator3). Never change
 * what a plan with `generator: 1`, `2` or `3` produces; put new rules behind `generatorAtLeast(x, 4)`. Existing
 * `>= 2` and `>= 3` checks stay as they are and stay on for 4.
 *
 * Review policy (decided 2026-11-20, code review finding 4): the design review is advice about the build, not the
 * build, so its output is NOT frozen per generator: a new note may run on an older generator's plan when what it
 * measures is true there. Its advice must hold for the plan's own generator: a note whose action relies on newer
 * behaviour ("name the room and the generator dresses it") is gated on that generator or words its action per
 * generator (review/interiors.ts room_bare and room_unlit, review/review.ts opening_hidden).
 */
export function generatorAtLeast(
  subject: { readonly generator: GeneratorVersion },
  version: GeneratorVersion,
): boolean {
  return subject.generator >= version;
}

/**
 * Plan vocabulary that exists only from a generator on. The schema accepts these names for every generator (a plan can be
 * re-pointed at another generator without being rejected), so a plan that uses one below its generator is warned: the
 * generator would ignore the field or substitute the piece, and the model should hear that instead of seeing nothing.
 * Add a row here when a generator adds a feature type or a level field.
 */
export const VOCABULARY_SINCE: {
  readonly featureTypes: Readonly<Record<string, GeneratorVersion>>;
  readonly levelFields: Readonly<Record<string, GeneratorVersion>>;
} = {
  featureTypes: { clutter: 4, shelf_line: 4 },
  levelFields: { roomDress: 4 },
};
