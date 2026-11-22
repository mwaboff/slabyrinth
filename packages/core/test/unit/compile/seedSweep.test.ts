/**
 * Seed sweep (the fast one, part of `npm test`): every stored plan of test/fixtures/plans and the e2e plan, under the
 * newest generator, with a few fixed seeds and the seeds that once failed, builds without verify errors and without
 * warnings KNOWN_WARNINGS (test/sweep/seeds.ts) does not list for the plan (the generator
 * test plans: seedSweepGeneratorPlans.test.ts, a file of its own so the two run side by side). The large sweep
 * (hundreds of seeds per plan) is `npm run test:sweep` (test/sweep/run.ts); all of them read test/sweep/seeds.ts.
 *
 * A failure names the plan, the seed, the error codes and the first message ("<plan>@<seed>: codes (message)").
 */
import { describe, expect, it } from "vitest";
import { STORED_PLANS, type StoredPlan } from "../../fixtures";
import { E2E_ONCE_FAILED, e2ePlan, FAST_SEEDS, ONCE_FAILED, sweepOne, sweepPlan } from "../../sweep/seeds";

// one test per plan and seed: a failure names both, and no test builds more than one map
const RUNS = STORED_PLANS.flatMap((name: StoredPlan) =>
  [...FAST_SEEDS, ...(ONCE_FAILED[name] ?? [])].map((seed) => [name, seed] as const),
);

describe("seed sweep: stored plans build without verify errors or unlisted warnings under the newest generator", () => {
  it.each(RUNS)("%s@%i", (name, seed) => {
    const { failed, stale } = sweepOne(name, seed, (s) => sweepPlan(name, s));
    expect(failed, "errors not in KNOWN_FAILURES, warnings not in KNOWN_WARNINGS").toEqual([]);
    expect(stale, "KNOWN_FAILURES entries that build cleanly now").toEqual([]);
  });

  it.each([...FAST_SEEDS, ...E2E_ONCE_FAILED])("the e2e plan@%i", (seed) => {
    const { failed, stale } = sweepOne("e2e", seed, e2ePlan);
    expect(failed).toEqual([]);
    expect(stale).toEqual([]);
  });
});
