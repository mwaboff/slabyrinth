/**
 * The seed sweep: a plan must build cleanly for any seed. Every stored plan (test/fixtures: the hand-written plans,
 * the proof plans and the generator test plans) and the plan the desktop e2e test builds, built under the newest
 * generator with fixed lists of other seeds, has no verify error, and no warning but those KNOWN_WARNINGS still lists;
 * the warnings include the playability issues (resolve/playability.ts) the build causes, and the plan's own playability
 * issues are allowed per plan by KNOWN_PLAN_ISSUES (`playability` says whose an issue is).
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
import {
  GENERATOR_VERSION,
  type GeneratorVersion,
  type MapPlan,
  type PlanIssue,
} from "../../src/contracts/plan";
import type { ResolvedPlan } from "../../src/contracts/resolved";
import { bundledPalettes } from "../../src/palette";
import { checkPlayability, resolvePlan } from "../../src/resolve/index";
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

/**
 * A stored plan under the newest generator (or `generator`, for a test of a released generator's switch) and another
 * seed.
 */
export const sweepPlan = (
  name: StoredPlan,
  seed: number,
  generator: GeneratorVersion = GENERATOR_VERSION,
): MapPlan => ({
  ...loadPlan(name, { generator }),
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
 *   hang free); prop_in_wall (a line's lantern 0.33 into a shop roof: the room pieces in a wing's post went with
 *   `postsAtBuildingCorners`; an upper storey's window light in a ground-storey partition that stood through the floor
 *   above, with `wallsUnderCeiling`; a tailor's bench across a lowered cell and the raised pavement, prop_sunk, with
 *   `tradePropsOnOneFloor`). The lines' own faults are gone at
 *   generator 5 (`linesClearCanopies`: a rope through a shop's awning, a lantern into a porch roof or a canopy).
 * (Gone at generator 5: props_overlap between elements is info under `layeredProps`; keep-dungeon's room pieces in a
 * wall's corner post are kept clear by the room-kind furnisher, which asks each piece's outline against the posts.)
 * - dressed-cave, heartroot-rift-v7 mount_no_wall: a dress op's thorn vines hung on a cave wall edge with no wall
 *   piece (the room recipe's board-edge torches are fixed: `mountsOnBuiltWalls`).
 * - three-step-glen-v1, terraced-hill cliff_gap: a 2-tile cliff edge with no rock in front (market-street-v3's went
 *   with `plinthUnderPorch`: a porch-fronted plinth is no longer raised twice).
 * - heartroot-rift-v7, dressed-cave(-v2), hillside-v5, smugglers-grotto-v3 prop_no_floor: a dress piece (a swamp tree base, a
 *   boulder, a moss rock) anchored on a cell whose centre has no floor piece under it (a ragged cave edge, an outcrop).
 * (Gone at generator 6, `unevenTops`: prop_floating on old-stones-glade-v6 (5, then 4; 0 once settle found a thing's
 *   support by the relation the resolver made, not by its base matching the support's rest within 0.02: pebbles and
 *   ferns set on a rock now stand on its top; the 3D scene check, which reads the game's meshes, found the ferns of two
 *   of the four seeds 0.18 and 0.45 over a rock before and nothing after), heartroot-rift-v7's 4, smugglers-grotto-v3's 16, dressed-cave's 1 and
 *   sea-grotto's 19: a landing's lantern and candles set beside a crate's top and things on stacked rocks stand on the
 *   part of the top that holds them. Verify holds a thing only to a part its own outline reaches, so these are not
 *   verify agreeing with settle: the scene check over every stored plan finds 19 floating pieces before and after.)
 * - hillside-v5 play_unreachable (the playability the build causes, `playability`): the plan's walkway climbs from its
 *   watchtower to a plateau whose edge is ragged, with no path, ramp or link up the cliff; where the walkway's top
 *   meets a pocket of that edge, the plan's own walk reaches it only across the foot of the cliff, and the plateau's
 *   rock band covers that foot with its rocks (the band's job: it keeps a gap only for links, paths and, with
 *   `bandsClearBridges`, decks). Which cells of a cliff's foot are a way is the terrain's to say, not the band's; the
 *   seeds where the plan itself has no way up are its own (KNOWN_PLAN_ISSUES). 82 before `bandsClearBridges` (a face
 *   rock over the walkway's top). What the build does wrong: its rocks close the only walk to the walkway. Allowed for
 *   now because the fix is not the band's (backlog: the terrain should give a walkway's landing a way up, or the
 *   band should keep the walk from a deck's end to the nearest open ground, which needs a walk inside the band).
 */
export const KNOWN_WARNINGS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "heartroot-rift-v7": {
    verify_prop_no_floor: 4,
    // 2 before `channelFloorWhole` moved the rift's shelves and the lair dressing round them
    verify_mount_no_wall: 4,
  },
  "market-street-v3": {
    // 12; 6 once the street draw (`readableNeighbours`, `themeOwnRange`) stood other buildings at the line ends; 5
    // with `linesClearCanopies`; 7 with `roofFormsFit` alone (28c65b2); 5 with `wealthLooks` too (measured at 150
    // seeds, switches off one at a time: the street's redrawn walls and roofs move which line ends stand on a
    // building; the same few seeds' kind of fault, a different set; the playability switches change none of it)
    verify_line_unanchored: 5,
    verify_prop_floating: 5,
    // 7 (lines into banners and porch roofs), 13 with the building rooms, 7 (the room pieces in a wing's post), 2 with
    // `postsAtBuildingCorners`, 1 with `wallsUnderCeiling` (a partition no longer pokes through the floor above): a
    // line's lantern in a roof; 2 with `roofFormsFit` alone, 1 with `wealthLooks` too (seed 2950288811, the same
    // measure)
    verify_prop_in_wall: 1,
  },
  "smugglers-grotto-v3": { verify_prop_no_floor: 1 },
  "three-step-glen-v1": { verify_cliff_gap: 1 },
  "dressed-cave": {
    verify_prop_no_floor: 11,
    verify_mount_no_wall: 7,
  },
  "dressed-cave-v2": { verify_prop_no_floor: 17 },
  "hillside-v5": { verify_prop_no_floor: 10, play_unreachable: 59 },
  "terraced-hill": { verify_cliff_gap: 1 },
};

/**
 * Playability issues that are the stored plan's own (see `playability`), per plan: "<code> <level>/<element>" -> the
 * seeds that raise it and why. Counted the way KNOWN_WARNINGS is: a sweep of at most WARNING_BASIS seeds fails when
 * more seeds raise an entry than it allows, one of at least WARNING_BASIS seeds when fewer do (lower it, or remove it at
 * 0), and every unlisted issue fails. The count holds the seeded part of a plan's own walk too (hillside's ragged
 * plateau edge): a terrain change that cuts the walkway on more seeds fails. Counts measured at 150 seeds plus each
 * plan's once-failed seeds (docs: test/sweep/run.ts prints them per plan).
 */
export const KNOWN_PLAN_ISSUES: Readonly<
  Record<string, Readonly<Record<string, { readonly seeds: number; readonly why: string }>>>
> = {
  "dungeon-complex-v1": {
    "route_dead_end l1/to_vault": {
      seeds: 150,
      why: "the route to the treasury (bend vh) ends at a wall or another room, never opening into the passage it starts from",
    },
    "unreachable l1/to_vault": {
      seeds: 150,
      why: "the route that never opens into the passage (route_dead_end) has no other way in",
    },
    "unreachable l1/vault": { seeds: 150, why: "the treasury's only way in is that route" },
  },
  "keep-dungeon-v8": {
    "route_dead_end l2/pass": {
      seeds: 150,
      why: "the crypt passage's route never opens into the cell block's hall (it is reached by the crypt stairs instead)",
    },
  },
  "hillside-v5": {
    "unreachable hill/walk": {
      seeds: 33,
      why: "the walkway lands on the plateau's ragged edge with no path, ramp or link up the cliff: for some seeds the edge's pocket under its top meets neither the plateau nor the lowland",
    },
    "unreachable hill/tower": { seeds: 33, why: "the watchtower's only way is that walkway" },
    "area_sealed hill/tower": {
      seeds: 1,
      why: "for a seed the walkway, sloped to where it meets the ragged edge, meets the tower's deck a tile above it and the joint is walled",
    },
  },
  e2e: {
    "feature_not_at_wall l1/shelf_mid": {
      seeds: 154,
      why: "the e2e plan leaves a bookshelf in the middle of the hall on purpose (apps/desktop/e2e/uiScript.ts)",
    },
  },
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
  return problems(build(plan).diagnostics, "error");
}

function build(plan: MapPlan): { resolved: ResolvedPlan; diagnostics: CompileDiagnostic[] } {
  const pal = bundledPalettes();
  const resolved = resolvePlan(plan, pal);
  const { diagnostics } = compileResolved(resolved, pal, slabCodec, { createdAt: "sweep", plan });
  return { resolved, diagnostics };
}

/** The prefix of a playability code the build causes, among a build's warning codes ("play_unreachable"). */
export const PLAY_PREFIX = "play_";

/** A playability issue's key: code, level and element ("unreachable l2/crypt"). */
const playKey = (i: PlanIssue): string => `${i.code} ${i.levelId ?? ""}/${i.elementId ?? ""}`;

/**
 * The playability issues of a build (resolve/playability.ts `checkPlayability`: its warnings and errors; the verify
 * stage leaves out what it reports, so the diagnostics never show them), split by whose they are. `own`: those the
 * same resolved plan raises with only the plan's own features on it, every generated one left out (a room's furniture,
 * a dress op's rubble, a scatter, a cliff band's rock): the plan has no way there, whatever is placed. `built`: the
 * rest, matched by code, level and element: something generation placed cut a way the plan had.
 */
export function playability(plan: MapPlan, resolved: ResolvedPlan): { own: PlanIssue[]; built: PlanIssue[] } {
  const serious = (issues: PlanIssue[]): PlanIssue[] => issues.filter((i) => i.severity !== "info");
  const bare: ResolvedPlan = {
    ...resolved,
    levels: resolved.levels.map((l) => ({
      ...l,
      features: l.features.filter((f) => f.generatedBy === undefined),
    })),
  };
  const planOwn = new Set(serious(checkPlayability(plan, bare)).map(playKey));
  const all = serious(checkPlayability(plan, resolved));
  return {
    own: all.filter((i) => planOwn.has(playKey(i))),
    built: all.filter((i) => !planOwn.has(playKey(i))),
  };
}

/** What a sweep collects beside the failures: builds with warnings, and the plan's own playability issues. */
export interface SweepCollect {
  /** "<plan>@<seed>" -> the build's warning codes (ENVIRONMENT_WARNINGS left out; `play_<code>` for playability). */
  warnings: Record<string, SweepFailure>;
  /** The plan's own playability issues (`playability`): key -> the seeds that raise it and the first message. */
  planOwn: Map<string, { seeds: number[]; first: string }>;
}

/** An empty collection for `sweepFailures`. */
export const sweepCollect = (): SweepCollect => ({ warnings: {}, planOwn: new Map() });

/**
 * Every failing build of `name` over `seeds`, as "<plan>@<seed>" -> failure; `collect.warnings` gathers the builds with
 * warnings the same way (ENVIRONMENT_WARNINGS left out), the playability issues the build causes among them as
 * `play_<code>`, for `unexpectedWarnings`; `collect.planOwn` the plan's own, for `unexpectedPlanIssues`.
 */
export function sweepFailures(
  label: string,
  seeds: readonly number[],
  planOf: (seed: number) => MapPlan,
  collect?: SweepCollect,
): Record<string, SweepFailure> {
  const out: Record<string, SweepFailure> = {};
  for (const seed of seeds) {
    const plan = planOf(seed);
    const { resolved, diagnostics } = build(plan);
    const f = problems(diagnostics, "error");
    if (f) out[`${label}@${String(seed)}`] = f;
    if (!collect) continue;
    const play = playability(plan, resolved);
    for (const i of play.own) {
      const at = collect.planOwn.get(playKey(i)) ?? { seeds: [], first: i.message };
      at.seeds.push(seed);
      collect.planOwn.set(playKey(i), at);
    }
    const w = problems(diagnostics, "warning");
    const codes = [...(w?.codes ?? []), ...play.built.map((i) => `${PLAY_PREFIX}${i.code}`)];
    if (codes.length > 0)
      collect.warnings[`${label}@${String(seed)}`] = {
        codes: [...new Set(codes)].sort(),
        first: w?.first ?? play.built[0]?.message ?? "",
      };
  }
  return out;
}

/**
 * The plan's own playability issues of a plan's builds against KNOWN_PLAN_ISSUES: `failed`, one not listed for the
 * plan, or (`basisSeeds` at most WARNING_BASIS) on more seeds than its entry allows; `stale` (`basisSeeds` at least
 * WARNING_BASIS), an entry raised by fewer seeds than it lists.
 */
export function unexpectedPlanIssues(
  label: string,
  planOwn: SweepCollect["planOwn"],
  basisSeeds?: number,
): { failed: string[]; stale: string[] } {
  const known = KNOWN_PLAN_ISSUES[label] ?? {};
  const failed: string[] = [];
  for (const [key, at] of planOwn) {
    const allowed = known[key]?.seeds;
    if (allowed === undefined)
      failed.push(
        `${label}@${at.seeds.slice(0, 3).join(", ")}: the plan's own ${key} on ${String(at.seeds.length)} seed(s) (${at.first})`,
      );
    else if (basisSeeds !== undefined && basisSeeds <= WARNING_BASIS && at.seeds.length > allowed)
      failed.push(
        `${label}: the plan's own ${key} on ${String(at.seeds.length)} seeds, KNOWN_PLAN_ISSUES allows ${String(allowed)}`,
      );
  }
  const stale =
    basisSeeds !== undefined && basisSeeds >= WARNING_BASIS
      ? Object.entries(known)
          .filter(([key, k]) => (planOwn.get(key)?.seeds.length ?? 0) < k.seeds)
          .map(
            ([key, k]) =>
              `${label}: the plan's own ${key} now on ${String(planOwn.get(key)?.seeds.length ?? 0)} seeds (listed ${String(k.seeds)}: lower or remove it in KNOWN_PLAN_ISSUES)`,
          )
      : [];
  return { failed, stale };
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
  const collect = sweepCollect();
  const errors = unexpected(label, [seed], sweepFailures(label, [seed], planOf, collect));
  return {
    failed: [
      ...errors.failed,
      ...unexpectedWarnings(label, collect.warnings).failed,
      ...unexpectedPlanIssues(label, collect.planOwn).failed,
    ],
    stale: errors.stale,
  };
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
