/**
 * Shared test fixtures (owned by WP1). Valid plans live in plans/*.json; deliberately invalid ones in
 * plans/invalid/*.json as { description, base, context?, expect: [{code, severity?, path, hintIncludes}], plan }.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { MapPlan, PlanIssueCode, Severity } from "../../src/contracts/plan";

const PLANS = new URL("./plans/", import.meta.url);
const INVALID = new URL("./plans/invalid/", import.meta.url);

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

/** A fresh (deep) copy of a valid plan fixture. */
export function loadPlan(name: ValidPlanFixture): MapPlan {
  return JSON.parse(readFileSync(new URL(`${name}.json`, PLANS), "utf8")) as MapPlan;
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
