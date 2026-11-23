/**
 * Generator 5 (`pieceFacts`): a piece the facts measured in game keep to one place (a stair rail, an end-post piece,
 * glowing decor: gen/pieceFacts.ts) is left out where a pool of candidates is formed (palette/traitPools.ts
 * `drawsFreely`: every trait pool, a recipe slot's roles, an object part's stand-in roles), so no consumer can draw one
 * by forgetting a filter. Before the rule moved there, the generic palette's panel pool held both odd rails and its
 * clutter pool the glowing jug; no stored plan's build drew one (checked over every stored plan at generator 5).
 */
import { describe, expect, it } from "vitest";
import { pieceFacts, standsAnywhere } from "../../../src/gen/pieceFacts";
import { bundledPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { TRAIT_IDS } from "../../../src/palette/traits";
import { resolvePlan } from "../../../src/resolve";
import { fillSlot } from "../../../src/resolve/recipes/slots";
import { RECIPES } from "../../../src/resolve/recipes/table";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const keptToOnePlace = (name: string | undefined): boolean => !standsAnywhere(name);

describe("piece facts where pools are formed (generator 5, pieceFacts)", () => {
  it("names pieces the facts keep to one place", () => {
    for (const name of ["railing 01 B", "railing 01 C", "jug green"])
      expect(keptToOnePlace(name), name).toBe(true);
    expect(pieceFacts("railing 01 C").endPost).toBe("low");
  });

  it("no trait pool of any bundled theme holds one at generator 5; generator 4's pools are as they were", () => {
    const roles5 = createPlanRoles(pal, 5);
    for (const theme of Object.keys(pal.palettes))
      for (const trait of TRAIT_IDS)
        for (const q of [{ trait }, { trait, stopAt: "theme" as const }])
          for (const p of roles5.pool(theme, q).pieces)
            expect(keptToOnePlace(p.variant.name), `${theme} ${trait} ${p.variant.name ?? ""}`).toBe(false);
    // (released generators draw what they drew)
    const generic4 = createPlanRoles(pal, 4).pool("generic", { trait: "panel" });
    expect(generic4.pieces.some((p) => keptToOnePlace(p.variant.name))).toBe(true);
  });

  it("no recipe slot's roles hand one out, and no build of the recipe fixtures places one", () => {
    const roles = createPlanRoles(pal, 5);
    // the roles that list such pieces, asked as a slot with no shape: the level rail is handed out, the others never
    let rails = 0;
    for (const theme of Object.keys(pal.palettes))
      for (const role of ["wall.railing", "feature.clutter", "feature.goods"]) {
        const got = fillSlot(roles, theme, { roles: () => [{ role }], fallback: "skip" }, null, "");
        for (const p of got?.pieces ?? []) {
          expect(keptToOnePlace(p.variant.name), `${theme} ${role} ${p.variant.name ?? ""}`).toBe(false);
          if (p.variant.name === "railing 01 A") rails++;
        }
      }
    expect(rails).toBeGreaterThan(0);
    expect(RECIPES.length).toBeGreaterThan(0);
    for (const id of ["railed-terrace-v1", "wall-recipes-v1", "varied-street-v1"] as const) {
      const r = resolvePlan(loadPlan(id, { generator: 5 }), pal);
      for (const L of r.levels)
        for (const a of L.arrangements ?? [])
          for (const p of a.pieces) {
            const v = roles
              .resolve(roles.paletteTheme(p.palette), p.role)
              .resolution?.variants.find((q) => q.wanted === p.asset);
            expect(keptToOnePlace(v?.name), `${id} ${a.recipe} ${v?.name ?? p.asset}`).toBe(false);
          }
    }
  });
});
