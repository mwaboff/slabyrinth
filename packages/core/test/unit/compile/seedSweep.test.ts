/**
 * Seed sweep: every stored plan (test/fixtures/plans) and the plan the desktop e2e test builds, built under the newest
 * generator with a fixed list of other seeds, has no verify error. The goldens pin one seed per plan; a fault that
 * shows for a few seeds in a hundred (the e2e test's random seed once found one) only shows across many.
 *
 * The seeds are a fixed list (no randomness in the test). A plan and seed that still fail are listed in KNOWN_FAILURES
 * with the codes they fail with, so a fix shows as a stale entry and a new failure as a new one.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSION, type MapPlan } from "../../../src/contracts/plan";
import { completeAuthoredPlan } from "../../../src/agent/executor";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { slabCodec } from "../../../src/slab";
import { loadPlan, STORED_PLANS, type StoredPlan } from "../../fixtures";

/** Seeds per plan: enough to cross the rare cases, few enough for a few seconds of test time. */
const SEEDS_PER_PLAN = 3;
/** The i-th sweep seed: spread over the 32-bit range by Knuth's multiplicative step. */
const sweepSeed = (i: number): number => Math.imul(i + 1, 2654435761) >>> 0;
const SEEDS = Array.from({ length: SEEDS_PER_PLAN }, (_, i) => sweepSeed(i));
/**
 * More seeds per plan: ones that once failed (heartroot-rift's rock column was lowered below the higher of the two
 * floors it walls in: generator switch `columnsCloseHighestFloor`; market-street's buildings met in each other's wall
 * ring: switches `buildingReach`, `lowMassesOffNeighbours`, `partyWallsOutsideTaller`, `windowsInOneVolume`) and the
 * KNOWN_FAILURES below.
 */
const ONCE_FAILED: Partial<Record<StoredPlan, readonly number[]>> = {
  "heartroot-rift-v7": [2471588027],
  "market-street-v3": [1218333409, 443779575, 4203543429, 3929271828, 3049954367],
  "outdoor-scatter": [2027808452],
  "example-b": [1457683801],
};

/**
 * The e2e plan (apps/desktop/e2e/uiScript.ts): example-a as the model authors it (the app fills schema, generator and
 * id) with a bookshelf left in the middle of the hall. Seed 1274836067 once built a cave wall with gaps (the cave floor
 * relief rose under the level above).
 */
function e2ePlan(seed: number): MapPlan {
  const authored = loadPlan("example-a") as unknown as Record<string, unknown> & {
    levels: Array<{ id: string; features: unknown[] }>;
  };
  for (const k of ["schema", "generator", "id", "seed"]) Reflect.deleteProperty(authored, k);
  authored.levels
    .find((l) => l.id === "l1")
    ?.features.push({ id: "shelf_mid", type: "bookshelf", at: [15, 10] });
  return completeAuthoredPlan(authored, "e2e-plan", seed) as unknown as MapPlan;
}
const E2E_SEEDS = [...SEEDS, 1274836067, 2676017210, 3620079018, 4028937384];

/**
 * Plans and seeds that still build with errors, as "<plan>@<seed>" -> the error codes (sorted, distinct). Each is a
 * known fault of the generation side, left for its owner (docs/internal/handoff-lead.md "BUILD REVIEW FIXES"):
 * - outdoor-scatter, example-b: a scattered tree or boulder stands in front of a door.
 */
const KNOWN_FAILURES: Readonly<Record<string, readonly string[]>> = {
  "outdoor-scatter@2027808452": ["verify_door_blocked"],
  "example-b@1457683801": ["verify_door_blocked"],
};

function errorCodes(plan: MapPlan): string[] {
  const pal = bundledPalettes();
  const resolved = resolvePlan(plan, pal);
  const bundle = compileResolved(resolved, pal, slabCodec, { createdAt: "sweep", plan });
  return [...new Set(bundle.diagnostics.filter((d) => d.severity === "error").map((d) => d.code))].sort();
}

describe("seed sweep: stored plans build without verify errors under the newest generator", () => {
  it.each(STORED_PLANS.map((name) => [name]))("%s", (name: StoredPlan) => {
    const failures: Record<string, string[]> = {};
    for (const seed of [...SEEDS, ...(ONCE_FAILED[name] ?? [])]) {
      const plan = { ...loadPlan(name, { generator: GENERATOR_VERSION }), seed };
      const codes = errorCodes(plan);
      if (codes.length > 0) failures[`${name}@${seed}`] = codes;
    }
    const known = Object.fromEntries(
      Object.entries(KNOWN_FAILURES).filter(([k]) => k.startsWith(`${name}@`)),
    );
    expect(failures).toEqual(known);
  });

  it("the e2e plan, with the seeds that once failed", () => {
    const failures: Record<string, string[]> = {};
    for (const seed of E2E_SEEDS) {
      const codes = errorCodes(e2ePlan(seed));
      if (codes.length > 0) failures[`e2e@${seed}`] = codes;
    }
    expect(failures).toEqual({});
  });
});
