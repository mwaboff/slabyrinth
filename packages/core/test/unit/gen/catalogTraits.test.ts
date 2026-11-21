/**
 * Feature and purpose traits live as fields of their tables (gen/catalog.ts FEATURE_INFO, gen/roomPurpose.ts
 * ROOM_PURPOSE_INFO), never as type lists in the code that reads them. These pin the rows that replaced such lists, so
 * moving a trait cannot quietly change which types carry it.
 */
import { describe, expect, it } from "vitest";
import type { FeatureType } from "../../../src/contracts/plan";
import { FEATURE_INFO, LIGHT_FEATURES, isLandmark } from "../../../src/gen/catalog";
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
});

describe("purpose traits are table fields", () => {
  it("no open fire where paper, cloth, straw or stored goods are kept", () => {
    const noFire = (Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[]).filter(
      (p) => ROOM_PURPOSE_INFO[p].noFire,
    );
    expect(noFire.sort()).toEqual(["bedroom", "laboratory", "library", "storeroom", "study", "treasury"]);
  });
});
