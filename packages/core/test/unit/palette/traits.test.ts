/**
 * Shape traits (palette/traits.ts) and the theme-wide pool (palette/traitPools.ts): the classifier on made-up sizes,
 * what every bundled theme offers per trait (the counts snapshot the motif layer is designed against), the borrow-risk
 * and generator rules, and determinism.
 */
import { describe, expect, it } from "vitest";
import type { Palette, PaletteVariant } from "../../../src/contracts/compiler";
import { GENERATOR_VERSIONS } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { traitFilter } from "../../../src/palette/filters";
import { createPlanRoles } from "../../../src/palette/planRoles";
import type { ResolvePalettes } from "../../../src/palette/resolve";
import { pickFromPool, traitPool, traitQueryKey } from "../../../src/palette/traitPools";
import {
  TRAIT_IDS,
  borrowRisk,
  fitsShape,
  measurePiece,
  shapeKey,
  traitsOf,
  type TraitId,
} from "../../../src/palette/traits";

const LATEST = Math.max(...GENERATOR_VERSIONS);

const prop = (x: number, y: number, z: number): PaletteVariant["geom"] => ({
  size: { x, y, z },
  originAt: "center",
  boundsCenter: { x: 0, y: y / 2, z: 0 },
});
const tile = (x: number, y: number, z: number): PaletteVariant["geom"] => ({
  ...prop(x, y, z),
  originAt: "minCorner",
});

describe("the shape classifier", () => {
  it.each<[string, PaletteVariant["geom"], TraitId[]]>([
    ["a plank 2 x 0.1 x 0.3", prop(2, 0.1, 0.3), ["beam"]],
    ["a log 1.9 x 0.5 x 0.53", prop(1.9, 0.51, 0.53), ["beam"]],
    ["a beam along z", prop(0.2, 0.2, 3), ["beam"]],
    ["a wall filler post 0.5 x 2 x 0.5", tile(0.5, 2, 0.5), ["post"]],
    ["a stalagmite 0.2 x 2 x 0.17", prop(0.2, 2, 0.17), ["post"]],
    ["a corner pier 1 x 2 x 1", tile(1, 2, 1), ["post"]],
    ["a wall piece 2 x 2 x 0.5", tile(2, 2, 0.5), ["panel"]],
    ["a 1x1 wall piece 1 x 2 x 0.5 (a panel, not a post)", tile(1, 2, 0.5), ["panel"]],
    ["a fence 2 x 0.68 x 0.18", prop(2, 0.68, 0.18), ["panel"]],
    ["a floor tile 1 x 0.5 x 1", tile(1, 0.5, 1), ["slab"]],
    ["a rug 2 x 0.02 x 1.5", prop(2, 0.02, 1.5), ["slab"]],
    ["a whole-cell block", tile(1, 1, 1), ["block"]],
    ["a 2x2x2 block (also a mass)", tile(2, 2, 2), ["block", "mass"]],
    ["a cup", prop(0.2, 0.15, 0.2), ["clutter"]],
    ["a big tree 3 x 5 x 3", prop(3, 5, 3), ["mass"]],
    ["a chair 0.5 x 0.9 x 0.5: none", prop(0.5, 0.9, 0.5), []],
  ])("%s", (_, geom, traits) => {
    expect(traitsOf(geom)).toEqual(traits);
  });

  it("measures a piece in its own axes", () => {
    const m = measurePiece(prop(0.3, 0.2, 2.1));
    expect(m).toMatchObject({
      length: 2.1,
      width: 0.3,
      height: 0.2,
      thickness: 0.2,
      middle: 0.3,
      extent: 2.1,
    });
    expect(m.longAxis).toBe("z");
    expect(m.runAxis).toBe("z");
    expect(m.kind).toBe("prop");
    expect(measurePiece(tile(1, 1, 1))).toMatchObject({
      longAxis: null,
      runAxis: null,
      kind: "tile",
      slenderness: 1,
    });
    expect(measurePiece(tile(0.5, 2, 0.5)).longAxis).toBe("y");
  });

  it("survives a degenerate collider (a sign 0.0001 wide)", () => {
    expect(Number.isFinite(measurePiece(prop(0.0001, 1.4, 0.15)).slenderness)).toBe(true);
  });

  it("narrows by measures (inclusive) and kind", () => {
    const plank = prop(2, 0.1, 0.3);
    expect(fitsShape(plank, { trait: "beam", where: { length: [1.5, 2.5], thickness: [0, 0.3] } })).toBe(
      true,
    );
    expect(fitsShape(plank, { trait: "beam", where: { length: [2, 2] } })).toBe(true);
    expect(fitsShape(plank, { trait: "beam", where: { length: [2.1, 3] } })).toBe(false);
    expect(fitsShape(plank, { trait: "beam", kind: "tile" })).toBe(false);
    expect(fitsShape(plank, { trait: "slab" })).toBe(false);
  });

  it("keys a shape by every field, in a fixed order", () => {
    const a = shapeKey({ trait: "beam", where: { thickness: [0, 0.3], length: [1.5, 2.5] } });
    const b = shapeKey({ trait: "beam", where: { length: [1.5, 2.5], thickness: [0, 0.3] } });
    expect(a).toBe(b);
    expect(a).not.toBe(shapeKey({ trait: "beam", where: { length: [1.5, 2.5] } }));
    expect(shapeKey({ trait: "beam", kind: "prop" })).not.toBe(shapeKey({ trait: "beam" }));
    expect(traitFilter({ trait: "beam" }).key).toBe(shapeKey({ trait: "beam" }));
    expect(traitQueryKey({ trait: "beam", allow: ["light", "opening"] })).toBe(
      traitQueryKey({ trait: "beam", allow: ["opening", "light"] }),
    );
  });
});

describe("borrow risk", () => {
  it.each([
    ["opening.door", "opening"],
    ["opening.door.shop", "opening"],
    ["link.stairs", "passage"],
    ["stairs.rock", "passage"],
    ["light.window", "light"],
    ["wall_light.stone", "light"],
    ["stall.light", "light"],
    ["feature.torch_wall", "light"],
    ["feature.spawn_point", "gm_only"],
    ["marker.alignment", "marker"],
    ["feature.log", null],
    ["wall.fence", null],
    ["feature.not_a_type", null],
  ])("%s → %s", (role, risk) => {
    expect(borrowRisk(role)).toBe(risk);
  });
});

/** A catalog of one made-up theme over generic. */
function catalogWith(roles: Palette["roles"]): ResolvePalettes {
  const base = bundledPalettes();
  const test: Palette = {
    schema: "slabyrinth/palette@1",
    id: "test_theme",
    name: "Test",
    extends: "generic",
    defaults: { floor: "stone_tile", wallStyle: "stone" },
    roles,
  };
  return { ...base, palettes: { ...base.palettes, test_theme: test } };
}
const asset = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const variant = (n: number, geom: PaletteVariant["geom"]): PaletteVariant => ({
  asset: asset(n),
  name: `p${n}`,
  geom,
});

describe("the theme-wide pool", () => {
  it("takes the theme's own pieces first, in role-name order, one piece per asset", () => {
    const cat = catalogWith({
      "feature.zz": { variants: [variant(1, prop(2, 0.1, 0.2))] },
      "feature.aa": { variants: [variant(2, prop(1.5, 0.1, 0.2)), variant(1, prop(2, 0.1, 0.2))] },
    });
    const pool = traitPool(cat, "test_theme", { trait: "beam" }, LATEST);
    expect(pool.paletteId).toBe("test_theme");
    expect(pool.pieces.map((p) => [p.variant.uuid, p.roles])).toEqual([
      [asset(2), ["feature.aa"]],
      [asset(1), ["feature.aa", "feature.zz"]],
    ]);
    expect(pool.pieces[0]?.measures.length).toBe(1.5);
  });

  it("falls back down the theme's chain to generic when the theme has none of the shape", () => {
    const cat = catalogWith({ "feature.aa": { variants: [variant(1, prop(0.2, 0.2, 0.2))] } });
    const pool = traitPool(cat, "test_theme", { trait: "beam" }, LATEST);
    expect(pool.path).toEqual(["test_theme", "generic"]);
    expect(pool.paletteId).toBe("generic");
    expect(pool.pieces.length).toBeGreaterThan(0);
  });

  it("leaves out risky roles' pieces unless allowed, wherever the chain lists them", () => {
    const door = variant(3, tile(1, 2, 0.25));
    const cat = catalogWith({
      "opening.door": { variants: [door] },
      "feature.wall_dressing": { variants: [door, variant(4, tile(2, 2, 0.25))] },
    });
    const plain = traitPool(cat, "test_theme", { trait: "panel" }, LATEST);
    expect(plain.pieces.map((p) => p.variant.uuid)).toEqual([asset(4)]);
    const allowed = traitPool(cat, "test_theme", { trait: "panel", allow: ["opening"] }, LATEST);
    expect(allowed.pieces.map((p) => [p.variant.uuid, p.roles])).toEqual([
      [asset(3), ["feature.wall_dressing", "opening.door"]],
      [asset(4), ["feature.wall_dressing"]],
    ]);
  });

  it("hides roles the generator does not see", () => {
    const cat = catalogWith({ "feature.aa": { minGenerator: 9, variants: [variant(1, prop(2, 0.1, 0.2))] } });
    expect(traitPool(cat, "test_theme", { trait: "beam" }, LATEST).paletteId).toBe("generic");
    expect(traitPool(cat, "test_theme", { trait: "beam" }, 9).paletteId).toBe("test_theme");
  });

  it("is a pure function of the palette data: role insertion order and a fresh catalog change nothing", () => {
    const roles = {
      "feature.b": { variants: [variant(1, prop(2, 0.1, 0.2))] },
      "feature.a": { variants: [variant(2, prop(2, 0.2, 0.2))] },
      "feature.c": { variants: [variant(5, prop(3, 0.2, 0.2))] },
    };
    const reversed = Object.fromEntries(Object.entries(roles).reverse());
    const a = traitPool(catalogWith(roles), "test_theme", { trait: "beam" }, LATEST);
    const b = traitPool(catalogWith(reversed), "test_theme", { trait: "beam" }, LATEST);
    expect(b).toEqual(a);
    for (const theme of Object.keys(bundledPalettes().palettes)) {
      expect(traitPool(bundledPalettes(), theme, { trait: "panel" }, LATEST)).toEqual(
        traitPool(bundledPalettes(), theme, { trait: "panel" }, LATEST),
      );
    }
  });

  it("picks deterministically by hash parts, spreading over the pool", () => {
    const pool = traitPool(bundledPalettes(), "generic", { trait: "clutter" }, LATEST);
    const picks = Array.from({ length: 40 }, (_, i) => pickFromPool(pool, 7, "test", i)?.variant.uuid);
    expect(Array.from({ length: 40 }, (_, i) => pickFromPool(pool, 7, "test", i)?.variant.uuid)).toEqual(
      picks,
    );
    expect(new Set(picks).size).toBeGreaterThan(5);
    // pinned: a change to the order or the draw moves this
    expect(pickFromPool(pool, 7, "test", 0)?.variant.name).toMatchInlineSnapshot(`"jug 01"`);
    expect(pickFromPool({ ...pool, pieces: [] }, 7)).toBeUndefined();
  });

  it("is asked through PlanRoles, memoized, with a theme that has no palette asked as the default theme", () => {
    const roles = createPlanRoles(bundledPalettes(), LATEST);
    const q = { trait: "beam" as const, where: { length: [1.5, 2.5] as const } };
    expect(roles.pool("cave", q)).toBe(roles.pool("cave", { ...q }));
    expect(roles.pool("no_such_theme", q)).toBe(roles.pool("generic", q));
  });
});

describe("what each bundled theme offers per trait", () => {
  const cat = bundledPalettes();
  const themes = Object.keys(cat.palettes).sort();
  const pools = themes.map((theme) => ({
    theme,
    byTrait: TRAIT_IDS.map((trait) => traitPool(cat, theme, { trait }, LATEST)),
  }));

  it("every bundled theme has a candidate for every trait after fallback", () => {
    const gaps = pools.flatMap(({ theme, byTrait }) =>
      byTrait.flatMap((p, i) => (p.pieces.length === 0 ? [`${theme}:${TRAIT_IDS[i] ?? ""}`] : [])),
    );
    expect(gaps).toEqual([]);
  });

  it("no kit role lends a piece by shape (the ship kit is asked by its roles only)", () => {
    const kitRoles = pools.flatMap(({ byTrait }) =>
      byTrait.flatMap((p) => p.pieces.flatMap((q) => q.roles.filter((r) => r.startsWith("ship.")))),
    );
    expect(Object.keys(cat.palettes["generic"]?.roles ?? {}).some((r) => r.startsWith("ship."))).toBe(true);
    expect(kitRoles).toEqual([]);
  });

  it("matches the counts snapshot (own = pieces in the theme's palette; else where the pool fell back to)", async () => {
    const width = 18;
    const cell = (s: string): string => s.padEnd(width);
    const lines = [
      `generator ${LATEST}; borrowable pieces of each trait (risky roles left out, one per asset)`,
      "",
      cell("theme") + TRAIT_IDS.map(cell).join("").trimEnd(),
      ...pools.map(
        ({ theme, byTrait }) =>
          cell(theme) +
          byTrait
            .map((p) =>
              cell(
                p.paletteId === theme
                  ? String(p.pieces.length)
                  : `0 -> ${p.paletteId ?? "none"}:${p.pieces.length}`,
              ),
            )
            .join("")
            .trimEnd(),
      ),
    ];
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("__golden__/traitCounts.txt");
  });
});
