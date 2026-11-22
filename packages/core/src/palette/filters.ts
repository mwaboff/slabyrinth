/**
 * Every variant filter the build asks a role with (palette/resolve.ts VariantFilter), each with a memo key made from
 * its parameters. The role resolver memoizes answers by theme, role and filter key, so two filters with one key and
 * different tests would share whichever answer came first: a filter is made here, where its key follows from what it
 * tests, never as an object literal where it is used (a lint guard keeps it so).
 */
import type { ResolvedVariant, VariantFilter } from "./resolve";
import { fitsShape, shapeKey, type TraitShape } from "./traits";

/** A piece's length along a wall run in cells (its length axis, else its longer side), at least 1. */
export const lengthOf = (v: ResolvedVariant): number =>
  v.geom.lengthAxis === "square" || v.geom.lengthAxis === undefined
    ? Math.max(1, Math.round(Math.max(v.geom.size.x, v.geom.size.z)))
    : Math.max(1, Math.round(v.geom.lengthAxis === "x" ? v.geom.size.x : v.geom.size.z));

/** Pieces exactly `n` cells long along the run. */
export const lenFilter = (n: number): VariantFilter => ({ key: `len${n}`, test: (v) => lengthOf(v) === n });

/** Pieces whose footprint is exactly w by h cells. */
export const footprint = (w: number, h: number): VariantFilter => ({
  key: `fp${w}x${h}`,
  test: (v) => v.footprint[0] === w && v.footprint[1] === h,
});

/** Pieces whose footprint is at most w by h cells. */
export const footprintAtMost = (w: number, h: number): VariantFilter => ({
  key: `fp<=${w}x${h}`,
  test: (v) => v.footprint[0] <= w && v.footprint[1] <= h,
});

/** One-cell pieces. */
export const ONE_CELL: VariantFilter = footprint(1, 1);

/** One-cell pieces of the default family (untagged variants): a stacked course, not a patch family's tile. */
export const ONE_CELL_PLAIN: VariantFilter = {
  key: "fp1x1plain",
  test: (v) => ONE_CELL.test(v) && (v.variant ?? "") === "",
};

/** A 1x1 tile standing on its cell (a corner-origin piece: the stall platform and counter blocks). */
export const ONE_CELL_TILE: VariantFilter = {
  key: "tile1x1",
  test: (v) => ONE_CELL.test(v) && v.geom.originAt === "minCorner",
};

/** Whole-cell blocks: one-cell tiles about a tile wide both ways (the faces of a drop). */
export const WHOLE_CELL_BLOCK: VariantFilter = {
  key: "block1x1",
  test: (v) => ONE_CELL_TILE.test(v) && v.geom.size.x > 0.8 && v.geom.size.z > 0.8,
};

/** Pieces that are not corner-origin tiles (props placed by their centre). */
export const NOT_TILE: VariantFilter = { key: "notTile", test: (v) => v.geom.originAt !== "minCorner" };

/** The variants of one name (a floor family, a stall kind's piece, a canopy form, goods of a family). */
export const variantNamed = (name: string): VariantFilter => ({
  key: `variant:${name}`,
  test: (v) => v.variant === name,
});

/** Intact pieces (not the "broken" variant) and broken ones. */
export const INTACT: VariantFilter = { key: "intact", test: (v) => v.variant !== "broken" };
export const BROKEN: VariantFilter = { key: "broken", test: (v) => v.variant === "broken" };

// ── growth on a building (compile/realize/structures/dressing.ts) ──

const widest = (v: ResolvedVariant): number => Math.max(v.geom.size.x, v.geom.size.z);
const slim = (v: ResolvedVariant): boolean => widest(v) <= 1.1;

/** A vine strand: no wider than a wall face, no taller than a storey. */
export const VINE_STRAND: VariantFilter = { key: "strand", test: (v) => slim(v) && v.geom.size.y <= 2.4 };
/** A broad batch of climbing growth, a face and a half to two wide, for the foot of a heavy mass. */
export const VINE_BATCH: VariantFilter = {
  key: "vinebatch",
  test: (v) => v.geom.size.x >= 1.5 && v.geom.size.x <= 2.1 && v.geom.size.y <= 2.4,
};
/** Roots on a wall face: no wider than the face. */
export const WALL_ROOT: VariantFilter = { key: "wallroot", test: slim };
/** A small plant on a cut wall top. */
export const SMALL_PLANT: VariantFilter = {
  key: "smallplant",
  test: (v) => widest(v) <= 1.8 && v.geom.size.y <= 1.3,
};
/** A small tree in a roofless room. */
export const SMALL_TREE: VariantFilter = {
  key: "smalltree",
  test: (v) => widest(v) <= 3.2 && v.geom.size.y <= 4.2,
};

// ── shape traits (palette/traits.ts) ──

/** Pieces of a shape: a trait, optionally narrowed by measures and kind (also the test of the theme-wide pool). */
export const traitFilter = (shape: TraitShape): VariantFilter => ({
  key: shapeKey(shape),
  test: (v) => fitsShape(v.geom, shape),
});

/** Both filters at once. */
export const both = (a: VariantFilter, b: VariantFilter): VariantFilter => ({
  key: `${a.key}+${b.key}`,
  test: (v) => a.test(v) && b.test(v),
});
