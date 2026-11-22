/**
 * The large seed sweep: `npm run test:sweep [-- <seeds per plan>]` (from the repo root or packages/core; default 250).
 * Builds every stored plan and the e2e plan under the newest generator with the first N sweep seeds and the seeds that
 * once failed (test/sweep/seeds.ts), prints each plan's count and time, every failure as "<plan>@<seed>: codes
 * (first message)", and exits 1 when a build fails that KNOWN_FAILURES does not list (or a listed one passes), or
 * raises a warning KNOWN_WARNINGS does not allow (or a listed count is now too high). Every warning is also printed
 * per plan and code (how many seeds, a few of them).
 *
 * CI runs it as its own job (.github/workflows/ci.yml `sweep`) with fewer seeds than the default, to stay well under
 * ten minutes on a runner.
 */
import type { MapPlan } from "../../src/contracts/plan";
import {
  E2E_ONCE_FAILED,
  e2ePlan,
  ONCE_FAILED,
  SWEEP_PLANS,
  sweepFailures,
  sweepPlan,
  sweepSeeds,
  unexpected,
  unexpectedWarnings,
  type SweepFailure,
} from "./seeds";

const n = Number(process.argv[2] ?? 250);
if (!Number.isInteger(n) || n < 1)
  throw new Error(`seeds per plan: a whole number, got "${process.argv[2] ?? ""}"`);
const seeds = sweepSeeds(n);

const runs: Array<{ label: string; seeds: number[]; planOf: (seed: number) => MapPlan }> = [
  ...SWEEP_PLANS.map((name) => ({
    label: name,
    seeds: [...seeds, ...(ONCE_FAILED[name] ?? [])],
    planOf: (seed: number) => sweepPlan(name, seed),
  })),
  { label: "e2e", seeds: [...seeds, ...E2E_ONCE_FAILED], planOf: e2ePlan },
];

const t0 = Date.now();
const failed: string[] = [];
const stale: string[] = [];
for (const r of runs) {
  const t = Date.now();
  const warned: Record<string, SweepFailure> = {};
  const failures = sweepFailures(r.label, r.seeds, r.planOf, warned);
  const u = unexpected(r.label, r.seeds, failures);
  failed.push(...u.failed);
  stale.push(...u.stale.map((k) => `${k} builds cleanly now (remove it from KNOWN_FAILURES)`));
  const w = unexpectedWarnings(r.label, warned, n);
  failed.push(...w.failed);
  stale.push(...w.stale.map((k) => `${k} (lower or remove it in KNOWN_WARNINGS)`));
  const count = Object.keys(failures).length;
  console.log(`${r.label}: ${String(count)}/${String(r.seeds.length)} failed (${String(Date.now() - t)} ms)`);
  for (const line of [...u.failed, ...w.failed]) console.log(`  ${line}`);
  // every warning, listed or not, with how many seeds raise it (KNOWN_WARNINGS counts are these at 150 seeds)
  const byCode = new Map<string, string[]>();
  for (const [key, warning] of Object.entries(warned))
    for (const code of warning.codes)
      byCode.set(code, [...(byCode.get(code) ?? []), key.slice(key.indexOf("@") + 1)]);
  for (const [code, at] of byCode)
    console.log(`  warning ${code}: ${String(at.length)} seed(s), e.g. ${at.slice(0, 3).join(", ")}`);
}
console.log(
  `\n${String(runs.length)} plans x ${String(n)} seeds (+ once-failed) in ${String(Math.round((Date.now() - t0) / 1000))} s: ` +
    `${String(failed.length)} unexpected failure(s) or warning(s), ${String(stale.length)} stale known entr(ies).`,
);
for (const k of stale) console.log(`  stale: ${k}`);
if (failed.length > 0 || stale.length > 0) process.exitCode = 1;
