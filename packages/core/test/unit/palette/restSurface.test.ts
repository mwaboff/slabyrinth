/**
 * Where a thing set on a piece rests (palette/restSurface.ts, generator 6 `restSurfaces`): things set on furniture stand
 * on its real top surface (the table's coverage and guards: measuredTables.test.ts).
 */
import { describe, expect, it } from "vitest";
import { loadPalettes, measuredRest, paletteView, restHeight, restPieces } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";

describe("the measured rest table (palette/restHeights.ts)", () => {
  const pieces = restPieces(loadPalettes().palettes);

  it("holds plausible heights: above the floor, and not far over the collider", () => {
    for (const p of pieces) {
      const rest = measuredRest(p.asset, p.geom);
      if (rest === undefined) continue;
      expect(rest, p.name).toBeGreaterThan(0);
      expect(rest, p.name).toBeLessThanOrEqual(p.geom.size.y + 0.25);
    }
  });

  it("a measured piece rests on its real top only where the switch is on; an unknown one keeps its box top", () => {
    const bench = pieces.find((p) => p.name === "Workbench");
    if (!bench) throw new Error("fixture: the bundled palettes have a Workbench");
    expect(restHeight(bench.asset, bench.geom, false)).toBe(bench.geom.size.y);
    // the bench's raised back reaches 1.11; its work top is about 0.35 lower
    expect(restHeight(bench.asset, bench.geom, true)).toBeLessThan(bench.geom.size.y - 0.3);
    expect(restHeight("00000000-0000-0000-0000-000000000000", bench.geom, true)).toBe(bench.geom.size.y);
  });
});

describe("things set on furniture stand on its real top surface (generator 6, restSurfaces)", () => {
  // the room view's answer for a workbench (feature.counter), at generator 5 and 6
  it("the palette view's rest is the box top before generator 6 and the measured top from it", () => {
    const cat = loadPalettes();
    const v5 = paletteView(cat, 5).roomPiece("wood_town", "counter");
    const v6 = paletteView(cat, 6).roomPiece("wood_town", "counter");
    if (!v5 || !v6) throw new Error("fixture: wood_town has a counter");
    expect(v5.restMax).toBe(v5.hMax);
    expect(v6.restMax).toBeLessThan(v6.hMax - 0.3);
  });

  it("an inn kitchen's jugs and plates stand on its workbenches' work tops, not 0.35 above them", () => {
    const lifts = (generator: 5 | 6): number[] => {
      const plan = { ...loadPlan("inn-interior-v1"), generator };
      const r = resolvePlan(plan, loadPalettes());
      const out: number[] = [];
      for (const L of r.levels) {
        const benches = L.features.filter((f) => f.type === "counter");
        for (const f of L.features) {
          if (f.type !== "clutter") continue;
          const under = benches.find(
            (b) =>
              f.at[0] >= b.at[0] &&
              f.at[0] < b.at[0] + b.size[0] &&
              f.at[1] >= b.at[1] &&
              f.at[1] < b.at[1] + b.size[1],
          );
          if (under) out.push(f.baseHeight - under.baseHeight);
        }
      }
      return out;
    };
    const before = lifts(5);
    const after = lifts(6);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    const bench = restPieces(loadPalettes().palettes).find((p) => p.name === "Workbench");
    const rest = bench ? measuredRest(bench.asset, bench.geom) : undefined;
    if (!bench || rest === undefined) throw new Error("fixture: the Workbench is measured");
    for (const h of before) expect(h).toBeCloseTo(bench.geom.size.y, 3);
    for (const h of after) expect(h).toBeCloseTo(rest, 3);
  });
});
