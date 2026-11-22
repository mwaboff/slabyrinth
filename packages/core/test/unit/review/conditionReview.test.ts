/**
 * The review over generator 5's condition treatments (condition-street-v1): a ruin by bays has its roof open over the
 * lost bay, so the walls fallen there hold up nothing (roof_unsupported does not fire); a worn building's foot growth is
 * the wallFootGrowth recipe's, not growth heaps, and the weathering signs count it.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedStructure } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { roofUnsupportedEdges, weatherMeasures } from "../../../src/resolve/ruin";
import { reviewDesign } from "../../../src/review";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
/** (seed 2654435761, the first sweep seed: the ruin's bay takes a corner, where a roofed wall falls under the hole) */
const plan = { ...loadPlan("condition-street-v1"), generator: 5 as const, seed: 2654435761 };
const resolved = resolvePlan(plan, pal);
const L = resolved.levels[0];
const building = (id: string): ResolvedStructure => {
  const st = L?.structures?.find((s) => s.id === id);
  if (!st) throw new Error(id);
  return st;
};

describe("the review over generator 5's condition treatments", () => {
  it("a ruin by bays: no roof hangs over a wall that fell under its open roof", () => {
    const ruins = (L?.structures ?? []).filter((s) => s.ruin?.bays !== undefined);
    expect(ruins.length).toBeGreaterThan(0);
    let underHoles = 0;
    for (const st of ruins) {
      expect(roofUnsupportedEdges(st)).toEqual([]);
      // the same building read without its bays (generator 4's reading) finds fallen walls under the roof holes
      const ruin = st.ruin;
      if (!ruin) continue;
      const noBays: ResolvedStructure = { ...st, ruin: { ...ruin } };
      delete noBays.ruin?.bays;
      underHoles += roofUnsupportedEdges(noBays).length;
    }
    expect(underHoles).toBeGreaterThan(0);
    const notes = reviewDesign(plan, resolved, pal, { limit: 999 });
    expect(notes.filter((n) => n.code === "roof_unsupported")).toEqual([]);
  });

  it("a worn building's foot growth counts among its weathering signs", () => {
    const worn = building("worn");
    const grown = (L?.arrangements ?? []).filter((a) => a.recipe === "wallFootGrowth" && a.host === "worn");
    expect(grown.length).toBeGreaterThan(0);
    const without = weatherMeasures(worn)?.baseGrowth ?? 0;
    const withGrowth = weatherMeasures(worn, L?.arrangements)?.baseGrowth ?? 0;
    expect(withGrowth).toBeGreaterThan(without);
  });
});
