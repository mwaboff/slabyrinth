/**
 * A stair's foot and landing stay clear (generator 5, switch landingsKeepClear; found by the seed sweep once it read
 * playability): a study's furnisher set a chair on the landing of the stairs up from the foyer (multi-level-stairs, 80
 * seeds in 150), and a hall's dress op its rubble on the landing of the crypt stairs (keep-dungeon-v8), so nobody could
 * step off the stairs and every level above was cut off. The landing was no way in to the placers: only a door's sides
 * were.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { linkLandingsOnLevel } from "../../../src/plan/links";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** The generated blocking pieces on a stair's foot or landing, and the link and reach issues of the build. */
function measure(seed: number): { onLanding: string[]; issues: string[] } {
  const plan = sweepPlan("multi-level-stairs", seed, 5);
  const r = resolvePlan(plan, pal);
  const onLanding: string[] = [];
  for (const L of r.levels) {
    const cells = new Set(linkLandingsOnLevel(plan, L.id).map(([x, y]) => `${x},${y}`));
    for (const f of L.features)
      if (f.generatedBy !== undefined && f.blocking)
        for (let dy = 0; dy < f.size[1]; dy++)
          for (let dx = 0; dx < f.size[0]; dx++)
            if (cells.has(`${f.at[0] + dx},${f.at[1] + dy}`)) onLanding.push(`${L.id} ${f.id}`);
  }
  const issues = checkPlayability(plan, r)
    .filter((i) => i.code === "link_approach_blocked" || i.code === "unreachable")
    .map((i) => `${i.code} ${i.elementId ?? ""}`);
  return { onLanding, issues };
}

describe("a stair's foot and landing stay clear (landingsKeepClear)", () => {
  it("the landings are the cell before the first step and the cell beyond the last", () => {
    const plan = sweepPlan("multi-level-stairs", 1, 5);
    // stairs1 climbs north from 7,6 on the ground floor to the study, a run of three
    expect(linkLandingsOnLevel(plan, "ground")).toEqual([[7, 7]]);
    expect(linkLandingsOnLevel(plan, "study_lvl")).toEqual([[7, 3]]);
    // the ladder from the study comes up through the roof at 2,7: its landing is the cells round the opening
    expect(linkLandingsOnLevel(plan, "roof")).toEqual([
      [2, 6],
      [3, 7],
      [2, 8],
      [1, 7],
    ]);
  });

  it("nothing generated blocks the study's landing, and every level is reached (multi-level-stairs@1013904226)", () => {
    expect(measure(1013904226)).toEqual({ onLanding: [], issues: [] });
  }, 30_000);

  it("without the switch the study's chair stands on the landing and cuts off the levels above", () => {
    P5.landingsKeepClear = false;
    const off = measure(1013904226);
    expect(off.onLanding).toContain("study_lvl study~room#2");
    expect(off.issues).toContain("link_approach_blocked stairs1");
  }, 30_000);
});
