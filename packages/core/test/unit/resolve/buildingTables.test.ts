/**
 * Building knowledge lives as fields of its tables (resolve/roofTypes.ts ROOF_TYPE_INFO, resolve/designDetails.ts
 * DESIGN_DETAIL_INFO, gen/wallStyles.ts WALL_STYLE_INFO), never as lists of names in the code that reads it. These pin
 * the rows that replaced such lists, so moving a trait cannot quietly change which names carry it.
 */
import { describe, expect, it } from "vitest";
import { ROOF_TYPES, type RoofType, type WallStyle } from "../../../src/contracts/plan";
import { WALL_STYLE_INFO } from "../../../src/gen/wallStyles";
import { DESIGN_DETAIL_INFO, firstHungDetail } from "../../../src/resolve/designDetails";
import { ROOF_TYPE_INFO } from "../../../src/resolve/roofTypes";
import { STRUCTURE_STYLES } from "../../../src/resolve/structureStyles";

const roofs = Object.keys(ROOF_TYPE_INFO) as RoofType[];
const roofsWith = (t: "built" | "closing" | "deck" | "rect" | "pitched"): RoofType[] =>
  roofs.filter((r) => ROOF_TYPE_INFO[r][t]).sort();

describe("roof-type traits are table fields", () => {
  it("covers every roof type of the plan", () => {
    expect([...roofs].sort()).toEqual([...ROOF_TYPES].sort());
  });

  it("the lists the building planner kept by hand are the rows", () => {
    // BUILT_ROOFS
    expect(roofsWith("built")).toEqual(["flat", "gable", "hip", "none", "shed", "skirt", "spire", "stepped"]);
    // CLOSING
    expect(roofsWith("closing")).toEqual(["flat", "gable", "hip", "none", "shed", "spire"]);
    // DECK_ROOFS
    expect(roofsWith("deck")).toEqual(["flat", "none", "skirt", "stepped"]);
    // RECT_ROOFS
    expect(roofsWith("rect")).toEqual(["gable", "hip", "shed", "skirt", "spire", "stepped"]);
    // ["gable", "hip", "shed"] in condition, roof geometry and the compiler
    expect(roofsWith("pitched")).toEqual(["gable", "hip", "shed"]);
    // the cone the planner turned into a spire by name
    expect(roofs.filter((r) => ROOF_TYPE_INFO[r].as !== undefined)).toEqual(["cone"]);
    expect(ROOF_TYPE_INFO.cone.as).toBe("spire");
  });
});

describe("design-detail traits are table fields", () => {
  it("a weathered building loses its canopy, then balconies, then a fire escape", () => {
    expect(firstHungDetail(["fire_escape", "balconies", "canopy"])).toBe("canopy");
    expect(firstHungDetail(["fire_escape", "balconies", "piers"])).toBe("balconies");
    expect(firstHungDetail(["services", "fire_escape"])).toBe("fire_escape");
    expect(firstHungDetail(["piers", "services", "awning", "balcony"])).toBeUndefined();
  });

  it("every detail a building style draws has a row", () => {
    const drawn = Object.entries(STRUCTURE_STYLES).flatMap(([id, style]) =>
      [style.design?.details, style.design?.buildingVariety?.details].flatMap((w) =>
        Object.keys(w ?? {}).map((d) => [id, d] as const),
      ),
    );
    expect(drawn.length).toBeGreaterThan(5);
    for (const [id, d] of drawn) expect(Object.hasOwn(DESIGN_DETAIL_INFO, d), `${id}: ${d}`).toBe(true);
  });
});

describe("wall-style traits are table fields", () => {
  it('only plank walls ruin as their own planks (the timber test `walls === "wood"`)', () => {
    const planks = (Object.keys(WALL_STYLE_INFO) as WallStyle[]).filter((s) => WALL_STYLE_INFO[s].planks);
    expect(planks).toEqual(["wood"]);
  });
});
