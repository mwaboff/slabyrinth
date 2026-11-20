import type { GeneratorVersion } from "../contracts/plan";

/**
 * The one way to gate behaviour on the generator version (architecture §2.7). Takes a plan or a resolved plan.
 *
 *   if (generatorAtLeast(this.plan, 3)) { ...new behaviour, only for generator-3 plans... }
 *
 * Generators 1 and 2 are released: their output is frozen (test/golden/generator2). Never change what a plan with
 * `generator: 1` or `2` produces; put new rules behind `generatorAtLeast(x, 3)`. Existing `>= 2` checks stay as
 * they are and stay on for 3.
 */
export function generatorAtLeast(
  subject: { readonly generator: GeneratorVersion },
  version: GeneratorVersion,
): boolean {
  return subject.generator >= version;
}
