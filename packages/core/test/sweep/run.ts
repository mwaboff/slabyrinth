/**
 * The large seed sweep: `npm run test:sweep [-- <seeds per plan>]` (from the repo root or packages/core; default 250).
 * Builds every stored plan and the e2e plan under the newest generator with the first N sweep seeds and the seeds that
 * once failed (test/sweep/seeds.ts), prints each plan's count and time, every failure as "<plan>@<seed>: codes
 * (first message)", and exits 1 when a build fails that KNOWN_FAILURES does not list (or a listed one passes), or
 * raises a warning KNOWN_WARNINGS does not allow (or a listed count is now too high). The warnings include the
 * playability issues the build causes (`play_<code>`, seeds.ts `playability`); the plan's own are held to
 * KNOWN_PLAN_ISSUES per plan. Every warning is also printed per plan and code (how many seeds, a few of them), and
 * every plan's own playability issue. It also builds the size caps and runs every plan-showing tool on
 * a level at the side limit (the view budget, test/fixtures/viewBudget.ts).
 *
 * CI runs it as its own job (.github/workflows/ci.yml `sweep`) with fewer seeds than the default, to stay well under
 * ten minutes on a runner.
 */
import { compileResolved } from "../../src/compile";
import { PLAN_LIMITS, type MapPlan } from "../../src/contracts/plan";
import { loadPalettes } from "../../src/palette";
import { validatePlan } from "../../src/plan/validate";
import { planRules, resolvePlan } from "../../src/resolve/index";
import { SLAB_LIMITS, decodeDetailed, slabCodec } from "../../src/slab";
import { MAX_LEVEL_SIDE, type SizeTierId } from "../../src/plan/sizeTiers";
import { largeDungeonPlan, largeOutdoorPlan } from "../fixtures/largePlan";
import { RESULT_BLOCK_BUDGET, viewBudgetRun } from "../fixtures/viewBudget";
import {
  E2E_ONCE_FAILED,
  e2ePlan,
  ONCE_FAILED,
  SWEEP_PLANS,
  sweepCollect,
  sweepFailures,
  sweepPlan,
  sweepSeeds,
  unexpected,
  unexpectedPlanIssues,
  unexpectedWarnings,
} from "./seeds";

/**
 * The size limits, each built once: two dense dungeon levels at the standard limit (all the cells a plan may have),
 * a forest level at the standard side and a forest of the largest experimental tier, one level at its side. Every
 * chunk stays under the byte cap and in the coordinate range, and the chunks within what the helper add-on loads
 * (HELPER_MAX_CHUNKS chunks, HELPER_MAX_LINK_CHARS characters in its load message).
 */
const HELPER_MAX_CHUNKS = 500;
const HELPER_MAX_LINK_CHARS = 4 * 1024 * 1024;
const caps: Array<{ label: string; plan: MapPlan; tier: SizeTierId }> = [
  {
    label: `${String(PLAN_LIMITS.totalCells / PLAN_LIMITS.levelSide ** 2)} dungeon levels of ${String(PLAN_LIMITS.levelSide)} x ${String(PLAN_LIMITS.levelSide)}`,
    plan: largeDungeonPlan(PLAN_LIMITS.levelSide, PLAN_LIMITS.totalCells / PLAN_LIMITS.levelSide ** 2),
    tier: "standard",
  },
  {
    label: `a forest of ${String(PLAN_LIMITS.levelSide)} x ${String(PLAN_LIMITS.levelSide)}`,
    plan: largeOutdoorPlan(PLAN_LIMITS.levelSide),
    tier: "standard",
  },
  {
    label: `a forest of ${String(MAX_LEVEL_SIDE)} x ${String(MAX_LEVEL_SIDE)} (experimental)`,
    plan: largeOutdoorPlan(MAX_LEVEL_SIDE),
    tier: "large-1024",
  },
];

/** The plan errors (validate in its tier) and build errors (compile) of a cap plan, or none. */
function capBuildErrors(plan: MapPlan, sizeTier: SizeTierId): string[] {
  const cat = loadPalettes();
  const issues = validatePlan(plan, planRules(cat, { sizeTier })).issues.filter(
    (i) => i.severity === "error",
  );
  const bundle = compileResolved(resolvePlan(plan, cat), cat, slabCodec, { createdAt: "t", plan });
  const built = bundle.diagnostics.filter((d) => d.severity === "error");
  const chars = bundle.chunks.reduce((s, c) => s + c.slab.length, 0);
  // every chunk under the byte cap, every stored coordinate in the format's range
  const outOfRange = bundle.chunks.filter(
    (c) =>
      c.compressedBytes > SLAB_LIMITS.maxCompressedBytes ||
      decodeDetailed(c.slab).assets.some((a) => Math.max(a.sx, a.sy, a.sz) > SLAB_LIMITS.maxCoord),
  );
  return [
    ...issues.map((i) => `plan ${i.code}: ${i.message}`),
    ...built.map((d) => `build ${d.code}: ${d.message}`),
    ...outOfRange.map((c) => `chunk ${c.id} over the byte cap or out of range`),
    ...(bundle.chunks.length === 0 ? ["no chunks"] : []),
    ...(bundle.chunks.length > HELPER_MAX_CHUNKS ? [`${String(bundle.chunks.length)} chunks`] : []),
    ...(chars > HELPER_MAX_LINK_CHARS ? [`${String(chars)} characters of slab text`] : []),
  ];
}

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
  const collect = sweepCollect();
  const failures = sweepFailures(r.label, r.seeds, r.planOf, collect);
  const u = unexpected(r.label, r.seeds, failures);
  failed.push(...u.failed);
  stale.push(...u.stale.map((k) => `${k} builds cleanly now (remove it from KNOWN_FAILURES)`));
  const w = unexpectedWarnings(r.label, collect.warnings, n);
  failed.push(...w.failed);
  stale.push(...w.stale.map((k) => `${k} (lower or remove it in KNOWN_WARNINGS)`));
  const p = unexpectedPlanIssues(r.label, collect.planOwn, n);
  failed.push(...p.failed);
  stale.push(...p.stale);
  const count = Object.keys(failures).length;
  console.log(`${r.label}: ${String(count)}/${String(r.seeds.length)} failed (${String(Date.now() - t)} ms)`);
  for (const line of [...u.failed, ...w.failed, ...p.failed]) console.log(`  ${line}`);
  // every warning, listed or not, with how many seeds raise it (KNOWN_WARNINGS counts are these at 150 seeds)
  const byCode = new Map<string, string[]>();
  for (const [key, warning] of Object.entries(collect.warnings))
    for (const code of warning.codes)
      byCode.set(code, [...(byCode.get(code) ?? []), key.slice(key.indexOf("@") + 1)]);
  for (const [code, at] of byCode)
    console.log(`  warning ${code}: ${String(at.length)} seed(s), e.g. ${at.slice(0, 3).join(", ")}`);
  // and the plan's own playability issues (allowed per plan in KNOWN_PLAN_ISSUES, not counted)
  for (const [key, at] of collect.planOwn)
    console.log(`  plan's own ${key}: ${String(at.seeds.length)} seed(s)`);
}
for (const cap of caps) {
  const t = Date.now();
  const errors = capBuildErrors(cap.plan, cap.tier);
  failed.push(...errors.map((e) => `size cap ${cap.tier}: ${e}`));
  console.log(
    `size cap (${cap.label}): ${errors.length ? errors.join("; ") : "builds"} (${String(Date.now() - t)} ms)`,
  );
}
{
  // the view budget at the side limit (the unit test runs the same tools on a moderate plan)
  const t = Date.now();
  const { problems, ascii } = await viewBudgetRun(largeOutdoorPlan(PLAN_LIMITS.levelSide));
  if (!/overview: level crop is \d+×\d+ cells/.test(ascii))
    problems.push("the ASCII view is not an overview");
  failed.push(...problems.map((p) => `view budget: ${p}`));
  console.log(
    `view budget (a level of ${String(PLAN_LIMITS.levelSide)} x ${String(PLAN_LIMITS.levelSide)}): ${problems.length ? problems.join("; ") : `within ${String(RESULT_BLOCK_BUDGET)} characters a block`} (${String(Date.now() - t)} ms)`,
  );
}
console.log(
  `\n${String(runs.length)} plans x ${String(n)} seeds (+ once-failed) in ${String(Math.round((Date.now() - t0) / 1000))} s: ` +
    `${String(failed.length)} unexpected failure(s) or warning(s), ${String(stale.length)} stale known entr(ies).`,
);
for (const k of stale) console.log(`  stale: ${k}`);
if (failed.length > 0 || stale.length > 0) process.exitCode = 1;
