/**
 * Feature and purpose traits live as fields of their tables (gen/catalog.ts FEATURE_INFO, gen/roomPurpose.ts
 * ROOM_PURPOSE_INFO), never as type lists in the code that reads them. These pin the rows that replaced such lists, so
 * moving a trait cannot quietly change which types carry it.
 */
import { describe, expect, it } from "vitest";
import { type FeatureType, OPENING_KINDS, type OpeningKind } from "../../../src/contracts/plan";
import { FEATURE_INFO, LIGHT_FEATURES, isLandmark } from "../../../src/gen/catalog";
import { OPENING_KIND_INFO, isFullHeightOpeningRole } from "../../../src/gen/openingKinds";
import { CLUSTERED_TYPES } from "../../../src/gen/place";
import { type FurnishedPurpose, ROOM_PURPOSE_INFO, type RoomPurpose } from "../../../src/gen/roomPurpose";
import { COVER_CAUSES, FOCAL_LIT, RUNNERS } from "../../../src/gen/setpieces";
import { NATURAL_MATERIALS } from "../../../src/review";

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

  it("the rock band, ground causes and strewn litter once listed by hand are rows", () => {
    const sorted = (f: (t: FeatureType) => boolean): FeatureType[] => types.filter(f).sort();
    expect(sorted((t) => FEATURE_INFO[t].bandRock === true)).toEqual(["cliff_crest", "cliff_face"]);
    // compile/realize/floors.ts CAUSE_FEATURES (generator 2)
    expect(sorted((t) => FEATURE_INFO[t].groundCause === "litter")).toEqual(
      ["campfire", "cluster_tall", "dead_tree", "fire_pit", "pine_tree", "tent", "tree", "tree_large"].sort(),
    );
    // resolve/floorFamilies.ts GROUND_CAUSE_FEATURES added these (generator 3)
    expect(sorted((t) => FEATURE_INFO[t].groundCause === "wear")).toEqual([
      "altar",
      "fountain",
      "monolith",
      "statue",
      "well",
    ]);
    // review/interiors.ts LITTER
    expect(sorted((t) => FEATURE_INFO[t].strewn === true)).toEqual(
      ["bones", "cave_in", "debris", "rubble", "skull_pile", "web"].sort(),
    );
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

describe("traits a released generator reads keep the lists it shipped with", () => {
  // These are pins on purpose: generators 2 and 3 are frozen, and each of these traits replaced a list one of them read.
  const sorted = (f: (t: FeatureType) => boolean): FeatureType[] => types.filter(f).sort();
  const set = (s: ReadonlySet<FeatureType>): FeatureType[] => [...s].sort();

  it("the set-piece composer's overhanging and upright pieces (BIG, RUNNERS)", () => {
    expect(sorted((t) => FEATURE_INFO[t].overhangs === true)).toEqual(
      [
        "cluster_tall",
        "dead_tree",
        "formation",
        "landmark",
        "pine_tree",
        "statue_large",
        "tree",
        "tree_large",
      ].sort(),
    );
    expect(set(RUNNERS)).toEqual(
      [
        "boulder",
        "cluster_tall",
        "dead_tree",
        "edge_dressing",
        "formation",
        "monolith",
        "pine_tree",
        "rock",
        "stalagmite",
        "standing_stone",
        "tall_marker",
        "tree",
      ].sort(),
    );
  });

  it("the focal pieces a trail spur leads to (SPUR_PRIMARY, SPUR_FOCAL)", () => {
    expect(sorted((t) => FEATURE_INFO[t].focal === "primary")).toEqual(
      ["giant_mushroom", "landmark", "monolith", "statue_large", "tree_large"].sort(),
    );
    expect(sorted((t) => FEATURE_INFO[t].focal === "lesser")).toEqual(
      ["altar", "campfire", "fire_pit", "fountain", "standing_stone", "statue", "tall_marker", "well"].sort(),
    );
  });

  it("the frozen deltas: what a lit place lights and what causes ground cover (generator 3)", () => {
    // the focal pieces that are not lights, less the natural ones; a throne is lit though no trail leads to it
    expect(set(FOCAL_LIT)).toEqual(
      [
        "altar",
        "fountain",
        "landmark",
        "monolith",
        "standing_stone",
        "statue",
        "statue_large",
        "tall_marker",
        "throne",
        "well",
      ].sort(),
    );
    // what litters the ground, less tall growth (generator 3 shipped without it), and a landmark
    expect(set(COVER_CAUSES)).toEqual(
      ["campfire", "dead_tree", "fire_pit", "landmark", "pine_tree", "tent", "tree", "tree_large"].sort(),
    );
  });

  it("the supports small props rest on, and the types that scatter in clumps", () => {
    expect(sorted((t) => FEATURE_INFO[t].support === true)).toEqual(
      ["boulder", "chest", "counter", "desk", "round_table", "stall", "table"].sort(),
    );
    expect(set(CLUSTERED_TYPES)).toEqual(
      ["candles", "crystal", "giant_mushroom", "root", "skull_pile", "stalactite", "stalagmite"].sort(),
    );
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
    // the opening pass's NO_LINTEL role names
    expect(having("fullHeight")).toEqual(["archway", "arrow_slit", "window"]);
    expect(isFullHeightOpeningRole("opening.archway")).toBe(true);
    expect(isFullHeightOpeningRole("opening.door")).toBe(false);
    expect(isFullHeightOpeningRole("opening.default")).toBe(false);
    expect(isFullHeightOpeningRole("wall.window")).toBe(false);
  });
});

describe("material traits are table fields", () => {
  it("the review's natural ground is the material table's natural trait (ice counts like snow)", () => {
    expect([...NATURAL_MATERIALS].sort()).toEqual(
      ["dirt", "grass", "gravel", "ice", "mud", "rock", "sand", "snow", "swamp"].sort(),
    );
  });
});

describe("purpose traits are table fields", () => {
  it("FurnishedPurpose (a type) names exactly the purposes whose row says `furnished`", () => {
    const furnished = (Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[]).filter(
      (p) => ROOM_PURPOSE_INFO[p].furnished,
    );
    // the type excludes these two; a new unfurnished purpose must be added to its Exclude (gen/roomPurpose.ts)
    const notFurnished: ReadonlyArray<Exclude<RoomPurpose, FurnishedPurpose>> = ["ruin", "passage"];
    expect(furnished.sort()).toEqual(
      (Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[])
        .filter((p) => !notFurnished.includes(p as never))
        .sort(),
    );
  });

  it("no open fire where paper, cloth, straw or stored goods are kept", () => {
    const noFire = (Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[]).filter(
      (p) => ROOM_PURPOSE_INFO[p].noFire,
    );
    expect(noFire.sort()).toEqual(["bedroom", "laboratory", "library", "storeroom", "study", "treasury"]);
  });
});
