/**
 * Generator 6's `tilesStoredByFootprint` stays open on purpose (the turned-tile rule at non-quarter turns awaits the
 * owner's paste test, docs/decisions.md), so it must stay a switch of its own: turned off alone, it moves only the cave
 * mass's turned tiles back to the old store, and every other generator-6 change still holds.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Placement } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, type StoredPlan } from "../../fixtures";

const pal = bundledPalettes();
const profile6 = GENERATOR_PROFILES[6] as { tilesStoredByFootprint: boolean };

afterEach(() => {
  profile6.tilesStoredByFootprint = true;
});

/** Each placement of a generator-6 build as a line, in the set's order. */
const build = (name: StoredPlan): { lines: string[]; placements: Placement[]; errors: string[] } => {
  const plan = { ...loadPlan(name), generator: 6 as const };
  const r = resolvePlan(plan, pal);
  const set = realize(r, pal);
  const placements = set.levels.flatMap((l) => l.placements);
  const errors = verifyBuild(r, set, pal, { plan })
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
  return {
    lines: placements.map((p) => `${p.asset} ${String(p.x)},${String(p.y)},${String(p.z)} r${String(p.rot)}`),
    placements,
    errors,
  };
};

describe("tilesStoredByFootprint is independent of every other generator-6 switch", () => {
  it.each(["sea-grotto", "inn-interior-v1", "market-street-v3"] as const)(
    "%s: turned off alone, only cave-mass tiles at a turn move, and verify finds no error",
    (name) => {
      const on = build(name);
      profile6.tilesStoredByFootprint = false;
      const off = build(name);
      expect(off.errors).toEqual([]);
      expect(off.lines.length).toBe(on.lines.length);
      const moved = on.placements.filter((_, i) => on.lines[i] !== off.lines[i]);
      for (const p of moved) {
        expect(["cave_mass", "cave_cap", "cave_foot"]).toContain(p.source.elementId);
        expect(p.rot % 360).not.toBe(0);
      }
      if (name === "sea-grotto") expect(moved.length).toBeGreaterThan(0);
      else expect(moved).toEqual([]);
    },
  );
});
