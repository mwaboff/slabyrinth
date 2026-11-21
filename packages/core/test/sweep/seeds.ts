/**
 * The seed sweep: a plan must build cleanly for any seed. Every stored plan (test/fixtures: the hand-written plans,
 * the proof plans and the generator test plans) and the plan the desktop e2e test builds, built under the newest
 * generator with fixed lists of other seeds, has no verify error. The goldens pin one seed per plan; a fault that shows
 * for a few seeds in a hundred only shows across many.
 *
 * Two runs share this module: test/unit/compile/seedSweep*.test.ts (part of `npm test`: a few seeds per plan plus the
 * seeds that once failed) and test/sweep/run.ts (`npm run test:sweep`: hundreds of seeds per plan, for CI).
 *
 * The seeds are fixed (no randomness): the i-th is spread over the 32-bit range by Knuth's multiplicative step. A plan
 * and seed that still fail are listed in KNOWN_FAILURES with the codes they fail with, so a fix shows as a stale entry
 * and a new failure as a new one.
 */
import { completeAuthoredPlan } from "../../src/agent/executor";
import { compileResolved } from "../../src/compile";
import { GENERATOR_VERSION, type MapPlan } from "../../src/contracts/plan";
import { bundledPalettes } from "../../src/palette";
import { resolvePlan } from "../../src/resolve/index";
import { slabCodec } from "../../src/slab";
import { GENERATOR_TEST_PLANS, loadPlan, STORED_PLANS, type StoredPlan } from "../fixtures";

/** Every stored plan the sweep builds. */
export const SWEEP_PLANS: readonly StoredPlan[] = [...STORED_PLANS, ...GENERATOR_TEST_PLANS];

/** The i-th sweep seed. */
export const sweepSeed = (i: number): number => Math.imul(i + 1, 2654435761) >>> 0;

/** The first `n` sweep seeds. */
export const sweepSeeds = (n: number): number[] => Array.from({ length: n }, (_, i) => sweepSeed(i));

/** The fast sweep's seeds per plan (`npm test`): enough to cross the rare cases, a few seconds of test time. */
export const FAST_SEEDS = sweepSeeds(3);

/**
 * Seeds that once failed, per plan (each a different cause, now fixed):
 * - heartroot-rift: a rock column was lowered below the higher of the two floors it walls in (`columnsCloseHighestFloor`);
 * - market-street: buildings met in each other's wall ring: a chimney breast in the neighbour's wall cell (443779575),
 *   a window under the neighbour's eave, a lean-to against the next house (1218333409), a party wall hosted outside the
 *   lower building (3929271828, 3049954367), a window across the joint of a lean-to (4203543429) (`buildingReach`,
 *   `lowMassesOffNeighbours`, `partyWallsOutsideTaller`, `windowsInOneVolume`);
 * - outdoor-scatter, example-b: a scattered tree's crown or a boulder in front of a door (`waysInKeepClear`).
 */
export const ONCE_FAILED: Partial<Record<StoredPlan, readonly number[]>> = {
  "heartroot-rift-v7": [2471588027],
  "market-street-v3": [1218333409, 443779575, 4203543429, 3929271828, 3049954367],
  "outdoor-scatter": [2027808452, 591706100],
  "example-b": [1457683801],
};

/** Plans and seeds that still build with errors, as "<plan>@<seed>" -> the error codes (sorted, distinct). */
export const KNOWN_FAILURES: Readonly<Record<string, readonly string[]>> = {};

/**
 * The e2e plan (apps/desktop/e2e/uiScript.ts): example-a as the model authors it (the app fills schema, generator and
 * id) with a bookshelf left in the middle of the hall. Seed 1274836067 once built a cave wall with gaps (the cave floor
 * relief rose under the level above).
 */
export function e2ePlan(seed: number): MapPlan {
  const authored = loadPlan("example-a") as unknown as Record<string, unknown> & {
    levels: Array<{ id: string; features: unknown[] }>;
  };
  for (const k of ["schema", "generator", "id", "seed"]) Reflect.deleteProperty(authored, k);
  authored.levels
    .find((l) => l.id === "l1")
    ?.features.push({ id: "shelf_mid", type: "bookshelf", at: [15, 10] });
  return completeAuthoredPlan(authored, "e2e-plan", seed) as unknown as MapPlan;
}
export const E2E_ONCE_FAILED = [1274836067, 2676017210, 3620079018, 4028937384];

/** A stored plan under the newest generator and another seed. */
export const sweepPlan = (name: StoredPlan, seed: number): MapPlan => ({
  ...loadPlan(name, { generator: GENERATOR_VERSION }),
  seed,
});

/** A failed build: its error codes (sorted, distinct) and the first error's message. */
export interface SweepFailure {
  codes: string[];
  first: string;
}

/** Builds a plan; null when it has no verify (or any) error. */
export function buildErrors(plan: MapPlan): SweepFailure | null {
  const pal = bundledPalettes();
  const bundle = compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "sweep", plan });
  const errors = bundle.diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return null;
  return { codes: [...new Set(errors.map((d) => d.code))].sort(), first: errors[0]?.message ?? "" };
}

/** Every failing build of `name` over `seeds`, as "<plan>@<seed>" -> failure. */
export function sweepFailures(
  label: string,
  seeds: readonly number[],
  planOf: (seed: number) => MapPlan,
): Record<string, SweepFailure> {
  const out: Record<string, SweepFailure> = {};
  for (const seed of seeds) {
    const f = buildErrors(planOf(seed));
    if (f) out[`${label}@${String(seed)}`] = f;
  }
  return out;
}

/** The failures not listed in KNOWN_FAILURES (or listed with other codes), and the listed ones that passed. */
export function unexpected(
  label: string,
  seeds: readonly number[],
  failures: Readonly<Record<string, SweepFailure>>,
): { failed: string[]; stale: string[] } {
  const failed = Object.entries(failures)
    .filter(([k, f]) => (KNOWN_FAILURES[k] ?? []).join(",") !== f.codes.join(","))
    .map(([k, f]) => `${k}: ${f.codes.join(", ")} (${f.first})`);
  const tried = new Set(seeds.map((s) => `${label}@${String(s)}`));
  const stale = Object.keys(KNOWN_FAILURES).filter((k) => tried.has(k) && failures[k] === undefined);
  return { failed, stale };
}
