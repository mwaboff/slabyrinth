/**
 * The seed sweep: a plan must build cleanly for any seed. Every stored plan (test/fixtures: the hand-written plans,
 * the proof plans and the generator test plans) and the plan the desktop e2e test builds, built under the newest
 * generator with fixed lists of other seeds, has no verify error, and no warning but those KNOWN_WARNINGS still lists.
 * The goldens pin one seed per plan; a fault that shows for a few seeds in a hundred only shows across many (a stored
 * seed is the one the plan was revised at until it built cleanly, so it says little about the others).
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
import type { CompileDiagnostic } from "../../src/contracts/compiler";
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

/**
 * Warnings about what the test run lacks, not about the build: tests load no TaleSpire catalog, so a plan's custom
 * feature (multi-level-stairs' "brass telescope") never resolves. The sweep does not count them.
 */
export const ENVIRONMENT_WARNINGS: ReadonlySet<string> = new Set(["custom_unresolved"]);

/** The sweep seeds KNOWN_WARNINGS counts are measured over: the first this many, plus the plan's once-failed seeds. */
export const WARNING_BASIS = 150;

/**
 * Warnings stored plans still raise for some seeds (not at their stored seed: the goldens and proofs show 0), per plan:
 * code -> how many of the WARNING_BASIS sweep seeds (and the once-failed ones) raise it. Every other warning fails the
 * sweep, and so does a count that grows. The list only shrinks: a sweep of at least WARNING_BASIS seeds fails on a
 * count that is now lower (lower it) or an entry no seed raises (remove it). The causes, for the next round:
 * - market-street-v3: line_unanchored and prop_floating (the wall at a line's end stops below the rope and the
 *   building's roof deck above it is a floor piece, which verify does not take as holding it: the line and its pieces
 *   hang free); prop_in_wall (an upper storey's window light set at its cell's centre 0.14 into a ground-storey
 *   partition, whose 2-tall pieces stand half a tile through the floor above; a line's lantern 0.33 into a shop roof:
 *   the room pieces in a wing's post went with `postsAtBuildingCorners`; a tailor's bench across a lowered cell and
 *   the raised pavement, prop_sunk, with `tradePropsOnOneFloor`). The lines' own faults are gone at
 *   generator 5 (`linesClearCanopies`: a rope through a shop's awning, a lantern into a porch roof or a canopy).
 * (Gone at generator 5: props_overlap between elements is info under `layeredProps`; keep-dungeon's room pieces in a
 * wall's corner post are kept clear by the room-kind furnisher, which asks each piece's outline against the posts.)
 * - dressed-cave, heartroot-rift-v7 mount_no_wall: a dress op's thorn vines hung on a cave wall edge with no wall
 *   piece (the room recipe's board-edge torches are fixed: `mountsOnBuiltWalls`).
 * - three-step-glen-v1, terraced-hill cliff_gap: a 2-tile cliff edge with no rock in front (market-street-v3's went
 *   with `plinthUnderPorch`: a porch-fronted plinth is no longer raised twice).
 * - heartroot-rift-v7, dressed-cave(-v2), hillside-v5, smugglers-grotto-v3 prop_no_floor: a dress piece (a swamp tree base, a
 *   boulder, a moss rock) anchored on a cell whose centre has no floor piece under it (a ragged cave edge, an outcrop).
 * - smugglers-grotto-v3, sea-grotto, old-stones-glade-v6 prop_floating: a landing's lantern and candles 0.42 above the
 *   floor under their centre (the landing's lower step), pebbles 0.5 above a step.
 */
export const KNOWN_WARNINGS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "heartroot-rift-v7": {
    verify_prop_no_floor: 4,
    // 2 before `channelFloorWhole` moved the rift's shelves and the lair dressing round them
    verify_mount_no_wall: 4,
    verify_prop_floating: 4,
  },
  "market-street-v3": {
    // 12; 6 once the street draw (`readableNeighbours`, `themeOwnRange`) stood other buildings at the line ends; 5
    // with `linesClearCanopies`
    verify_line_unanchored: 5,
    verify_prop_floating: 5,
    // 7 (lines into banners and porch roofs), 13 with the building rooms, 7 (the room pieces in a wing's post), 2 with
    // `postsAtBuildingCorners`: a window light in a partition poking through the floor above, a lantern in a roof
    verify_prop_in_wall: 2,
  },
  "old-stones-glade-v6": { verify_prop_floating: 5 },
  "smugglers-grotto-v3": { verify_prop_floating: 16, verify_prop_no_floor: 1 },
  "three-step-glen-v1": { verify_cliff_gap: 1 },
  "dressed-cave": {
    verify_prop_no_floor: 11,
    verify_mount_no_wall: 7,
    verify_prop_floating: 1,
  },
  "dressed-cave-v2": { verify_prop_no_floor: 17 },
  "hillside-v5": { verify_prop_no_floor: 10 },
  "sea-grotto": { verify_prop_floating: 19 },
  "terraced-hill": { verify_cliff_gap: 1 },
};

/** The diagnostics of one severity a build has, as a failure (codes sorted and distinct); null when it has none. */
function problems(
  diagnostics: readonly CompileDiagnostic[],
  severity: "error" | "warning",
): SweepFailure | null {
  const found = diagnostics.filter(
    (d) => d.severity === severity && !(severity === "warning" && ENVIRONMENT_WARNINGS.has(d.code)),
  );
  if (found.length === 0) return null;
  return { codes: [...new Set(found.map((d) => d.code))].sort(), first: found[0]?.message ?? "" };
}

/** Builds a plan; null when it has no verify (or any) error. */
export function buildErrors(plan: MapPlan): SweepFailure | null {
  return problems(buildDiagnostics(plan), "error");
}

function buildDiagnostics(plan: MapPlan): CompileDiagnostic[] {
  const pal = bundledPalettes();
  return compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "sweep", plan }).diagnostics;
}

/**
 * Every failing build of `name` over `seeds`, as "<plan>@<seed>" -> failure; `warnings` collects the builds with
 * warnings the same way (ENVIRONMENT_WARNINGS left out), for `unexpectedWarnings`.
 */
export function sweepFailures(
  label: string,
  seeds: readonly number[],
  planOf: (seed: number) => MapPlan,
  warnings?: Record<string, SweepFailure>,
): Record<string, SweepFailure> {
  const out: Record<string, SweepFailure> = {};
  for (const seed of seeds) {
    const diagnostics = buildDiagnostics(planOf(seed));
    const f = problems(diagnostics, "error");
    if (f) out[`${label}@${String(seed)}`] = f;
    const w = warnings && problems(diagnostics, "warning");
    if (w) warnings[`${label}@${String(seed)}`] = w;
  }
  return out;
}

/**
 * The warnings of a plan's builds against KNOWN_WARNINGS. `failed`: a code not listed for the plan, or (`basisSeeds`
 * given: the run built the first that many sweep seeds and the once-failed ones) more seeds raising a listed code than
 * its count allows. `stale` (only when the run covered the whole basis): a listed count higher than the seeds that
 * raise it now, to lower or remove.
 */
export function unexpectedWarnings(
  label: string,
  warned: Readonly<Record<string, SweepFailure>>,
  basisSeeds?: number,
): { failed: string[]; stale: string[] } {
  const known = KNOWN_WARNINGS[label] ?? {};
  const seeds = new Map<string, string[]>();
  for (const [k, w] of Object.entries(warned))
    for (const code of w.codes) seeds.set(code, [...(seeds.get(code) ?? []), k]);
  const failed: string[] = [];
  for (const [code, at] of seeds) {
    const allowed = known[code];
    if (allowed === undefined)
      failed.push(`${at.slice(0, 3).join(", ")}: warning ${code} (${warned[at[0] ?? ""]?.first ?? ""})`);
    else if (basisSeeds !== undefined && basisSeeds <= WARNING_BASIS && at.length > allowed)
      failed.push(
        `${label}: warning ${code} on ${String(at.length)} seeds, KNOWN_WARNINGS allows ${String(allowed)}`,
      );
  }
  const stale =
    basisSeeds !== undefined && basisSeeds >= WARNING_BASIS
      ? Object.entries(known)
          .filter(([code, n]) => (seeds.get(code)?.length ?? 0) < n)
          .map(
            ([code, n]) =>
              `${label}: warning ${code} now on ${String(seeds.get(code)?.length ?? 0)} seeds (listed ${String(n)})`,
          )
      : [];
  return { failed, stale };
}

/**
 * One build of the fast sweep (`npm test`): its errors against KNOWN_FAILURES and its warnings against KNOWN_WARNINGS
 * (a code listed for the plan passes; counts are the large sweep's to check).
 */
export function sweepOne(
  label: string,
  seed: number,
  planOf: (seed: number) => MapPlan,
): { failed: string[]; stale: string[] } {
  const warned: Record<string, SweepFailure> = {};
  const errors = unexpected(label, [seed], sweepFailures(label, [seed], planOf, warned));
  return { failed: [...errors.failed, ...unexpectedWarnings(label, warned).failed], stale: errors.stale };
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
