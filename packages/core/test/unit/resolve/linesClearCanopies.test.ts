/**
 * Overhead lines keep clear of the canopies and awnings over shop fronts (generator 5, switch linesClearCanopies;
 * resolve/building/canopy.ts is the one answer realize lays them by). Measured on the built pieces of the market street
 * under several seeds: no piece of a line (rope, lantern, flag) shares space with a canopy tile beyond a rope resting
 * on its top (util/sunk.ts `restsOn`). Without the switch, the ropes ran through the awnings in front of the walls they
 * were tied to (the build's `verify_prop_sunk` saw only a rope whose centre was over one; most crossed off-centre).
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { Box3 } from "../../../src/contracts/compiler";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { SUPPORT_SLACK } from "../../../src/util/sunk";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const span = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/** Over `seeds` builds: how many line pieces were built, and the ones that cut into a canopy or awning tile. */
function measure(seeds: readonly number[]): { pieces: number; through: string[] } {
  let pieces = 0;
  const through: string[] = [];
  for (const seed of seeds) {
    const set = realize(resolvePlan(sweepPlan("market-street-v3", seed, 5), pal), pal, {});
    for (const L of set.levels) {
      const boxOf = (p: (typeof L.placements)[number]): Box3 | undefined => set.placed.get(p)?.box;
      const canopies = L.placements
        .filter((p) => (p.source.elementId ?? "").endsWith("~canopy"))
        .flatMap((p) => boxOf(p) ?? []);
      for (const p of L.placements) {
        const id = p.source.elementId ?? "";
        const line = (resolvePlanLines.get(seed) ?? new Set<string>()).has(id.split("#")[0] ?? "");
        if (p.role !== "feature" || !line || /#post\d$/.test(id)) continue;
        const a = boxOf(p);
        if (!a) continue;
        pieces++;
        for (const b of canopies)
          if (
            span(a.min.x, a.max.x, b.min.x, b.max.x) > 0.01 &&
            span(a.min.z, a.max.z, b.min.z, b.max.z) > 0.01 &&
            span(a.min.y, a.max.y, b.min.y, b.max.y) > SUPPORT_SLACK
          )
            through.push(`${String(seed)} ${id}`);
      }
    }
  }
  return { pieces, through };
}
/** The line ids each seed's plan names. */
const resolvePlanLines = new Map<number, Set<string>>();

describe("linesClearCanopies", () => {
  const seeds = sweepSeeds(12);
  for (const seed of seeds)
    resolvePlanLines.set(
      seed,
      new Set(sweepPlan("market-street-v3", seed, 5).levels.flatMap((l) => (l.lines ?? []).map((q) => q.id))),
    );

  it("no line piece cuts into a canopy or awning; without the switch many do", () => {
    const on = measure(seeds);
    expect(on.pieces).toBeGreaterThan(100);
    expect(on.through).toEqual([]);
    P5.linesClearCanopies = false;
    expect(measure(seeds).through.length).toBeGreaterThan(10);
  }, 120_000);
});
