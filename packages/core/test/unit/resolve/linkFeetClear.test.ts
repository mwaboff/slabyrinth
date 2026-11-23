/**
 * `landingsKeepClear` (generator 5): where people step on and off a level link is a way in. The review asked whether a
 * ladder's or a spiral stair's foot on its LOWER level is kept clear, since `linkLandingsOnLevel` lists only the upper
 * level's ring for them. Measured here: no generated blocking piece stands in a cell beside a ladder's or a spiral
 * stair's lower footprint over twelve seeds of a furnished study (with a control that the study does get generated
 * blocking pieces), so nothing needed fixing; the test keeps it so.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { featureInfo } from "../../../src/gen/catalog";
import { bundledPalettes } from "../../../src/palette";
import { linkGeometry } from "../../../src/plan/links";
import { resolvePlan } from "../../../src/resolve";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
type Kind = "ladder" | "spiral_stairs";

/** multi-level-stairs with its study's ladder as `kind`, standing in the study, at sweep seed `seed`. */
function planWith(kind: Kind, seed: number): MapPlan {
  const plan = structuredClone(sweepPlan("multi-level-stairs", seed));
  for (const l of plan.links)
    if (l.id === "ladder1") Object.assign(l, { kind, from: { ...l.from, at: [2, 6] } });
  return plan;
}

/** Generated blocking pieces in the study: beside the link's lower footprint, and anywhere. */
function count(kind: Kind, seeds: readonly number[]): { onFoot: number; inRoom: number } {
  let onFoot = 0;
  let inRoom = 0;
  for (const seed of seeds) {
    const plan = planWith(kind, seed);
    const link = plan.links.find((l) => l.id === "ladder1");
    const lo = plan.levels.find((l) => l.id === link?.from.level);
    const up = plan.levels.find((l) => l.id === link?.to.level);
    if (!link || !lo || !up) throw new Error("no link");
    const lower = linkGeometry(link, lo.elevation, up.elevation).lowerCells;
    const own = new Set(lower.map(([x, y]) => `${x},${y}`));
    const ring = new Set<string>();
    for (const [x, y] of lower)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const)
        if (!own.has(`${x + dx},${y + dy}`)) ring.add(`${x + dx},${y + dy}`);
    const L = resolvePlan(plan, pal).levels.find((l) => l.id === lo.id);
    for (const f of L?.features ?? []) {
      if (f.generatedBy === undefined || !featureInfo(f.type).blocking) continue;
      inRoom++;
      if (ring.has(`${f.at[0]},${f.at[1]}`)) onFoot++;
    }
  }
  return { onFoot, inRoom };
}

describe("landingsKeepClear: a ladder's and a spiral stair's foot on its lower level", () => {
  const seeds = sweepSeeds(12);
  it.each(["ladder", "spiral_stairs"] as const)(
    "no generated blocking piece stands beside a %s's foot (the room has some elsewhere)",
    (kind) => {
      const n = count(kind, seeds);
      expect(n.inRoom).toBeGreaterThan(20);
      expect(n.onFoot).toBe(0);
    },
    30_000, // (12 builds of a three-level plan)
  );
});
