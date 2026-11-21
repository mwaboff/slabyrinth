/**
 * Building knowledge lives as fields of its tables (resolve/roofTypes.ts ROOF_TYPE_INFO, resolve/designDetails.ts
 * DESIGN_DETAIL_INFO, gen/wallStyles.ts WALL_STYLE_INFO), never as lists of names in the code that reads it. These pin
 * the rows that replaced such lists, so moving a trait cannot quietly change which names carry it.
 */
import { describe, expect, it } from "vitest";
import { ROOF_TYPES, type RoofType, type WallStyle } from "../../../src/contracts/plan";
import { WALL_STYLE_INFO } from "../../../src/gen/wallStyles";
import {
  OPEN_STOREY_WALLS,
  PART_FALLBACK_FLOORS,
  PART_FALLBACK_KITS,
  USE_DOOR_FAMILY,
  designDoorFamily,
  partWalls,
} from "../../../src/resolve/building/parts";
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

  it("the traits agree with each other", () => {
    for (const r of roofs) {
      const t = ROOF_TYPE_INFO[r];
      // a sloped roof needs a rectangle and closes the volume; nothing stands on a slope
      if (t.pitched) expect(t.rect && t.closing && !t.deck, r).toBe(true);
      // only a sloped roof has ridge ends; a flat roof is a closing deck
      if (t.ends !== null) expect(t.pitched, r).toBe(true);
      if (t.flat) expect(t.deck && t.closing, r).toBe(true);
      // a type built as another is not built itself
      if (t.as !== undefined) expect(t.built, r).toBe(false);
    }
  });

  it("the rows the released generators read keep the answers they shipped with", () => {
    // generators 2 and 3 plan buildings with these traits; their output is frozen
    expect(roofsWith("built")).toEqual(["flat", "gable", "hip", "none", "shed", "skirt", "spire", "stepped"]);
    expect(roofsWith("closing")).toEqual(["flat", "gable", "hip", "none", "shed", "spire"]);
    expect(roofsWith("deck")).toEqual(["flat", "none", "skirt", "stepped"]);
    expect(roofsWith("rect")).toEqual(["gable", "hip", "shed", "skirt", "spire", "stepped"]);
    expect(roofsWith("pitched")).toEqual(["gable", "hip", "shed"]);
    expect(roofs.filter((r) => ROOF_TYPE_INFO[r].ends !== null).sort()).toEqual(["gable", "hip"]);
    expect(roofs.filter((r) => ROOF_TYPE_INFO[r].flat)).toEqual(["flat"]);
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

describe("what a building's parts are built of (resolve/building/parts.ts)", () => {
  it("the frozen defaults keep the answers released builds asked for", () => {
    // once eight literals in compile/structure.ts; released slabs depend on every row
    expect(OPEN_STOREY_WALLS).toEqual({
      seam: "stone",
      lip: "stone",
      chimney: "stone",
      ruin: "stone",
      porch: "wood",
      doorLight: "wood",
      terraceLamp: "brick",
      signBand: "wall",
      details: "wall",
    });
    expect(PART_FALLBACK_FLOORS).toEqual({ stone: "flagstone", tile: "stone_tile" });
    expect(PART_FALLBACK_KITS).toEqual({ pitched: "slate", flat: "city", terrace: "durable" });
    expect(partWalls(null, "porch")).toBe("wood");
    expect(partWalls("brick", "porch")).toBe("brick");
  });

  it("a designed building's doors: its use's family, an era style's home door, else none", () => {
    expect(USE_DOOR_FAMILY).toEqual({
      shop: "shop",
      diner: "shop",
      office: "office",
      civic: "office",
      apartments: "home",
      townhouse: "home",
      warehouse: "works",
      garage: "works",
      workshop: "works",
    });
    const designed = (style: string, use: string): Parameters<typeof designDoorFamily>[0] =>
      ({ style, design: { use } }) as unknown as Parameters<typeof designDoorFamily>[0];
    expect(designDoorFamily(designed("modern_block", "garage"))).toBe("works");
    expect(designDoorFamily(designed("modern_block", "bakery"))).toBe("home");
    expect(designDoorFamily(designed("cottage", "bakery"))).toBeUndefined();
    expect(
      designDoorFamily({ style: "modern_block" } as Parameters<typeof designDoorFamily>[0]),
    ).toBeUndefined();
  });
});
