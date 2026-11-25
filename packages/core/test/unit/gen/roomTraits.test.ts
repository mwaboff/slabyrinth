/**
 * Generator 5, the room-kind table (gen/roomTraits.ts) and the kinds the classifier reads (gen/roomPurpose.ts, switch
 * roomKinds). The table is typed over every kind, so a kind without a row does not compile; these pin what the type
 * cannot: every row has an anchor and a minimum set made of its own pieces, ranges are ranges, and the words of the new
 * kinds read as the kind at generator 5 and as before at generator 4.
 */
import { describe, expect, it } from "vitest";
import { ROOM_PURPOSES } from "../../../src/contracts/plan";
import { featureInfo } from "../../../src/gen/catalog";
import { classifyRoom, furnishedPurpose, NEW_KIND_INFO } from "../../../src/gen/roomPurpose";
import { ROOM_KINDS, ROOM_TRAITS, roomTargets } from "../../../src/gen/roomTraits";

describe("the room-kind table", () => {
  it("has a row for every furnished purpose and every new kind, and no other", () => {
    const expected = [
      ...ROOM_PURPOSES.filter((p) => furnishedPurpose(p)),
      ...Object.keys(NEW_KIND_INFO),
    ].sort();
    expect([...ROOM_KINDS].sort()).toEqual(expected);
  });

  it("every row has an anchor group and a minimum set made of its first group's pieces", () => {
    for (const kind of ROOM_KINDS) {
      const t = ROOM_TRAITS[kind];
      expect(t.groups.length, kind).toBeGreaterThan(0);
      expect(t.minimum.length, kind).toBeGreaterThan(0);
      const first = t.groups[0];
      const names = new Set([first.name, ...first.companions.map((c) => c.name), "light"]);
      for (const m of t.minimum) expect(names.has(m), `${kind}: minimum "${m}"`).toBe(true);
      // the minimum names the anchor
      expect(t.minimum[0], kind).toBe(first.name);
    }
  });

  it("every piece is a feature type of the catalog; a new kind's host is its classifier host", () => {
    for (const kind of ROOM_KINDS) {
      const t = ROOM_TRAITS[kind];
      for (const g of t.groups) {
        expect(featureInfo(g.anchor.type), `${kind} anchor`).toBeDefined();
        for (const c of g.companions)
          for (const p of c.pieces) expect(featureInfo(p.type), `${kind} ${c.name}`).toBeDefined();
      }
      for (const s of t.lining)
        expect(featureInfo(s.type).wallMounted, `${kind} lining ${s.type}`).toBeFalsy();
      const host = Object.hasOwn(NEW_KIND_INFO, kind)
        ? NEW_KIND_INFO[kind as keyof typeof NEW_KIND_INFO].host
        : kind;
      expect(t.host, kind).toBe(host);
    }
  });

  it("ranges are ranges and shares are shares", () => {
    for (const kind of ROOM_KINDS) {
      const t = ROOM_TRAITS[kind];
      for (const [lo, hi] of [t.nearWall, t.clear, t.lights.per10, t.props10])
        expect(lo, kind).toBeLessThanOrEqual(hi);
      for (const [lo, hi] of [t.nearWall, t.clear]) {
        expect(lo, kind).toBeGreaterThanOrEqual(0);
        expect(hi, kind).toBeLessThanOrEqual(1);
      }
      expect(t.fill, kind).toBeGreaterThan(0);
      expect(t.fill, kind).toBeLessThan(0.6);
    }
  });

  it("exports what the review by purpose and the floor groups read", () => {
    expect(roomTargets("tavern")).toMatchObject({
      floorGroups: true,
      stationRows: false,
      anchors: ["bar_counter"],
    });
    expect(roomTargets("classroom")).toMatchObject({ stationRows: true, nearWall: [0.3, 0.5] });
    expect(roomTargets("bedroom").anchors).toEqual(["bed"]);
    expect(roomTargets("command").lightsPer10[0]).toBeGreaterThan(roomTargets("barracks").lightsPer10[1]);
  });
});

describe("room kinds from words (generator 5, switch roomKinds)", () => {
  const g5 = (w: Parameters<typeof classifyRoom>[0]) => classifyRoom(w, { kinds: true });

  it("new kinds read as the kind, written as the purpose that hosts them", () => {
    expect(g5({ name: "General shop" })).toEqual({ purpose: "storeroom", kind: "shop", abandoned: false });
    expect(g5({ name: "Stables" })).toMatchObject({ purpose: "storeroom", kind: "stable" });
    expect(g5({ name: "Drawing room" })).toMatchObject({ purpose: "study", kind: "lounge" });
    expect(g5({ name: "Schoolroom" })).toMatchObject({ purpose: "library", kind: "classroom" });
    expect(g5({ name: "Helm" })).toMatchObject({ purpose: "study", kind: "command" });
    expect(g5({ name: "Infirmary" })).toMatchObject({ purpose: "laboratory", kind: "ward" });
    // an existing purpose is its own kind
    expect(g5({ name: "Kitchen" })).toEqual({ purpose: "kitchen", kind: "kitchen", abandoned: false });
  });

  it("fixes the readings generator 4 got wrong, and only at generator 5", () => {
    expect(classifyRoom({ name: "Parlour" })).toEqual({ purpose: "study", abandoned: false });
    expect(g5({ name: "Parlour" })).toMatchObject({ purpose: "study", kind: "lounge" });
    expect(classifyRoom({ name: "Dormitory" }).purpose).toBe("bedroom");
    expect(g5({ name: "Dormitory" })).toMatchObject({ purpose: "barracks", kind: "barracks" });
    expect(classifyRoom({ name: "Cargo hold" }).purpose).toBeUndefined();
    expect(g5({ name: "Cargo hold" })).toMatchObject({ purpose: "storeroom", kind: "storeroom" });
    expect(classifyRoom({ name: "Shop" }).purpose).toBeUndefined();
    expect(classifyRoom({ name: "Shop" }).kind).toBeUndefined();
  });

  it("a stated purpose keeps a kind its words name only when the kind lives in it", () => {
    expect(g5({ name: "Drawing room", purpose: "study" })).toMatchObject({
      purpose: "study",
      kind: "lounge",
    });
    expect(g5({ name: "Shop", purpose: "bedroom" })).toMatchObject({ purpose: "bedroom", kind: "bedroom" });
  });

  it("no new word steals a neighbour's meaning", () => {
    expect(g5({ name: "Market stalls" }).kind).toBeUndefined();
    expect(g5({ name: "Ruined shop" })).toEqual({ purpose: "ruin", abandoned: true });
    expect(g5({ name: "Abandoned shop" })).toMatchObject({
      purpose: "storeroom",
      kind: "shop",
      abandoned: true,
    });
    expect(g5({ name: "Shop passage" })).toEqual({ purpose: "passage", abandoned: false });
  });
});
