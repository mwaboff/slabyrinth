/**
 * Generator 5 (`arrangements`): an arrangement instance on a resolved level is built as one element (realize
 * arrangements.ts), judged by verify as one element, and reaches the slab at the encoder's resolution; generator 4
 * ignores it. The instance is hand-made from real generic pieces (trait pools), with no resolve stage behind it.
 */
import { describe, expect, it } from "vitest";
import {
  fan,
  fromPool,
  rest,
  roundCount,
  single,
  sink,
  toInstance,
  transform,
  twin,
  type ArrangePiece,
  type Arrangement,
} from "../../../src/arrange";
import { compileResolved, placementBox, realize, storedPosition } from "../../../src/compile";
import { createVerifyCtx } from "../../../src/compile/verify/context";
import { checkArrangementCap } from "../../../src/compile/verify/arrangements";
import { verifyBuild } from "../../../src/compile/verify/verify";
import type { PaletteVariant, Placement } from "../../../src/contracts/compiler";
import type { ResolvedArrangement, ResolvedPlan } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { pickFromPool, type TraitQuery } from "../../../src/palette/traitPools";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { generatorProfile } from "../../../src/plan/generator";
import { ARRANGE_LIMITS } from "../../../src/arrange";
import { decode, slabCodec } from "../../../src/slab";
import { must } from "../arrange/synthetic";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const firstLevel = <T>(levels: readonly T[]): T => must(levels[0], "level");
const roles = createPlanRoles(cat, 5);

function piece(query: TraitQuery, key: string): ArrangePiece {
  const pool = roles.pool("generic", query);
  const p = pickFromPool(pool, "arrangements-test", key);
  if (!p) throw new Error(`no generic piece for ${JSON.stringify(query)}`);
  return fromPool(pool, p);
}

const post = piece({ trait: "post", kind: "prop", where: { height: [1, 3] } }, "post");
const block = piece({ trait: "block", kind: "prop", where: { height: [0.75, 1.2] } }, "block");
const clutter = piece({ trait: "clutter", kind: "prop" }, "clutter");
const tile = piece(
  { trait: "slab", kind: "tile", where: { length: [0.99, 1.01], width: [0.99, 1.01] } },
  "tile",
);

/** A column of a post fanned round, a block with a sunk stone and a cup on it, a floor tile turned 15°. */
function demo(): Arrangement {
  const column = fan(single(post), { count: roundCount(single(post)) });
  const stand = sink(single(block), { fraction: 0.3 });
  const onTop = rest(twin(single(clutter)), stand);
  const turned = transform(single(tile, 15), { dx: 0, dz: -2.5 });
  return [...column, ...transform(onTop, { dx: 2.5 }), ...turned];
}

/** A plain 10x10 generic room, generator 5 unless told, with the demo instance at the middle of it. */
function plan(generator: 4 | 5 = 5, withInstance = true): { r: ResolvedPlan; inst: ResolvedArrangement } {
  const rows = ["############", ...Array.from({ length: 10 }, () => "#..........#"), "############"];
  const level = handLevel({ id: "g", rows, theme: "generic" });
  const inst = toInstance(demo(), {
    id: "demo",
    recipe: "test",
    anchor: { at: [6, 6], base: 0.5, turn: 30 },
  });
  if (withInstance) level.arrangements = [inst];
  return { r: { ...handPlan([level]), generator }, inst };
}

const ofInstance = (ps: readonly Placement[]): Placement[] => ps.filter((p) => p.source.elementId === "demo");

describe("arrangement instances (generator 5)", () => {
  it("realize places every piece once, quantised to 0.01 tile and 15° turns, centred where the instance puts it", () => {
    const { r, inst } = plan();
    const set = realize(r, cat);
    const placed = ofInstance(firstLevel(set.levels).placements);
    expect(placed).toHaveLength(inst.pieces.length);
    for (const p of placed) {
      for (const v of [p.x, p.y, p.z]) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
      expect(p.rot % 15).toBe(0);
      expect(p.role).toBe("feature");
    }
    // the fanned column stands at the anchor: plan (6, 6) is world (6, 12 - 6)
    const column = placed.filter((p) => p.asset === post.variant.uuid);
    const n = roundCount(single(post));
    expect(column.map((p) => p.rot)).toEqual(Array.from({ length: n }, (_, i) => 30 + 15 * i));
    for (const p of column) {
      const b = must(set.placed.get(p)).box;
      expect((b.min.x + b.max.x) / 2).toBeCloseTo(6, 2);
      expect((b.min.z + b.max.z) / 2).toBeCloseTo(6, 2);
    }
    // the tile turned 15° (45° with the instance) has its box centred on its spot, by the min-corner rule
    const t = must(placed.find((p) => p.asset === tile.variant.uuid));
    expect(t.rot).toBe(45);
    const tb = must(set.placed.get(t)).box;
    const dz = { x: -2.5 * Math.sin(Math.PI / 6), z: -2.5 * Math.cos(Math.PI / 6) };
    expect((tb.min.x + tb.max.x) / 2).toBeCloseTo(6 + dz.x, 2);
    expect((tb.min.z + tb.max.z) / 2).toBeCloseTo(6 + dz.z, 2);
  });

  it("realize and verify agree: verify of an untouched build finds nothing wrong with the instance", () => {
    const { r } = plan();
    const set = realize(r, cat);
    const result = verifyBuild(r, set, cat);
    const mine = result.diagnostics.filter(
      (d) =>
        d.elementId === "demo" || d.code === "verify_props_overlap" || d.code === "verify_arrangement_cap",
    );
    expect(mine.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // the instance's own pieces overlap (the fanned column), and nothing was moved
    expect(result.repairs).toBe(0);
  });

  it("the slab keeps sub-tile positions, off-grid heights and 15° turns", () => {
    const { r } = plan();
    const set = realize(r, cat);
    const placed = ofInstance(firstLevel(set.levels).placements);
    const bundle = compileResolved(r, cat, slabCodec, { createdAt: "t" });
    expect(bundle.chunks).toHaveLength(1);
    const assets = decode(must(bundle.chunks[0]).slab).assets;
    const uuids = new Set(placed.map((p) => p.asset));
    // the build is moved by whole tiles across and quarter tiles up (chunk.ts), so these survive exactly
    const key = (sx: number, sy: number, sz: number, rot: number): string =>
      `${((sx % 100) + 100) % 100}|${((sy % 25) + 25) % 25}|${((sz % 100) + 100) % 100}|${rot}`;
    // (an asset the room is also built from, a floor tile, is left out of the comparison)
    const shared = new Set(
      firstLevel(set.levels)
        .placements.filter((p) => p.source.elementId !== "demo")
        .map((p) => p.asset),
    );
    const want = placed
      .filter((p) => !shared.has(p.asset))
      .map((p) => key(Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.z * 100), p.rot / 15))
      .sort();
    const got = assets
      .filter((a) => uuids.has(a.uuid) && !shared.has(a.uuid))
      .map((a) => key(a.sx, a.sy, a.sz, a.rot))
      .sort();
    expect(want.length).toBeGreaterThan(5);
    expect(got).toEqual(want);
    expect(got.some((k) => k.split("|")[0] !== "0")).toBe(true);
    expect(got.some((k) => k.split("|")[1] !== "0")).toBe(true);
    expect(got.some((k) => Number(k.split("|")[3]) % 6 !== 0)).toBe(true);
  });

  it("a generator-4 plan ignores the instance: its build is the build without it", () => {
    const withIt = realize(plan(4, true).r, cat);
    const without = realize(plan(4, false).r, cat);
    expect(ofInstance(firstLevel(withIt.levels).placements)).toEqual([]);
    expect(JSON.stringify(withIt.levels)).toEqual(JSON.stringify(without.levels));
    expect(verifyBuild(plan(4).r, withIt, cat).diagnostics.map((d) => d.code)).not.toContain(
      "verify_arrangement_cap",
    );
  });

  it("a piece the palettes cannot supply is dropped with a role_missing warning naming the instance", () => {
    const { r, inst } = plan();
    const broken = {
      ...inst,
      pieces: [{ ...must(inst.pieces[0]), asset: "00000000-0000-0000-0000-000000000000" }],
    };
    firstLevel(r.levels).arrangements = [broken];
    const set = realize(r, cat);
    expect(ofInstance(firstLevel(set.levels).placements)).toEqual([]);
    expect(set.diagnostics.some((d) => d.code === "role_missing" && d.elementId === "demo")).toBe(true);
  });

  it("verify reports a level whose arrangements pass the per-level cap", () => {
    const { r } = plan();
    const set = realize(r, cat);
    const lv = firstLevel(set.levels);
    const one = must(ofInstance(lv.placements)[0]);
    for (let i = 0; i <= ARRANGE_LIMITS.piecesPerLevel; i++) lv.placements.push({ ...one });
    const ctx = createVerifyCtx(r, set, cat, {});
    checkArrangementCap(ctx);
    expect(ctx.report.diagnostics.map((d) => d.code)).toEqual(["verify_arrangement_cap"]);
  });

  it("a resolve stage attaches instances only at generator 5, within the per-level cap", () => {
    const inst = toInstance(demo(), { id: "a", recipe: "test", anchor: { at: [1, 1], base: 0 } });
    const g4 = new ArrangementRecords();
    expect(g4.attach(generatorProfile(4), inst)).toBeNull();
    expect(g4.all).toEqual([]);
    const g5 = new ArrangementRecords();
    expect(g5.attach(generatorProfile(5), inst)).toBe(inst);
    const big = {
      ...inst,
      id: "b",
      pieces: Array.from({ length: ARRANGE_LIMITS.piecesPerLevel }, () => must(inst.pieces[0])),
    };
    const kept = must(g5.attach(generatorProfile(5), big));
    expect(kept.pieces).toHaveLength(ARRANGE_LIMITS.piecesPerLevel - inst.pieces.length);
    expect(g5.pieceCount).toBe(ARRANGE_LIMITS.piecesPerLevel);
    expect(g5.attach(generatorProfile(5), { ...inst, id: "c" })).toBeNull();
  });

  it("an instance's cells are the plan cells its turned pieces cover", () => {
    const inst = toInstance(single(tile), { id: "t", recipe: "test", anchor: { at: [4, 5], base: 0 } });
    expect(inst.cells).toEqual([
      [3, 4],
      [4, 4],
      [3, 5],
      [4, 5],
    ]);
    expect(inst.pieces[0]).toMatchObject({ palette: "generic", asset: tile.variant.wanted, yaw: 0 });
  });
});

describe("placement boxes of turned tiles (compile/geometry.ts)", () => {
  const geom: PaletteVariant["geom"] = {
    size: { x: 2, y: 0.5, z: 1 },
    originAt: "minCorner",
    boundsCenter: { x: 1, y: 0.25, z: 0.5 },
  };

  it("a quarter-turned tile keeps its min corner and swaps its footprint (as before)", () => {
    expect(placementBox(geom, 3, 0, 4, 0)).toEqual({
      min: { x: 3, y: 0, z: 4 },
      max: { x: 5, y: 0.5, z: 5 },
    });
    expect(placementBox(geom, 3, 0, 4, 90)).toEqual({
      min: { x: 3, y: 0, z: 4 },
      max: { x: 4, y: 0.5, z: 6 },
    });
    expect(placementBox(geom, 3, 0, 4, 270)).toEqual({
      min: { x: 3, y: 0, z: 4 },
      max: { x: 4, y: 0.5, z: 6 },
    });
  });

  it("a tile turned off the quarter turns is boxed by its turned outline from the stored corner", () => {
    const b = placementBox(geom, 3, 0, 4, 45);
    const side = 3 * Math.SQRT1_2;
    expect(b.max.x - b.min.x).toBeCloseTo(side, 11);
    expect(b.max.z - b.min.z).toBeCloseTo(side, 11);
    expect(b.min).toEqual({ x: 3, y: 0, z: 4 });
  });

  it("storedPosition is placementBox's inverse for tiles and props, at every 15° step", () => {
    const prop: PaletteVariant["geom"] = {
      ...geom,
      originAt: "center",
      boundsCenter: { x: 0.2, y: 0.25, z: -0.1 },
    };
    for (const g of [geom, prop])
      for (let deg = 0; deg < 360; deg += 15) {
        const s = storedPosition(g, 7, 1.5, 8, deg);
        const b = placementBox(g, s.x, s.y, s.z, deg);
        expect((b.min.x + b.max.x) / 2).toBeCloseTo(7, 9);
        expect((b.min.z + b.max.z) / 2).toBeCloseTo(8, 9);
        expect(b.min.y).toBeCloseTo(1.5, 9);
      }
  });
});
