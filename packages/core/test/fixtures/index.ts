/**
 * Shared test fixtures. Stored plans live in two directories, and every test loads them through `loadPlan`:
 * - test/fixtures/plans/*.json: hand-written plans and the generator proof plans (copies of the owner's proofs);
 * - test/unit/gen/fixtures/*.json: plans recorded for the generator tests (terrain, caves, dressing).
 * Deliberately invalid plans live in plans/invalid/*.json as
 * { description, base, context?, expect: [{code, severity?, path, hintIncludes}], plan }.
 *
 * Adding a plan: put the file in one of the two directories and its name in the list below (a test keeps the lists
 * and the directories equal). The generator-5 golden runs every stored plan, so also run
 * `npm run test:golden:gen5:update` (test/golden/generator5).
 */
import { readFileSync, readdirSync } from "node:fs";
import type { GeneratorVersion, MapPlan, PlanIssueCode, Severity } from "../../src/contracts/plan";

const PLANS = new URL("./plans/", import.meta.url);
const GEN_PLANS = new URL("../unit/gen/fixtures/", import.meta.url);
const INVALID = new URL("./plans/invalid/", import.meta.url);

/** The small hand-written plans every layer is tested on (the resolve and text goldens pin them). */
export const VALID_PLAN_FIXTURES = [
  "example-a",
  "example-b",
  "single-room",
  "two-rooms-door",
  "l-corridor-route",
  "cave",
  "multi-level-stairs",
  "outdoor-scatter",
] as const;
export type ValidPlanFixture = (typeof VALID_PLAN_FIXTURES)[number];

/** Every plan in test/fixtures/plans/. */
export const STORED_PLANS = [
  ...VALID_PLAN_FIXTURES,
  "chimney-lineup-v1",
  "enclosure-gates-v1",
  "heartroot-rift-v7",
  "inn-interior-v1",
  "keep-dungeon-v8",
  "market-street-v3",
  "night-market-v1",
  "old-stones-glade-v6",
  "purpose-lineup-v1",
  "smugglers-grotto-v3",
  "stall-lineup-v1",
  "three-step-glen-v1",
  "wall-recipes-v1",
  "ground-and-walls-v1",
] as const;

/** Every plan in test/unit/gen/fixtures/. */
export const GENERATOR_TEST_PLANS = [
  "dressed-cave",
  "dressed-cave-v2",
  "dressed-forest",
  "dressed-forest-v4",
  "hillside-v5",
  "sea-grotto",
  "terraced-hill",
] as const;

export type StoredPlan = (typeof STORED_PLANS)[number] | (typeof GENERATOR_TEST_PLANS)[number];

/** The directory a stored plan lives in. */
export function storedPlanUrl(name: StoredPlan): URL {
  const dir = (GENERATOR_TEST_PLANS as readonly string[]).includes(name) ? GEN_PLANS : PLANS;
  return new URL(`${name}.json`, dir);
}

/** The `.json` files of each stored-plan directory (fixtures.test.ts compares them with the lists). */
export function storedPlanFiles(): { plans: string[]; generatorTests: string[] } {
  const names = (dir: URL): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  return { plans: names(PLANS), generatorTests: names(GEN_PLANS) };
}

/** A fresh (deep) copy of a stored plan; `generator` re-points it at another generator. */
export function loadPlan(name: StoredPlan, opts: { generator?: GeneratorVersion } = {}): MapPlan {
  const plan = JSON.parse(readFileSync(storedPlanUrl(name), "utf8")) as MapPlan;
  if (opts.generator !== undefined) plan.generator = opts.generator;
  return plan;
}

export interface InvalidFixture {
  name: string;
  description: string;
  base: string;
  context?: { themes?: string[] };
  expect: Array<{ code: PlanIssueCode; severity?: Severity; path: string; hintIncludes: string }>;
  /** Raw JSON (not necessarily a MapPlan). */
  plan: unknown;
}

export function loadInvalidFixtures(): InvalidFixture[] {
  return readdirSync(INVALID)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      ...(JSON.parse(readFileSync(new URL(f, INVALID), "utf8")) as Omit<InvalidFixture, "name">),
    }));
}
