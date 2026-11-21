/** The material trait table (resolve/materials.ts) that replaced the literal material sets of the resolver. */
import { describe, expect, it } from "vitest";
import { MATERIALS, type Material } from "../../../src/contracts/plan";
import { MATERIAL_INFO, isNaturalGround, isWater, materialOrdinal } from "../../../src/resolve/materials";

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const having = (key: "water" | "natural" | "cliffGround"): Material[] =>
  MATERIALS.filter((m) => MATERIAL_INFO[m][key]);

describe("material traits", () => {
  it("has a row for every material and no other", () => {
    expect(sorted(Object.keys(MATERIAL_INFO))).toEqual(sorted(MATERIALS));
  });

  it("the two water depths are water, and water is not ground", () => {
    expect(sorted(having("water"))).toEqual(["water_deep", "water_shallow"]);
    for (const m of having("water")) expect(isNaturalGround(m), m).toBe(false);
    expect(isWater("flagstone")).toBe(false);
  });

  it("natural ground is earth, stone, snow and swamp, never a built or worked floor", () => {
    expect(sorted(having("natural"))).toEqual(
      sorted(["rock", "dirt", "grass", "sand", "gravel", "mud", "snow", "ice", "swamp"]),
    );
    for (const m of ["flagstone", "cobble", "wood_plank", "asphalt", "concrete"] as const)
      expect(isNaturalGround(m), m).toBe(false);
  });

  it("every natural ground cliffs as rock, and so does lava, which is not ground a path winds over", () => {
    expect(sorted(having("cliffGround"))).toEqual(sorted([...having("natural"), "lava"]));
    expect(isNaturalGround("lava")).toBe(false);
  });

  it("wooden decks sag as planks, natural ground spans as a land bridge, anything else arches", () => {
    expect(MATERIAL_INFO.bridge_wood.deckSpan).toBe("plank");
    expect(MATERIAL_INFO.wood_plank.deckSpan).toBe("plank");
    expect(MATERIAL_INFO.rock.deckSpan).toBe("natural");
    expect(MATERIAL_INFO.swamp.deckSpan).toBe("arch");
    expect(MATERIAL_INFO.flagstone.deckSpan).toBe("arch");
  });

  it("stores a material as its index in MATERIALS plus one (0 is no floor)", () => {
    expect(materialOrdinal("flagstone")).toBe(1);
    expect(MATERIALS[materialOrdinal("lava") - 1]).toBe("lava");
  });
});
