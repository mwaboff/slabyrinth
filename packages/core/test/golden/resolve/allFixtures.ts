/** Every plan the WP2 golden tests run: WP1's shared fixtures plus WP2's extra fixtures. */
import type { MapPlan } from "../../../src/contracts/plan";
import { VALID_PLAN_FIXTURES, loadPlan } from "../../fixtures/index";
import { EXTRA_FIXTURES } from "./extraFixtures";

export function allFixtures(): Array<[string, MapPlan]> {
  return [
    ...VALID_PLAN_FIXTURES.map((n): [string, MapPlan] => [n, loadPlan(n)]),
    ...Object.entries(EXTRA_FIXTURES).map(([n, p]): [string, MapPlan] => [`wp2-${n}`, structuredClone(p)]),
  ];
}
