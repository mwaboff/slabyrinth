/**
 * Seed sweep (the fast one) over the generator test plans (test/unit/gen/fixtures: terrain, caves, dressing): under
 * the newest generator, with a few fixed seeds and the seeds that once failed, each builds without verify errors and
 * without warnings KNOWN_WARNINGS does not list for it (test/sweep/seeds.ts). The
 * stored plans of test/fixtures/plans: seedSweep.test.ts; the large sweep: `npm run test:sweep`.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_TEST_PLANS, type StoredPlan } from "../../fixtures";
import { FAST_SEEDS, ONCE_FAILED, sweepOne, sweepPlan } from "../../sweep/seeds";

// one test per plan and seed: a failure names both, and no test builds more than one map
const RUNS = GENERATOR_TEST_PLANS.flatMap((name: StoredPlan) =>
  [...FAST_SEEDS, ...(ONCE_FAILED[name] ?? [])].map((seed) => [name, seed] as const),
);

describe("seed sweep: generator test plans build without verify errors or unlisted warnings under the newest generator", () => {
  it.each(RUNS)("%s@%i", (name, seed) => {
    const { failed, stale } = sweepOne(name, seed, (s) => sweepPlan(name, s));
    expect(failed, "errors not in KNOWN_FAILURES, warnings not in KNOWN_WARNINGS").toEqual([]);
    expect(stale, "KNOWN_FAILURES entries that build cleanly now").toEqual([]);
  });
});
