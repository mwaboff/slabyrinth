/**
 * Seed sweep (the fast one) over the generator test plans (test/unit/gen/fixtures: terrain, caves, dressing): under
 * the newest generator, with a few fixed seeds and the seeds that once failed, each builds without verify errors. The
 * stored plans of test/fixtures/plans: seedSweep.test.ts; the large sweep: `npm run test:sweep`.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_TEST_PLANS, type StoredPlan } from "../../fixtures";
import { FAST_SEEDS, ONCE_FAILED, sweepFailures, sweepPlan, unexpected } from "../../sweep/seeds";

describe("seed sweep: generator test plans build without verify errors under the newest generator", () => {
  it.each(GENERATOR_TEST_PLANS.map((name) => [name]))("%s", (name: StoredPlan) => {
    const seeds = [...FAST_SEEDS, ...(ONCE_FAILED[name] ?? [])];
    const { failed, stale } = unexpected(
      name,
      seeds,
      sweepFailures(name, seeds, (seed) => sweepPlan(name, seed)),
    );
    expect(failed).toEqual([]);
    expect(stale, "KNOWN_FAILURES entries that build cleanly now").toEqual([]);
  });
});
