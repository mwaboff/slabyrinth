/**
 * Generator 4 (`waysInKeepClear`): no generated blocking piece stands in front of a way in, nor reaches over it with
 * its real outline: a dense scatter of trees round a hut leaves its door usable (verify finds no blocked door), and a
 * scatter of trees and boulders over a stall row leaves every stall's front lane clear.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan, TerrainOp } from "../../../src/contracts/plan";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { compileResolved } from "../../../src/compile";
import { SIDE_STEP } from "../../../src/gen/gridGeometry";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const SEEDS = Array.from({ length: 10 }, (_, i) => Math.imul(i + 1, 2654435761) >>> 0);

/** A plan with more scatter ops on its first level, under a seed. */
function withScatter(name: "outdoor-scatter" | "stall-lineup-v1", seed: number, ops: TerrainOp[]): MapPlan {
  const plan = { ...loadPlan(name, { generator: 4 }), seed };
  const [l0, ...rest] = plan.levels;
  if (!l0) throw new Error("no level");
  return { ...plan, levels: [{ ...l0, terrain: [...l0.terrain, ...ops] }, ...rest] };
}

describe("ways in keep clear (generator 4)", () => {
  it("a dense wood round a hut never stands in front of its door", () => {
    const pal = bundledPalettes();
    for (const seed of SEEDS) {
      const plan = withScatter("outdoor-scatter", seed, [
        { id: "wood", op: "scatter", feature: "tree", density: 0.6, minSpacing: 1 },
        { id: "stones", op: "scatter", feature: "boulder", density: 0.3 },
      ]);
      const bundle = compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "t", plan });
      const blocked = bundle.diagnostics.filter((d) => d.code === "verify_door_blocked");
      expect(
        blocked.map((d) => d.message),
        `seed ${seed}`,
      ).toEqual([]);
    }
  });

  it("trees and boulders scattered over a stall row keep every stall's front lane clear", () => {
    const pal = bundledPalettes();
    for (const seed of SEEDS) {
      const plan = withScatter("stall-lineup-v1", seed, [
        { id: "wood", op: "scatter", feature: "tree", density: 0.6, minSpacing: 1, avoid: [] },
        { id: "stones", op: "scatter", feature: "boulder", density: 0.4, avoid: [] },
      ]);
      const L = resolvePlan(plan, pal).levels[0] as ResolvedLevel;
      const lane = new Set<string>();
      for (const f of L.features) {
        if (!f.stall) continue;
        const [dx, dy] = SIDE_STEP[f.stall.front];
        const x0 = dx > 0 ? f.at[0] + f.size[0] : dx < 0 ? f.at[0] - 1 : f.at[0];
        const y0 = dy > 0 ? f.at[1] + f.size[1] : dy < 0 ? f.at[1] - 1 : f.at[1];
        for (let k = 0; k < (dx === 0 ? f.size[0] : f.size[1]); k++)
          lane.add(dx === 0 ? `${x0 + k},${y0}` : `${x0},${y0 + k}`);
      }
      expect(lane.size, `seed ${seed}: the row has stalls`).toBeGreaterThan(0);
      for (const f of L.features) {
        if (f.generatedBy !== "wood" && f.generatedBy !== "stones") continue;
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
            expect(lane.has(`${x},${y}`), `seed ${seed}: ${f.id} at ${x},${y} in a stall's lane`).toBe(false);
      }
    }
  });
});
