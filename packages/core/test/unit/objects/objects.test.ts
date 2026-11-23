/**
 * Object recipes (src/objects): the proof builds clean; each recipe's output holds the hard rules (pieces that rest
 * rest, fastened pieces touch the object, no duplicates, no flickering tops, tiles square); budgets cut interior mass
 * and detail first and keep the silhouette; builds are deterministic, scale with their size and turn as a whole; every
 * instance is within the piece cap and stands on the ground.
 */
import { describe, expect, it } from "vitest";
import { ARRANGE_LIMITS } from "../../../src/arrange/budget";
import { placedBox, type Placed } from "../../../src/arrange/piece";
import { compileResolved, realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import {
  buildObject,
  createKit,
  isKept,
  objectTurn,
  packParts,
  placeObject,
  piecesOf,
  stall,
  STAND_IN_IDS,
  STAND_INS,
  type StandInDef,
  turnStep,
  vessel,
  type BuiltObject,
} from "../../../src/objects";
import { loadPalettes } from "../../../src/palette";
import type { MeterPiece } from "../../../src/review";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { slabCodec } from "../../../src/slab";
import {
  coplanarShare,
  duplicateCount,
  piecesOf as meterPiecesOf,
  restContact,
  structureOnAxis,
} from "../../fixtures/quality";
import { handLevel, handPlan } from "../compile/handResolved";
import { FLOOR_TOP, objectsProof, proofKit, withoutShipKit } from "./proof";

const cat = loadPalettes();
// the stand-ins' rules: a theme without the ship kit (the kit's hull is built and held to the same rules below)
const kit = proofKit(withoutShipKit(cat));
const shipKit = proofKit(cat);
const build = {
  boat: () => buildObject(vessel, { size: 6, seed: "t-boat" }, kit),
  barge: () => buildObject(vessel, { size: 14, seed: "t-barge" }, kit),
  brig: () => buildObject(vessel, { size: 30, seed: "t-brig" }, kit),
  stall: () => buildObject(stall, { size: 3, seed: "t-stall", budget: 100 }, kit),
  "kit barge": () => buildObject(vessel, { size: 14, seed: "t-barge" }, shipKit),
  "kit brig": () => buildObject(vessel, { size: 30, seed: "t-brig", sails: "set" }, shipKit),
};

/** The object alone on a plain floor, realized; `keep` picks the parts built. */
function realizeAlone(
  obj: BuiltObject,
  keep: (p: BuiltObject["parts"][number]) => boolean = () => true,
  turn = 0,
) {
  const only: BuiltObject = { ...obj, parts: obj.parts.filter(keep) };
  const placed = placeObject(only, { id: "obj", anchor: { at: [24, 24], base: FLOOR_TOP, turn } });
  const level = handLevel({
    id: "t",
    rows: Array.from({ length: 48 }, () => ".".repeat(48)),
    theme: "wood_town",
  });
  level.arrangements = placed.instances;
  const resolved = { ...handPlan([level]), planId: "objects-test", generator: 5 };
  const set = realize(resolved, cat);
  return {
    set,
    resolved,
    placed,
    mine: meterPiecesOf(set, (id) => id.startsWith("obj")),
    all: meterPiecesOf(set, () => true),
  };
}

const gap = (lo1: number, hi1: number, lo2: number, hi2: number): number => Math.max(0, lo2 - hi1, lo1 - hi2);
/** Two pieces' boxes within `reach` of each other on every axis. */
function touch(p: Placed, q: Placed, reach = 0.05): boolean {
  const a = placedBox(p);
  const b = placedBox(q);
  return (
    gap(a.min.x, a.max.x, b.min.x, b.max.x) <= reach &&
    gap(a.min.y, a.max.y, b.min.y, b.max.y) <= reach &&
    gap(a.min.z, a.max.z, b.min.z, b.max.z) <= reach
  );
}

/** Fastened pieces touching no other piece of the object. */
function loose(obj: BuiltObject): Placed[] {
  const all = piecesOf(obj);
  const fastened = obj.parts.filter((p) => p.hold === "fastened").flatMap((p) => p.pieces);
  return fastened.filter((q) => !all.some((r) => r !== q && touch(q, r)));
}

/** Line parts (ratlines, stays) anchored at fewer than two pieces touching the rest of the object. */
function unanchoredLines(obj: BuiltObject): string[] {
  const solid = obj.parts.filter((p) => p.hold !== "line").flatMap((p) => p.pieces);
  return obj.parts
    .filter((p) => p.hold === "line")
    .filter((p) => p.pieces.filter((q) => solid.some((r) => touch(q, r))).length < 2)
    .map((p) => p.name);
}

describe("object proof", () => {
  const { resolved, objects } = objectsProof(cat);

  it("builds in one slab with nothing wrong with any object", () => {
    const set = realize(resolved, cat);
    const ids = new Set(objects.flatMap((o) => o.placed.instances.map((i) => i.id)));
    const found = verifyBuild(resolved, set, cat).diagnostics.filter(
      (d) => d.severity !== "info" && ids.has(d.elementId ?? ""),
    );
    expect(found.map((d) => `${d.code} ${d.elementId ?? ""} ${d.message}`)).toEqual([]);
    const bundle = compileResolved(resolved, cat, slabCodec, { createdAt: "t" });
    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const o of objects) {
      const placed = set.levels
        .flatMap((l) => l.placements)
        .filter((p) => o.placed.instances.some((i) => i.id === p.source.elementId));
      expect(placed).toHaveLength(o.built.count);
    }
  });
});

describe.each(Object.entries(build))("%s: hard rules", (name, make) => {
  const obj = make();

  it("pieces that rest rest on something, fastened pieces touch the object, lines are anchored", () => {
    const { mine, all } = realizeAlone(obj, (p) => p.hold === "rest");
    // the meter's rest rule asked of each prop among the pieces round it (the whole build at once is slow for a brig)
    const near = (p: MeterPiece) =>
      all.filter(
        (q) =>
          q.box.max.x > p.box.min.x - 1 &&
          q.box.min.x < p.box.max.x + 1 &&
          q.box.max.z > p.box.min.z - 1 &&
          q.box.min.z < p.box.max.z + 1,
      );
    const floating = mine.filter((p) => !p.tile && restContact([p], near(p), 0).length > 0);
    expect(floating.length).toBeLessThanOrEqual(0.05 * mine.filter((p) => !p.tile).length);
    expect(loose(obj).map((q) => q.piece.variant.name)).toEqual([]);
    expect(unanchoredLines(obj)).toEqual([]);
  });

  it("no exact duplicates, no flickering tops, tiles on quarter turns", () => {
    const { mine } = realizeAlone(obj);
    expect(duplicateCount(mine)).toBe(0);
    // the meter's rule, true footprints for the planks on the hull's 15° facets
    expect(coplanarShare(mine)).toBe(0);
    expect(structureOnAxis(mine)).toEqual([]);
    expect(structureOnAxis(realizeAlone(obj, () => true, 90).mine)).toEqual([]);
  });

  it("fills the four core slots and stays within its budget", () => {
    for (const slot of ["mass", "supports", "face", "top"])
      expect(
        obj.parts.some((p) => p.slot === slot),
        slot,
      ).toBe(true);
    expect(obj.count).toBeLessThanOrEqual(obj.budget);
    expect(name).toBeTruthy();
  });
});

describe("budgets", () => {
  it("a 50-piece boat keeps its silhouette parts, within the rung's band (M12: ± 20 %)", () => {
    const o = buildObject(vessel, { size: 6, seed: "t", budget: 50 }, kit);
    expect(o.count).toBeLessThanOrEqual(60);
    const names = o.parts.map((p) => p.name);
    for (const n of ["hull", "cap rail", "stem", "sternpost", "oars"]) expect(names).toContain(n);
    for (const slot of ["mass", "supports", "face", "top"])
      expect(
        o.parts.some((p) => p.slot === slot),
        slot,
      ).toBe(true);
    expect(o.cut).toContain("decks");
  });

  it("a brig at 50 keeps every silhouette part (and says it is over), cuts the rest", () => {
    const o = buildObject(vessel, { size: 30, seed: "t-brig", budget: 50 }, kit);
    expect(o.over).toBe(true);
    expect(o.lod).toBe(0);
    const names = new Set(o.parts.map((p) => p.name));
    for (const n of [
      "hull",
      "cap rail",
      "stem",
      "sternpost",
      "mast 1",
      "mast 1 yards",
      "mast 2",
      "mast 2 yards",
      "bowsprit",
    ])
      expect(names.has(n), n).toBe(true);
    for (const p of o.parts) expect(isKept(p), p.name).toBe(true);
    expect(o.cut).toEqual(expect.arrayContaining(["decks", "deck kits", "hatch"]));
  });

  it("interior mass goes before detail, and detail before a coarser hull", () => {
    const full = build.barge();
    const decks = full.parts.find((p) => p.name === "decks")?.pieces.length ?? 0;
    const o = buildObject(vessel, { size: 14, seed: "t-barge", budget: full.count - decks }, kit);
    expect(o.lod).toBe(full.lod);
    expect(o.cut).toContain("decks");
    expect(o.parts.some((p) => p.kind === "detail")).toBe(true);
  });

  it("a stall at 25 is its core slots only", () => {
    const o = buildObject(stall, { size: 3, seed: "t", budget: 25 }, kit);
    expect(o.count).toBeLessThanOrEqual(25);
    expect(new Set(o.parts.map((p) => p.slot))).toEqual(new Set(["mass", "supports", "face", "top"]));
  });
});

describe("parameters", () => {
  it("is deterministic", () => {
    const a = JSON.stringify(buildObject(vessel, { size: 30, seed: "d" }, proofKit(cat)));
    const b = JSON.stringify(buildObject(vessel, { size: 30, seed: "d" }, proofKit(cat)));
    expect(a).toBe(b);
  });

  it("scales with its size: longer, wider, taller", () => {
    const sizes = [6, 14, 30].map((size) => buildObject(vessel, { size, seed: "s" }, kit));
    const ext = (o: BuiltObject, i: 0 | 1) => {
      const v = o.footprint.map((p) => p[i]);
      return Math.max(...v) - Math.min(...v);
    };
    const tall = (o: BuiltObject) => Math.max(...piecesOf(o).map((q) => placedBox(q).max.y));
    for (let i = 1; i < sizes.length; i++) {
      const [a, b] = [sizes[i - 1] as BuiltObject, sizes[i] as BuiltObject];
      expect(ext(b, 1)).toBeGreaterThan(ext(a, 1));
      expect(ext(b, 0)).toBeGreaterThan(ext(a, 0));
      expect(tall(b)).toBeGreaterThan(tall(a));
    }
    // the length along the front axis (+z) is the size asked
    expect(ext(sizes[2] as BuiltObject, 1)).toBeCloseTo(30, 0);
  });

  it("another seed varies it, a condition changes it", () => {
    const a = buildObject(vessel, { size: 14, seed: "a" }, kit);
    const b = buildObject(vessel, { size: 14, seed: "b" }, kit);
    expect(JSON.stringify(piecesOf(a))).not.toBe(JSON.stringify(piecesOf(b)));
    const wreck = buildObject(vessel, { size: 30, seed: "a", condition: "derelict" }, kit);
    expect(wreck.parts.some((p) => p.slot === "sails")).toBe(false);
  });
});

describe("placing", () => {
  it("turns as a whole: same pieces, the footprint turned with it", () => {
    const o = build.brig();
    const a = placeObject(o, { id: "x", anchor: { at: [30, 30], base: 0, turn: 0 } });
    const b = placeObject(o, { id: "x", anchor: { at: [30, 30], base: 0, turn: 90 } });
    expect(b.turn).toBe(90);
    expect(b.instances.map((i) => i.pieces)).toEqual(a.instances.map((i) => i.pieces));
    expect(b.footprint.length).toBe(a.footprint.length);
    const span = (cells: readonly (readonly [number, number])[], i: 0 | 1) =>
      Math.max(...cells.map((c) => c[i])) - Math.min(...cells.map((c) => c[i]));
    expect(span(b.footprint, 0)).toBe(span(a.footprint, 1));
    expect(b.surfaces.map((s) => s.cells.length)).toEqual(a.surfaces.map((s) => s.cells.length));
  });

  it("an object with tiles turns in quarter turns, one of props in 15° steps", () => {
    const o = build.brig();
    expect(turnStep(o)).toBe(90);
    expect(objectTurn(o, 30)).toBe(0);
    expect(objectTurn(o, 60)).toBe(90);
    const props: BuiltObject = {
      ...o,
      parts: o.parts.filter((p) => p.pieces.every((q) => q.piece.measures.kind === "prop")),
    };
    expect(turnStep(props)).toBe(15);
    expect(objectTurn(props, 30)).toBe(30);
  });

  it("every instance is within the piece cap and its lowest piece stands on the ground or the object", () => {
    const o = build.brig();
    const all = piecesOf(o);
    const groups = packParts(o, ARRANGE_LIMITS.piecesPerInstance);
    expect(groups.length).toBeGreaterThan(1);
    const ground = Math.min(...all.map((q) => q.y));
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(ARRANGE_LIMITS.piecesPerInstance);
      const low = g.reduce((m, q) => (q.y < m.y ? q : m));
      const held = all.some((r) => {
        const b = placedBox(r);
        return (
          r !== low &&
          low.x >= b.min.x &&
          low.x <= b.max.x &&
          low.z >= b.min.z &&
          low.z <= b.max.z &&
          Math.abs(b.max.y - low.y) < 0.06
        );
      });
      expect(held || Math.abs(low.y - ground) < 1e-6).toBe(true);
    }
    expect(groups.flat()).toHaveLength(o.count);
  });

  it("declares its decks as surfaces at their heights, raised decks above the main one", () => {
    const o = build.brig();
    const p = placeObject(o, { id: "x", anchor: { at: [30, 30], base: 0.5 } });
    const by = Object.fromEntries(p.surfaces.map((s) => [s.id, s]));
    expect(by.deck?.cells.length).toBeGreaterThan(100);
    expect(by.forecastle?.y).toBeGreaterThan(by.deck?.y ?? Infinity);
    expect(by.quarterdeck?.y).toBeGreaterThan(by.deck?.y ?? Infinity);
    expect(p.spaces.map((s) => s.id)).toEqual(["hold"]);
    expect(p.keepClear.length).toBeGreaterThan(0);
  });
});

describe("stand-in lexicon", () => {
  it.each(["wood_town", "generic"])("finds every stand-in in %s (the ship kit aside)", (theme) => {
    const k = createKit(createPlanRoles(cat, 5), theme);
    // the ship kit's stand-ins wait for the owner's import (scripts/palette-ship-assets.json); see vesselKit.test.ts
    const missing = STAND_IN_IDS.filter((id) => !(STAND_INS[id] as StandInDef).kit && k.standIn(id) === null);
    expect(missing).toEqual([]);
  });

  it("two objects of one map share their stand-ins", () => {
    const k = proofKit(cat);
    const used = (o: BuiltObject) => new Set(piecesOf(o).map((q) => q.piece.variant.uuid));
    const a = used(buildObject(vessel, { size: 14, seed: "x" }, k));
    const b = used(buildObject(stall, { size: 3, seed: "x", budget: 100 }, k));
    expect([...b].some((u) => a.has(u))).toBe(true);
  });
});
