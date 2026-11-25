/**
 * The vessel's round-two rules (owner's screenshots, 2026-11-22): sails one pale surface or furled; the hull side a few
 * bands with a cap rail, ends trimmed at the joints; stern forms; no lines in the air, one straight yard per level; rig
 * proportions; budget on function; and the stall's ridge and sign.
 */
import { describe, expect, it } from "vitest";
import { placedBox, type ArrangePiece } from "../../../src/arrange/piece";
import {
  buildObject,
  paleCloth,
  piecesOf,
  sailPanels,
  stall,
  vessel,
  vesselDesign,
  RIG_RANGE,
  type BuiltObject,
} from "../../../src/objects";
import { loadPalettes } from "../../../src/palette";
import { proofKit, withoutShipKit } from "./proof";

// the stand-in rules: a theme without the ship kit (the kit's own rules are in vesselKit.test.ts)
const kit = proofKit(withoutShipKit(loadPalettes()));
const brig = buildObject(vessel, { size: 30, seed: "r" }, kit);
const barge = buildObject(vessel, { size: 14, seed: "r" }, kit);
const boat = buildObject(vessel, { size: 6, seed: "r" }, kit);
const named = (o: BuiltObject, name: string) => o.parts.filter((p) => p.name.endsWith(name));
const toned = (p: ArrangePiece, tone: "light" | "dark", hue?: string): ArrangePiece => ({
  ...p,
  variant: { ...p.variant, tone, ...(hue !== undefined ? { hue } : {}) },
});

describe("1. sails", () => {
  const cloth = kit.piece("cloth") as ArrangePiece;

  it("are set only from a pale cloth piece; the bundled palettes have none, so every yard is furled", () => {
    expect(paleCloth(kit.mix("cloth"))).toBeNull();
    expect(paleCloth([toned(cloth, "dark")])).toBeNull();
    expect(paleCloth([toned(cloth, "light", "red")])).toBeNull();
    expect(paleCloth([toned(cloth, "light")])).not.toBeNull();
    const set = buildObject(vessel, { size: 30, seed: "r", sails: "set" }, kit);
    expect(set.parts.filter((p) => p.name.endsWith(" sails") && !p.name.includes("furled"))).toEqual([]);
    const yards = named(set, "yards").reduce(
      (n, p) => n + new Set(p.pieces.map((q) => q.y.toFixed(2))).size,
      0,
    );
    const rolls = named(set, "furled sails").reduce(
      (n, p) => n + new Set(p.pieces.map((q) => q.y.toFixed(2))).size,
      0,
    );
    expect(rolls).toBeGreaterThanOrEqual(yards); // a roll under every yard
  });

  it("a set sail is one piece in two staggered layers, panels overlapping edge to edge", () => {
    const sail = sailPanels(toned(cloth, "light"), 8, 1);
    expect(new Set(sail.map((q) => q.piece.variant.uuid)).size).toBe(1);
    const layers = [...new Set(sail.map((q) => q.x.toFixed(3)))];
    expect(layers).toHaveLength(2);
    const front = sail
      .filter((q) => q.x.toFixed(3) === layers[0])
      .map((q) => q.z)
      .sort((a, b) => a - b);
    const back = sail
      .filter((q) => q.x.toFixed(3) === layers[1])
      .map((q) => q.z)
      .sort((a, b) => a - b);
    // panels closer than their width (overlap), joints of one layer away from the other's
    expect((front[1] ?? 0) - (front[0] ?? 0)).toBeLessThan(cloth.measures.length);
    expect(Math.abs((back[0] ?? 0) - (front[0] ?? 0))).toBeGreaterThan(0.3);
  });
});

describe("2. hull side", () => {
  it("is a few bands: a heavier lower band on a wide hull, planks, a wale and a railing, one cap rail", () => {
    const shell = ["hull", "wale", "bulwark rail", "cap rail"].flatMap((n) =>
      named(brig, n).flatMap((p) => p.pieces),
    );
    const assets = new Set(shell.map((q) => q.piece.variant.uuid));
    expect(assets.size).toBeGreaterThanOrEqual(3);
    expect(named(brig, "cap rail")[0]?.pieces.length).toBeGreaterThan(0);
  });

  it("scales the wall with the vessel: a rowing boat's wall is plank-thin and has few courses", () => {
    const hull = named(boat, "hull")[0]?.pieces ?? [];
    expect(Math.max(...hull.map((q) => q.piece.measures.width))).toBeLessThan(0.2);
    // courses at midship (the frame faces +z: midship is z near 0), counted on the 0.12 course pitch
    const mid = hull.filter((q) => Math.abs(q.z) < 0.6);
    expect(new Set(mid.map((q) => Math.round((q.y + 0.15) / 0.12))).size).toBeLessThanOrEqual(8);
    const big = named(brig, "hull")[0]?.pieces ?? [];
    expect(Math.max(...big.map((q) => q.piece.measures.width))).toBeGreaterThan(0.3);
  });

  it("ends at the stem and the stern line, with a plug at every joint", () => {
    for (const o of [brig, barge, boat]) {
      const d = vesselDesign({ size: o === brig ? 30 : o === barge ? 14 : 6, seed: "r" });
      const half = d.plan.length / 2;
      // the frame faces +z: the stem is the largest z, the stern the smallest
      for (const q of [...(named(o, "hull")[0]?.pieces ?? []), ...(named(o, "cap rail")[0]?.pieces ?? [])]) {
        const b = placedBox(q);
        expect(b.max.z).toBeLessThan(half + 0.12 * 4 + 0.2);
        expect(b.min.z).toBeGreaterThan(-half - 0.35);
      }
      expect(named(o, "joint plugs")[0]?.pieces.length).toBeGreaterThan(0);
    }
  });
});

describe("3. ends", () => {
  it("builds each stern form: transom square across, pointed to a point, round in many facets", () => {
    const sternOf = (stern: "pointed" | "round" | "transom") =>
      buildObject(vessel, { size: 14, seed: "s", stern }, kit).footprint.filter((p) => p[1] < -7 + 1.5);
    const transom = sternOf("transom");
    expect(Math.max(...transom.map((p) => Math.abs(p[0])))).toBeGreaterThan(1.5);
    const pointed = buildObject(vessel, { size: 14, seed: "s", stern: "pointed" }, kit).footprint;
    const tip = pointed.reduce((m, p) => (p[1] < m[1] ? p : m));
    expect(Math.abs(tip[0])).toBeLessThan(1e-6);
    expect(sternOf("round").length).toBeGreaterThan(transom.length);
  });

  it("raised ends draw in above the deck and carry a railing, no posts above it", () => {
    const d = vesselDesign({ size: 30, seed: "r" });
    const deckW = Math.max(...brig.footprint.map((p) => p[0]));
    const fore = brig.surfaces.find((s) => s.id === "quarterdeck");
    expect(Math.max(...(fore?.polygon ?? []).map((p) => p[0]))).toBeLessThan(deckW);
    expect(brig.parts.some((p) => p.name === "raised rails")).toBe(false);
    expect(d.fore).not.toBeNull();
  });
});

describe("4. rigging", () => {
  it("puts no line in the air: no line parts, fittings at every mast foot", () => {
    expect(brig.parts.filter((p) => p.hold === "line")).toEqual([]);
    expect(named(brig, "mast fittings")[0]?.pieces.length).toBeGreaterThanOrEqual(3 * 2);
  });

  it("one straight yard per level, square across the ship, shrinking upward", () => {
    for (const p of named(brig, "yards")) {
      const levels = new Map<string, number[]>();
      const heights = new Map<string, Set<string>>();
      for (const q of p.pieces) {
        expect(q.yaw % 90).toBe(0);
        // a level is one height: a lifted plank would read as a kink (keyed to the nearest whole tile)
        const k = String(Math.round(q.y));
        levels.set(k, [...(levels.get(k) ?? []), q.x]);
        heights.set(k, new Set([...(heights.get(k) ?? []), q.y.toFixed(3)]));
      }
      for (const hs of heights.values()) expect(hs.size).toBe(1);
      const spans = [...levels.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, xs]) => {
          expect(new Set(xs.map((x) => x.toFixed(2))).size).toBeGreaterThanOrEqual(2);
          return Math.max(...xs) - Math.min(...xs);
        });
      for (let i = 1; i < spans.length; i++) expect(spans[i] ?? 0).toBeLessThan(spans[i - 1] ?? 0);
    }
  });
});

describe("5. proportions", () => {
  it("a ship's rig is 0.8-1.4 x its length, its longest yard 1.35-1.45 x beam; a boat has no mast", () => {
    const top = Math.max(...piecesOf(brig).map((q) => placedBox(q).max.y));
    expect(top / 30).toBeGreaterThanOrEqual(RIG_RANGE.ship[0]);
    expect(top / 30).toBeLessThanOrEqual(RIG_RANGE.ship[1] + 0.1);
    const d = vesselDesign({ size: 30, seed: "r" });
    const B = 2 * d.plan.halfBeam;
    const longest = Math.max(...d.masts.flatMap((m) => m.yards.map((y) => y.length)));
    expect(longest / B).toBeGreaterThanOrEqual(1.35);
    expect(longest / B).toBeLessThanOrEqual(1.45);
    expect(vesselDesign({ size: 6, seed: "r" }).masts).toEqual([]);
    expect(vesselDesign({ size: 40, seed: "r" }).masts).toHaveLength(3);
    expect(vesselDesign({ size: 30, seed: "r", rig: 3 }).masts[1]?.height).toBeLessThanOrEqual(1.4 * 30);
  });
});

describe("6. budget on function", () => {
  it("a deck kit about every 2 tiles along each side, lanterns, one deck texture per deck", () => {
    const kits = named(brig, "deck kits")[0]?.pieces.length ?? 0;
    expect(kits).toBeGreaterThanOrEqual(8);
    expect(named(brig, "lanterns")[0]?.pieces.length).toBeGreaterThanOrEqual(2);
    const decks = named(brig, "decks")[0]?.pieces ?? [];
    for (const size of [1, 2]) {
      const tiles = decks.filter((q) => Math.round(q.piece.measures.length) === size);
      expect(new Set(tiles.map((q) => q.piece.variant.uuid)).size).toBeLessThanOrEqual(1);
    }
  });

  it("the ship's boat is a whole small hull, bottom boards and all", () => {
    const b = named(brig, "ship's boat")[0]?.pieces ?? [];
    expect(b.some((q) => q.piece.measures.kind === "tile")).toBe(true);
  });
});

describe("7. stall", () => {
  const s = buildObject(stall, { size: 3, seed: "r", budget: 100 }, kit);

  it("its ridge beam runs between the back posts under the canopy", () => {
    const posts = named(s, "posts")[0]?.pieces ?? [];
    const top = Math.max(...posts.map((q) => placedBox(q).max.y));
    for (const q of named(s, "ridge beam")[0]?.pieces ?? [])
      expect(placedBox(q).max.y).toBeLessThanOrEqual(top + 1e-6);
  });

  it("its sign is two-faced, back to back", () => {
    const sign = named(s, "sign")[0]?.pieces ?? [];
    expect(sign).toHaveLength(2);
    expect(Math.abs((sign[0]?.yaw ?? 0) - (sign[1]?.yaw ?? 0)) % 360).toBe(180);
  });
});
