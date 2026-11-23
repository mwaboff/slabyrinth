/**
 * Generator 5 (`wallsUnderCeiling`): a wall the level pass lays inside a building's ground storey under an upper floor
 * (a partition between its rooms, the wall over an interior doorway) never stands above the storey's wall top. Stacked
 * from whole two-tile pieces, a 2.5-tile storey's partition stood 0..4, half a tile through the floor above (an upper
 * window light stood 0.14 inside it: market-street-v3, seed 3507073702).
 */
import { afterEach, describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { partOfBuilding } from "../../../src/resolve/levelGrid";
import { loadPlan } from "../../fixtures";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** Level-pass wall pieces inside a building with an upper storey that stand above its ground storey's wall top. */
function overCeiling(plan: MapPlan): string[] {
  const r = resolvePlan(plan, pal);
  const set = realize(r, pal, {});
  const out: string[] = [];
  for (const L of r.levels) {
    const W = L.bounds.w;
    const ceiling = new Map<string, number>();
    for (const s of L.structures ?? []) {
      const [s0] = s.storeys;
      if (s.kind === "building" && s0 !== undefined && s.storeys.length > 1)
        ceiling.set(s.id, s0.floorTop + s0.wallHeight);
    }
    for (const p of set.levels.find((l) => l.levelId === L.id)?.placements ?? []) {
      if ((p.role !== "wall" && p.role !== "opening") || p.layer !== undefined || !p.source.cell) continue;
      const [x, y] = p.source.cell;
      const a = L.areas[(L.cells.area[(y - L.bounds.y) * W + (x - L.bounds.x)] ?? 0) - 1];
      if (a === undefined || !partOfBuilding(a)) continue;
      const top = ceiling.get(a.building ?? a.id);
      const box = set.placed.get(p)?.box;
      // (a wall asset's collider stands a few hundredths over its unit height)
      if (top !== undefined && box !== undefined && box.max.y > top + 0.05)
        out.push(
          `${L.id} ${String(p.source.elementId)} at ${x},${y}: top ${box.max.y.toFixed(2)} over ${top}`,
        );
    }
  }
  return out;
}

describe("walls under a building's upper floor (generator 5, wallsUnderCeiling)", () => {
  it("no partition or doorway wall stands above its storey's wall top", () => {
    const plans: MapPlan[] = [
      sweepPlan("market-street-v3", 3507073702),
      loadPlan("market-street-v3"),
      loadPlan("building-rooms-street-v1"),
      loadPlan("two-quarters-v1"),
      loadPlan("varied-street-v1"),
      // a two-storey infirmary whose ward is lined with bays (generator 5, cellRows): its partitions stop at the storey
      ...[21, 1, 3].map((seed) => ({ ...loadPlan("cell-rows-town-v1"), seed })),
    ];
    for (const plan of plans) expect(overCeiling(plan), plan.title).toEqual([]);
  });

  it("without the switch the market's shop partition stands through the floor above", () => {
    P5.wallsUnderCeiling = false;
    expect(overCeiling(sweepPlan("market-street-v3", 3507073702)).length).toBeGreaterThan(0);
  });
});
