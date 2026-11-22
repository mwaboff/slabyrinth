/**
 * The preview's resolve step (shared/resolveCore.ts compute) resolves a plan once: the plan check reuses that resolve
 * through core's planRules `resolved` option. resolvePlan is wrapped to count the resolves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPalettes } from "@slabyrinth/core/palette";
import { FIXTURE_PLAN } from "./fixturePlan";

const counter = vi.hoisted(() => ({ resolves: 0 }));
vi.mock("../../../../packages/core/src/resolve/resolvePlan", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../packages/core/src/resolve/resolvePlan")>();
  return {
    ...real,
    resolvePlan: (...args: Parameters<typeof real.resolvePlan>) => {
      counter.resolves++;
      return real.resolvePlan(...args);
    },
  };
});

const { compute, planIssues } = await import("../shared/resolveCore");

const options = {
  grid: true,
  roomNumbers: true,
  roomNames: true,
  furniture: true,
  gmLayer: false,
  legend: false,
};

beforeEach(() => {
  counter.resolves = 0;
});

describe("the preview resolves a plan once", () => {
  it("its plan check reuses the preview's resolve, with the same issues", () => {
    const palettes = bundledPalettes();
    const fresh = planIssues(FIXTURE_PLAN, palettes);
    expect(counter.resolves).toBe(1);
    counter.resolves = 0;
    const once = compute({ id: 1, plan: FIXTURE_PLAN, version: 1, options, sizeTier: "standard" }, palettes);
    expect(counter.resolves).toBe(1);
    expect(once.issues).toEqual(fresh);
  });
});
