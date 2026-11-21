/**
 * Data-driven classification of catalog assets, the trustworthy catalog search, and runtime palette enrichment
 * from assets a game update adds (no code or palette change).
 */
import { describe, expect, it } from "vitest";
import type { AssetCatalog, CatalogAsset } from "../../../src/contracts/compiler";
import {
  classifyAsset,
  createAvailability,
  footprintOf,
  searchCatalog,
  sizeClass,
} from "../../../src/catalog";
import { buildPaletteCatalog, loadPalettes, resolveRole } from "../../../src/palette";
import { FEATURE_TYPES } from "../../../src/contracts/plan";
import { COMPOSED_PRESETS, FEATURE_INFO, NEUTRAL_SLOT, SET_PIECES } from "../../../src/gen";

let n = 0;
function asset(name: string, size: [number, number, number], more: Partial<CatalogAsset> = {}): CatalogAsset {
  n++;
  return {
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    kind: "prop",
    pack: "Test",
    packId: "p",
    folder: "Nature",
    groupTag: "",
    tags: [],
    deprecated: false,
    interactable: false,
    size: { x: size[0], y: size[1], z: size[2] },
    footprintCells: { x: Math.ceil(size[0]), z: Math.ceil(size[2]) },
    boundsCenter: { x: 0, y: size[1] / 2, z: 0 },
    boundsMin: { x: -size[0] / 2, y: 0, z: -size[2] / 2 },
    originAt: "center",
    ...more,
  };
}

describe("size classes and footprints come from catalog geometry", () => {
  it("classifies by height and span", () => {
    expect(sizeClass(asset("a", [0.5, 0.1, 0.5]))).toBe("ground");
    expect(sizeClass(asset("a", [0.5, 0.6, 0.5]))).toBe("low");
    expect(sizeClass(asset("a", [0.5, 1.2, 0.5]))).toBe("medium");
    expect(sizeClass(asset("a", [0.8, 2.5, 0.8]))).toBe("tall");
    expect(sizeClass(asset("a", [3, 4.2, 3]))).toBe("huge");
    expect(footprintOf(asset("a", [1.6, 1, 0.4]))).toEqual([2, 1]);
    expect(footprintOf(asset("t", [1, 0.5, 2], { kind: "tile", originAt: "minCorner" }))).toEqual([1, 2]);
  });
});

describe("role rules", () => {
  it("puts a new tall stalagmite column in the cave column and tall-growth slots, with reasons", () => {
    const c = classifyAsset(asset("Stalagmite column 09", [0.7, 3.2, 0.7]));
    expect(c.map((x) => x.role)).toEqual(
      expect.arrayContaining(["feature.cave_column", "feature.cluster_tall"]),
    );
    expect(c[0]?.reasons.join(" ")).toContain("stalagmite");
  });
  it("never classifies deprecated, sci-fi or oversized assets", () => {
    expect(classifyAsset(asset("Pine 07", [0.8, 3, 0.8], { deprecated: true }))).toEqual([]);
    expect(classifyAsset(asset("Scifi crystal lamp", [0.5, 1, 0.5]))).toEqual([]);
    expect(classifyAsset(asset("Crystal huge cluster", [3, 2, 3])).map((c) => c.role)).not.toContain(
      "feature.crystal",
    );
  });
});

describe("trustworthy search", () => {
  const cat = [
    asset("Root 01", [0.93, 0.1, 0.65]),
    asset("Dungeon Wall/Floor With Roots 01", [1, 2.5, 1], { kind: "tile", originAt: "minCorner" }),
    asset("Swamp tree base 01", [2.1, 4, 3.1]),
    asset("Barrel", [0.6, 0.9, 0.6]),
  ];
  it("needs a hint word in the asset NAME, prefers props, and says what it returns", () => {
    const hits = searchCatalog(cat, { keywords: "huge gnarled tree root arching across the floor" });
    expect(hits[0]?.name).toBe("Root 01");
    expect(hits[0]).toMatchObject({ kind: "prop", sizeClass: "ground", footprint: [1, 1] });
    expect(hits[0]?.matched).toContain("root");
    expect(searchCatalog(cat, { keywords: "glowing obsidian throne" })).toEqual([]);
  });
  it("filters by role and size class", () => {
    expect(searchCatalog(cat, { size: "huge" }).map((h) => h.name)).toEqual(["Swamp tree base 01"]);
    expect(searchCatalog(cat, { role: "feature.root" }).map((h) => h.name)).toEqual(["Root 01"]);
  });
  it("custom features no longer fall through to an unrelated asset", () => {
    const av = createAvailability(cat);
    expect(av.search("ancient obsidian obelisk")).toEqual([]);
    // strict for custom features (2026-11-20): the head noun (the last word) must be in the name, so a tangle of
    // roots is asked for as "tangled root"; "root tangle" is no longer a root
    expect(av.search("tangled root")[0]?.name).toBe("Root 01");
    expect(av.search("fire hydrant")).toEqual([]);
  });
});

describe("assets from a game update join the palettes at runtime", () => {
  const update = [
    asset("Stalagmite column 09", [0.7, 3.2, 0.7]),
    asset("Pine 07", [0.8, 3.4, 0.8]),
    asset("Barrel", [0.6, 0.9, 0.6]),
  ];
  const plain = loadPalettes();
  const rich = loadPalettes({ catalog: update });

  it("adds low-weight variants only to roles a theme already has, in matching tone", () => {
    expect(rich.autoVariants).toBeGreaterThan(0);
    const cave = resolveRole(rich, "cave", "feature.cluster_tall").resolution?.variants ?? [];
    const auto = cave.filter((v) => (v.name ?? "").endsWith("(auto)"));
    expect(auto.map((v) => v.name)).toEqual(["Stalagmite column 09 (auto)"]); // the pine stays out of the cave
    expect(auto[0]?.weight).toBeLessThan(1);
    expect(auto[0]?.footprint).toEqual([1, 1]);
    const forest = resolveRole(rich, "forest", "feature.cluster_tall").resolution?.variants ?? [];
    expect(forest.some((v) => v.name === "Pine 07 (auto)")).toBe(true);
  });

  it("curated variants stay first and unchanged", () => {
    const before = resolveRole(plain, "cave", "feature.cluster_tall").resolution?.variants ?? [];
    const after = resolveRole(rich, "cave", "feature.cluster_tall").resolution?.variants ?? [];
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("buildPaletteCatalog (app and CLI) adds them and the catalog's availability from one argument", () => {
    const built = buildPaletteCatalog([], { assets: update } as unknown as AssetCatalog);
    expect(built.autoVariants).toBe(rich.autoVariants);
    expect(built.palettes).toEqual(rich.palettes);
    const curated = resolveRole(plain, "cave", "feature.cluster_tall").resolution?.variants[0]?.uuid ?? "";
    expect(built.availability.status(curated)).toBe("missing"); // not in this (tiny) catalog
    expect(buildPaletteCatalog([], update).palettes).toEqual(rich.palettes);
    expect(buildPaletteCatalog([], null)).toMatchObject({ autoVariants: 0, palettes: plain.palettes });
  });
});

describe("theme-neutral set pieces", () => {
  const cat = loadPalettes();
  const SLOTS = FEATURE_TYPES.slice(
    FEATURE_TYPES.indexOf("landmark"),
    FEATURE_TYPES.indexOf("bank_dressing"),
  ); // water's-edge pieces fall back to generic

  it("every slot has its own assets in every theme (no theme relies on another theme's look)", () => {
    for (const th of ["cave", "outdoor", "forest", "stone_dungeon", "wood_town"])
      for (const slot of SLOTS) {
        const r = resolveRole(cat, th, `feature.${slot}`).resolution;
        expect(r, `${th}/${slot}`).not.toBeNull();
        // forest inherits a few from outdoor; every other theme fills its slots itself
        expect([th, th === "forest" ? "outdoor" : th], `${th}/${slot} from ${r?.paletteId}`).toContain(
          r?.paletteId,
        );
      }
  });

  it("no composed preset names a cave-only natural piece: they are mapped to slots", () => {
    for (const preset of COMPOSED_PRESETS) {
      const def = SET_PIECES[preset];
      const parts = [
        ...def.groups.flatMap(([g]) => g.parts),
        ...(def.focal ? def.focal.build(200).parts : []),
      ];
      for (const part of parts) expect(NEUTRAL_SLOT[part.t], `${preset}: ${part.t}`).toBeUndefined();
      for (const part of parts) expect(FEATURE_INFO[part.t]).toBeDefined();
    }
  });
});
