/**
 * Seed sweep (the fast one, part of `npm test`): every stored plan of test/fixtures/plans and the e2e plan, under the
 * newest generator, with a few fixed seeds and the seeds that once failed, builds without verify errors (the generator
 * test plans: seedSweepGeneratorPlans.test.ts, a file of its own so the two run side by side). The large sweep
 * (hundreds of seeds per plan) is `npm run test:sweep` (test/sweep/run.ts); all of them read test/sweep/seeds.ts.
 *
 * A failure names the plan, the seed, the error codes and the first message ("<plan>@<seed>: codes (message)").
 */
import { describe, expect, it } from "vitest";
import { STORED_PLANS, type StoredPlan } from "../../fixtures";
import {
  E2E_ONCE_FAILED,
  e2ePlan,
  FAST_SEEDS,
  ONCE_FAILED,
  sweepFailures,
  sweepPlan,
  unexpected,
} from "../../sweep/seeds";

describe("seed sweep: stored plans build without verify errors under the newest generator", () => {
  it.each(STORED_PLANS.map((name) => [name]))("%s", (name: StoredPlan) => {
    const seeds = [...FAST_SEEDS, ...(ONCE_FAILED[name] ?? [])];
    const { failed, stale } = unexpected(
      name,
      seeds,
      sweepFailures(name, seeds, (seed) => sweepPlan(name, seed)),
    );
    expect(failed).toEqual([]);
    expect(stale, "KNOWN_FAILURES entries that build cleanly now").toEqual([]);
  });

  it("the e2e plan, with the seeds that once failed", () => {
    const seeds = [...FAST_SEEDS, ...E2E_ONCE_FAILED];
    const { failed, stale } = unexpected("e2e", seeds, sweepFailures("e2e", seeds, e2ePlan));
    expect(failed).toEqual([]);
    expect(stale).toEqual([]);
  });
});
