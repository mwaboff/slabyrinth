/**
 * The plan's size limits stay honest: a multi-chunk plan validates and builds into chunks whose every coordinate is in
 * the slab format's range, pasted from beside the map, and the box the largest plan the limits allow could need fits
 * the coordinate range with room to spare. (The slow cap builds, a forest level at PLAN_LIMITS.levelSide and two dense
 * dungeon levels at the limit, run in the sweep: test/sweep/run.ts; the timings behind the limits come from
 * test/sweep/sizes.ts.)
 */
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, type Level, type MapPlan } from "../../../src/contracts/plan";
import { besideMapBox, compileResolved, MARKER_GAP_CELLS } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan/validate";
import { planRules, resolvePlan } from "../../../src/resolve/index";
import { SLAB_LIMITS, decodeDetailed, slabCodec } from "../../../src/slab";
import { largeOutdoorPlan } from "../../fixtures/largePlan";

const cat = loadPalettes();
const side = PLAN_LIMITS.levelSide;

describe("plan size limits", () => {
  it("the limits are the ones measured (320 cells a side, 8 levels, 8 x 160 x 160 cells together)", () => {
    expect(PLAN_LIMITS.levelSide).toBe(320);
    expect(PLAN_LIMITS.levels).toBe(8);
    expect(PLAN_LIMITS.totalCells).toBe(8 * 160 * 160);
  });

  it("a multi-chunk level validates and builds: every chunk under the byte cap, every coordinate in range", () => {
    // the mechanism does not depend on the size; the level at the side limit builds in the sweep (its size caps)
    const plan = largeOutdoorPlan(120);
    expect(validatePlan(plan, planRules(cat)).issues.filter((i) => i.severity === "error")).toEqual([]);
    const b = compileResolved(resolvePlan(plan, cat), cat, slabCodec, { createdAt: "t", plan, fill: 0.2 });
    expect(b.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(b.chunks.length).toBeGreaterThan(1);
    expect(b.pasteAnchor?.side).toBe("south");
    for (const c of b.chunks) {
      expect(c.compressedBytes).toBeLessThanOrEqual(SLAB_LIMITS.maxCompressedBytes);
      for (const a of decodeDetailed(c.slab).assets)
        expect(Math.max(a.sx, a.sy, a.sz)).toBeLessThanOrEqual(SLAB_LIMITS.maxCoord);
    }
  });

  it("one level past the side limit, or more cells together than the limit, is refused", () => {
    // the limits are structural checks: no resolve needed
    const structural = { checks: [] };
    const wide = largeOutdoorPlan(side);
    const level = wide.levels[0];
    if (level) level.bounds.w = side + 1;
    expect(validatePlan(wide, structural).issues.some((i) => i.code === "bounds_exceeded")).toBe(true);
    // three levels at the side limit are more cells than the plan may have together (two are exactly the limit)
    const bare = (levels: number): MapPlan => {
      const plan = largeOutdoorPlan(side);
      const g = plan.levels[0] as Level;
      plan.levels = Array.from({ length: levels }, (_, k) => ({
        ...g,
        id: `g${k}`,
        elevation: 4 * k,
        terrain: [],
      }));
      return plan;
    };
    const issue = validatePlan(bare(3), structural).issues.find((i) => i.code === "limit_exceeded");
    expect(issue?.path).toBe("/levels");
    expect(validatePlan(bare(2), structural).issues.some((i) => i.code === "limit_exceeded")).toBe(false);
  });

  it("the paste box of the deepest plan the limits allow fits the coordinate range with room to spare", () => {
    // a map side of the limit, plus the deepest the build may stand above or below its floor (8 levels of the
    // plan's height range: 8 storeys plus the tallest piece), pasted from beside the map
    const box = besideMapBox({ x: 0, z: 0 }, { x: side, z: side });
    const across = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const up =
      PLAN_LIMITS.levels * (PLAN_LIMITS.maxHeight - PLAN_LIMITS.minHeight) + 2 * (1 + MARKER_GAP_CELLS);
    const tiles = SLAB_LIMITS.maxCoord / 100;
    expect(across).toBeLessThan(tiles / 2);
    expect(up).toBeLessThan(tiles / 2);
  });
});
