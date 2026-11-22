/**
 * The quality meter's slab tier (src/review/qualitySlab.ts), one metric at a time on tiny hand-built piece sets with a
 * known answer, and the hard-rule helpers later packages call (test/fixtures/quality.ts).
 */
import { describe, expect, it } from "vitest";
import { mirrorShare, slabMeter, stampedGroups, type MeterPiece } from "../../../src/review";
import {
  coplanarShare,
  duplicateCount,
  restContact,
  stampedGroupCount,
  structureOnAxis,
} from "../../fixtures/quality";

/** A piece with its box at (x, y, z) .. + size; stored height y. */
function piece(
  asset: string,
  x: number,
  y: number,
  z: number,
  size: [number, number, number] = [1, 0.5, 1],
  more: Partial<MeterPiece> = {},
): MeterPiece {
  return {
    asset,
    y,
    rot: 0,
    tile: false,
    box: { min: { x, y, z }, max: { x: x + size[0], y: y + size[1], z: z + size[2] } },
    ...more,
  };
}
const tile = (x: number, z: number, more: Partial<MeterPiece> = {}): MeterPiece =>
  piece("floor", x, 0, z, [1, 0.5, 1], { tile: true, ...more });

describe("slab tier of the quality meter", () => {
  it("prop share and pieces per tile and column", () => {
    // a 2 × 1 floor, one long prop across both tiles
    const v = slabMeter([tile(0, 0), tile(1, 0), piece("bench", 0, 0.5, 0.25, [2, 0.5, 0.5])]);
    expect(v.pieces).toBe(3);
    expect(v.prop_share).toBeCloseTo(1 / 3);
    expect(v.pieces_per_tile).toBe(1.5); // 3 pieces over 2 columns
    expect(v.pieces_per_column).toBe(2); // each column is covered by its tile and the bench
  });

  it("overlap share: interpenetrating boxes only (touching faces do not count)", () => {
    const touching = slabMeter([tile(0, 0), tile(1, 0)]);
    expect(touching.overlap_share).toBe(0);
    const sunk = slabMeter([tile(0, 0), tile(1, 0), piece("post", 0.4, 0.25, 0.4, [0.2, 2, 0.2])]);
    expect(sunk.overlap_share).toBeCloseTo(2 / 3); // the post is buried in the first tile
  });

  it("off-axis: props by yaw off the quarter turns, tiles likewise", () => {
    const v = slabMeter([
      piece("a", 0, 0, 0, undefined, { rot: 90 }),
      piece("a", 2, 0, 0, undefined, { rot: 15 }),
      piece("a", 4, 0, 0, undefined, { rot: 45 }),
      piece("a", 6, 0, 0, undefined, { rot: 270 }),
      tile(0, 4, { rot: 90 }),
      tile(2, 4, { rot: 30 }),
    ]);
    expect(v.prop_off_axis).toBe(0.5);
    expect(v.structure_off_axis).toBe(0.5);
    expect(structureOnAxis([tile(0, 4, { rot: 30 }), tile(2, 4)])).toHaveLength(1);
  });

  it("height grid: props off the slab's own 0.25 grid, measured from the tiles' phase", () => {
    // tiles at a 0.1 offset: the slab's grid is 0.1, 0.35, 0.6 ...
    const v = slabMeter([
      tile(0, 0, { y: 0.1 }),
      tile(1, 0, { y: 0.35 }),
      piece("on-grid", 0, 0.6, 0, undefined, { y: 0.6 }),
      piece("off-grid", 1, 0.73, 0, undefined, { y: 0.73 }),
    ]);
    expect(v.prop_off_height_grid).toBe(0.5);
  });

  it("rest: a prop on a tile or on a prop rests, one hovering does not; props on props counted", () => {
    const floor = tile(0, 0);
    const table = piece("table", 0, 0.5, 0, [1, 0.8, 1]);
    const cup = piece("cup", 0.4, 1.3, 0.4, [0.2, 0.2, 0.2]);
    const ghost = piece("ghost", 0.4, 2.5, 0.4, [0.2, 0.2, 0.2]);
    const v = slabMeter([floor, table, cup, ghost]);
    expect(v.prop_rest_contact).toBeCloseTo(2 / 3); // table on the floor, cup on the table
    expect(v.prop_on_prop).toBeCloseTo(1 / 3); // the cup
    expect(restContact([cup, ghost], [floor, table, cup, ghost])).toEqual([ghost]);
    expect(restContact([cup], [floor, table, cup])).toEqual([]);
  });

  it("mirror share: a mirrored pair matches about its plane, a lone piece does not", () => {
    const pair = [piece("p", 0, 0, 0), piece("p", 4, 0, 0)];
    expect(mirrorShare(pair)).toBe(1);
    expect(mirrorShare([...pair, piece("q", 7, 0, 3)])).toBeCloseTo(2 / 3);
    expect(mirrorShare([piece("p", 0, 0, 0)])).toBeNull();
    // structure from tiles, dressing from loose props only (when any piece says)
    const v = slabMeter([
      tile(0, 0),
      tile(3, 0),
      piece("chair", 0, 0.5, 0, undefined, { loose: true }),
      piece("chair", 1, 0.5, 2, undefined, { loose: true }),
      piece("beam", 0, 2, 0, undefined, { loose: false }),
    ]);
    expect(v.symmetry_structure).toBe(1);
    expect(v.symmetry_dressing).toBe(0.5); // each chair is its own plane's piece; never a pair
  });

  it("variety: distinct assets, the top asset's share, and the largest kit only when every piece names one", () => {
    const v = slabMeter([
      tile(0, 0, { kit: "k1" }),
      tile(1, 0, { kit: "k1" }),
      piece("x", 0, 0.5, 0, undefined, { kit: "k2" }),
    ]);
    expect(v.distinct_assets).toBe(2);
    expect(v.top_asset_share).toBeCloseTo(2 / 3);
    expect(v.largest_kit_share).toBeCloseTo(2 / 3);
    expect(slabMeter([tile(0, 0, { kit: "k1" }), tile(1, 0)]).largest_kit_share).toBeNull();
  });

  it("coplanar flat tops: two overlapping flats within 0.02 flicker, a 0.05 step does not", () => {
    const flicker = [tile(0, 0), piece("decal", 0.2, 0.49, 0.2, [0.6, 0.02, 0.6])];
    expect(coplanarShare(flicker)).toBe(1);
    const stepped = [tile(0, 0), piece("decal", 0.2, 0.53, 0.2, [0.6, 0.02, 0.6])];
    expect(coplanarShare(stepped)).toBe(0);
  });

  it("stamped groups: four identical dressing pieces at one heading, broken by one turned", () => {
    const row = (rot4: number): MeterPiece[] =>
      [0, 1, 2, 3].map((k) => piece("crate", k, 0, 0, undefined, { rot: k === 3 ? rot4 : 0, loose: true }));
    expect(stampedGroups(row(0))).toBe(1);
    expect(stampedGroups(row(15))).toBe(0);
    expect(stampedGroupCount(row(0))).toBe(1);
    // too far apart to read as a group
    expect(stampedGroups([0, 2, 4, 6].map((x) => piece("crate", x * 2, 0, 0)))).toBe(0);
  });

  it("exact duplicates: one asset at one place and yaw", () => {
    expect(duplicateCount([tile(0, 0), tile(0, 0), tile(0, 0, { rot: 90 })])).toBe(1);
  });

  it("an empty build measures nothing", () => {
    const v = slabMeter([]);
    expect(v.pieces).toBe(0);
    expect(v.prop_share).toBeNull();
    expect(v.symmetry_structure).toBeNull();
  });
});
