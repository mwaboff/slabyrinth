/**
 * Feature and purpose traits live as fields of their tables (gen/catalog.ts FEATURE_INFO, gen/roomPurpose.ts
 * ROOM_PURPOSE_INFO), never as type lists in the code that reads them. These pin the rows that replaced such lists, so
 * moving a trait cannot quietly change which types carry it.
 */
import { describe, expect, it } from "vitest";
import { type FeatureType, OPENING_KINDS, type OpeningKind } from "../../../src/contracts/plan";
import { FEATURE_INFO, LIGHT_FEATURES, isLandmark } from "../../../src/gen/catalog";
import { OPENING_KIND_INFO } from "../../../src/gen/openingKinds";
import { ROOM_PURPOSE_INFO, type RoomPurpose } from "../../../src/gen/roomPurpose";

const types = Object.keys(FEATURE_INFO) as FeatureType[];

describe("feature traits are table fields", () => {
  it("landmarks are the great tree, the great statue and the landmark slot", () => {
    expect(types.filter(isLandmark).sort()).toEqual(["landmark", "statue_large", "tree_large"]);
  });

  it("every light source carries `light`, including the fires and torches once listed by hand", () => {
    for (const t of ["torch_wall", "brazier", "candelabra", "chandelier", "campfire"] as const)
      expect(LIGHT_FEATURES.has(t), t).toBe(true);
    expect([...LIGHT_FEATURES].sort()).toEqual(types.filter((t) => FEATURE_INFO[t].light === true).sort());
  });

  it("a candle stands on tables, desks, bar counters and altars; a lantern on counters and chests", () => {
    const by = (k: "candle" | "lantern"): FeatureType[] =>
      types.filter((t) => FEATURE_INFO[t].topLight === k).sort();
    expect(by("candle")).toEqual(["altar", "bar_counter", "desk", "round_table", "table"]);
    expect(by("lantern")).toEqual(["chest", "counter"]);
  });

  it("stalactites and chandeliers hang from the ceiling", () => {
    expect(types.filter((t) => FEATURE_INFO[t].ceilingMounted === true).sort()).toEqual([
      "chandelier",
      "stalactite",
    ]);
  });

  it("the organic dressing verify once listed by hand carries `organic`", () => {
    for (const t of [
      "tree",
      "dead_tree",
      "pine_tree",
      "bush",
      "rock",
      "boulder",
      "stump",
      "log",
      "mushroom",
      "tall_grass",
      "reeds",
      "flowers",
      "rubble",
      "bones",
      "web",
      "debris",
    ] as const)
      expect(FEATURE_INFO[t].organic, t).toBe(true);
  });
});

describe("opening-kind traits are table fields", () => {
  const kinds = Object.keys(OPENING_KIND_INFO) as OpeningKind[];
  const having = (t: keyof (typeof OPENING_KIND_INFO)["door"]): OpeningKind[] =>
    kinds.filter((k) => OPENING_KIND_INFO[k][t]).sort();

  it("covers every opening kind of the plan", () => {
    expect([...kinds].sort()).toEqual([...OPENING_KINDS].sort());
  });

  it("the lists the stages kept by hand are the rows", () => {
    // verify NOT_PASSAGE, playability NON_PASSABLE_OPENINGS, validate BLOCKING_OPENINGS
    expect(kinds.filter((k) => !OPENING_KIND_INFO[k].passage).sort()).toEqual([
      "arrow_slit",
      "bars",
      "window",
    ]);
    // the building planner's DOOR_KINDS
    expect(having("passage")).toEqual(
      ["archway", "door", "double_door", "locked_door", "open", "portcullis", "secret_door"].sort(),
    );
    // the compiler's DOORISH
    expect(having("leaf")).toEqual(["door", "double_door", "locked_door", "portcullis", "secret_door"]);
    // window || arrow_slit, the display list's WALL_LIKE_OPENINGS
    expect(having("window")).toEqual(["arrow_slit", "window"]);
    expect(having("secret")).toEqual(["secret_door"]);
  });
});

describe("purpose traits are table fields", () => {
  it("no open fire where paper, cloth, straw or stored goods are kept", () => {
    const noFire = (Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[]).filter(
      (p) => ROOM_PURPOSE_INFO[p].noFire,
    );
    expect(noFire.sort()).toEqual(["bedroom", "laboratory", "library", "storeroom", "study", "treasury"]);
  });
});
