/**
 * The board's one water plane and the floors of other levels (generator 5, switch `waterUnderFloors`,
 * resolve/level/waterSurface.ts capWaterUnderOtherFloors). A harbour: a sea cut 4 tiles down and painted deep water, a
 * floorless berth in it, and below it a hold whose floor stands 2 tiles above the sea bed. TaleSpire's plane floods
 * every floor under it, so the water range stays under the hold's floor, and the compile advice says so. A hold too
 * low for any water the sea needs gets a water_level warning; generator 4 keeps its old surface.
 */
import { describe, expect, it } from "vitest";
import type { Level, MapPlan } from "../../../src/contracts/plan";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { oneLevelPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

function harbour(generator: 4 | 5, holdElevation: number): MapPlan {
  const p = oneLevelPlan({
    generator,
    w: 24,
    h: 16,
    levelId: "harbour",
    base: { type: "ground", material: "cobble" },
    level: {
      terrain: [
        {
          id: "bed",
          op: "height",
          shape: { type: "rect", x: 0, y: 0, w: 24, h: 11 },
          set: -4,
          edge: "clean",
        },
        { id: "sea", op: "paint", shape: { type: "rect", x: 0, y: 0, w: 24, h: 11 }, material: "water_deep" },
      ],
      areas: [
        {
          id: "berth",
          kind: "courtyard",
          name: "Berth",
          floor: "none",
          walls: "none",
          shape: { type: "rect", x: 6, y: 3, w: 10, h: 5 },
        },
      ],
    },
  });
  const sea = p.levels[0] as Level;
  const hold: Level = {
    ...sea,
    id: "hold",
    name: "hold",
    elevation: holdElevation,
    base: { type: "void" },
    terrain: [],
    areas: [
      {
        id: "cargo",
        kind: "room",
        name: "Cargo",
        floor: "wood_plank",
        shape: { type: "rect", x: 7, y: 4, w: 8, h: 3 },
      },
    ],
  };
  return { ...p, entryLevel: "harbour", levels: [hold, sea] };
}

const water = (p: MapPlan) => {
  const r = resolvePlan(p, pal);
  return { r, L: r.levels.find((l) => l.id === "harbour") };
};

describe("water under the floors of other levels (generator 5)", () => {
  it("keeps the water range a quarter under the hold's floor, and the advice with it", () => {
    const { r, L } = water(harbour(5, -2.5));
    // the hold's floor top: -2.5 + 0.5 = -2
    expect(L?.waterRange?.[1]).toBe(-2.25);
    expect(L?.waterLevel).toBeLessThanOrEqual(-2.25);
    const plan = harbour(5, -2.5);
    const advice = compileResolved(r, pal, slabCodec, { plan, createdAt: "t" }).diagnostics.find(
      (d) => d.code === "verify_water_level",
    );
    // the slab's bottom is the sea bed's underside (-4): the water at most 1.75 above it
    expect(advice?.message).toMatch(/and 1\.75 fills/);
    expect(r.issues.filter((i) => i.code === "water_level")).toEqual([]);
  });

  it("warns when even the lowest water the sea needs would flood the hold", () => {
    // (the hold's floor at -3.5, level with the sea bed's top)
    const { r } = water(harbour(5, -4));
    expect(r.issues.some((i) => i.code === "water_level" && i.elementId === "hold")).toBe(true);
  });

  it("generator 4 keeps the surface it set from the harbour alone", () => {
    const { L } = water(harbour(4, -2.5));
    expect(L?.waterRange).toBeUndefined();
    expect(L?.waterLevel).toBeGreaterThan(-2);
  });
});
