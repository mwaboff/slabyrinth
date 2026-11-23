/**
 * The palette extension (palette/extension.ts): catalog pieces the palettes do not name, added to loose dressing roles
 * for generator 5 only (switch `catalogExtension`), drawn by realize in their own stage, never seen by the resolver;
 * generators 1 to 4 build with a catalog exactly as before (their run-time keyword variants, palette/auto.ts).
 */
import { describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import type { PaletteCatalog } from "../../../src/contracts/compiler";
import type { MapPlan } from "../../../src/contracts/plan";
import { createAvailability } from "../../../src/catalog";
import {
  EMPTY_EXTENSION,
  buildPaletteCatalog,
  bundledPalettes,
  loadPalettes,
  paletteExtension,
  rolePolicy,
} from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";
import { catalogOfPalettes, inventedSiblings } from "../../fixtures/catalogFromPalettes";

const bundled = bundledPalettes().palettes;
const curated = catalogOfPalettes(bundled);
// an update: a new sibling of every palette piece, structural and dressing alike, and a piece only the released
// generators' keyword rules take (palette/auto.ts)
const update = [
  ...curated,
  ...inventedSiblings(bundled, () => true),
  {
    ...(curated.find((a) => a.kind === "prop") as (typeof curated)[number]),
    uuid: "ad000000-0000-4000-8000-ffffffffffff",
    name: "Pine Sapling 07",
    size: { x: 0.8, y: 3.4, z: 0.8 },
  },
];
const built = buildPaletteCatalog([], update);
/** What buildPaletteCatalog gave before the extension: the released generators' palettes with a catalog. */
const released = loadPalettes({ availability: createAvailability(update), catalog: update });
/** The same palettes and availability with no extension. */
const withoutExtension: PaletteCatalog = { ...built, extension: EMPTY_EXTENSION } as PaletteCatalog;

const at = (name: Parameters<typeof loadPlan>[0], generator: MapPlan["generator"]): MapPlan =>
  loadPlan(name, { generator });
/** The build of `plan`, less where its assets came from (a catalog says "install", none "builtin"). */
const bundleOf = (plan: MapPlan, palettes: PaletteCatalog): string => {
  const b = compileResolved(resolvePlan(plan, palettes), palettes, slabCodec, { createdAt: "t", plan });
  return JSON.stringify({ ...b, assetSource: null });
};

describe("the extension holds loose dressing only", () => {
  it("adds sure siblings of dressing pieces, never a structural role, a light or a support", () => {
    expect(built.extension.pieces.length).toBeGreaterThan(20);
    for (const p of built.extension.pieces) expect(rolePolicy(p.role).where, p.role).toBe("user");
    const roles = new Set(built.extension.pieces.map((p) => p.role.split(".")[0]));
    for (const family of ["floor", "wall", "wall_post", "roof", "opening", "link", "stairs", "ship"])
      expect(roles.has(family), family).toBe(false);
  });

  it("is the same for the same catalog, in any order, and its hash says so", () => {
    const again = buildPaletteCatalog([], [...update].reverse()).extension;
    expect(again).toEqual(built.extension);
    expect(paletteExtension(update, bundled).hash).toBe(built.extension.hash);
    expect(buildPaletteCatalog([], null).extension).toBe(EMPTY_EXTENSION);
  });

  it("leaves out an excluded piece, and the hash changes with it", () => {
    const first = built.extension.pieces[0];
    expect(first).toBeDefined();
    const ex = buildPaletteCatalog([], update, { exclude: [first?.uuid.toUpperCase() ?? ""] }).extension;
    expect(ex.pieces.some((p) => p.uuid === first?.uuid)).toBe(false);
    expect(ex.pieces.length).toBeLessThan(built.extension.pieces.length);
    expect(ex.hash).not.toBe(built.extension.hash);
  });
});

describe("released generators build with a catalog as they did before", () => {
  it("keeps their run-time keyword variants and never sees the extension", () => {
    expect(released.autoVariants).toBeGreaterThan(0);
    expect(built.palettes).toEqual(released.palettes);
    for (const [name, generator] of [
      ["cave", 1],
      ["smugglers-grotto-v3", 4],
    ] as const)
      expect(bundleOf(at(name, generator), built), name).toBe(bundleOf(at(name, generator), released));
  }, 30_000); // two compiles of a cave and a grotto twice
});

describe("generator 5 builds with the extension in realize only", () => {
  const plan = at("outdoor-scatter", 5);
  const noCatalog = buildPaletteCatalog([], null);

  it("resolves a plan the same with and without a catalog (layout never depends on the library)", () => {
    expect(resolvePlan(plan, built).hash).toBe(resolvePlan(plan, noCatalog).hash);
  });

  it("does not use the released generators' keyword variants", () => {
    expect(bundleOf(plan, withoutExtension)).toBe(bundleOf(plan, noCatalog));
  }, 30_000); // two compiles of a dressed outdoor map

  it("moves only placements that drew an extension piece, and names them in one note", () => {
    const resolved = resolvePlan(plan, built);
    const before = realize(resolved, withoutExtension, {});
    const after = realize(resolved, built, {});
    const ext = new Set(built.extension.pieces.map((p) => p.uuid));
    const flat = (s: typeof before) => s.levels.flatMap((l) => l.placements);
    const a = flat(before);
    const b = flat(after);
    expect(b.length).toBe(a.length);
    let moved = 0;
    for (const [i, p] of b.entries()) {
      if (JSON.stringify(p) === JSON.stringify(a[i])) continue;
      moved++;
      expect(ext.has(p.asset.toLowerCase()), `${p.asset} at ${String(i)}`).toBe(true);
    }
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(b.filter((p) => p.role === "feature").length / 2);
    const note = after.diagnostics.filter((d) => d.code === "extension_used");
    expect(note).toHaveLength(1);
    expect(note[0]?.severity).toBe("info");
    expect(note[0]?.count).toBe(b.filter((p) => ext.has(p.asset.toLowerCase())).length);
    expect(before.diagnostics.some((d) => d.code === "extension_used")).toBe(false);
  }, 30_000); // two realizes of a dressed outdoor map
});
