/**
 * The wall-style trait table (gen/wallStyles.ts) and the palette role chain that replaced a role name hard-coded in the
 * compiler (roof.default.cap), generator 4 code review findings 5, 6 and 13.
 */
import { describe, expect, it } from "vitest";
import { WALL_STYLES, type MapPlan } from "../../../src/contracts/plan";
import {
  WALL_STYLE_INFO,
  hasNaturalWallStyle,
  isLowWallStyle,
  isNaturalWallStyle,
  isUnevenWallStyle,
  naturalStyleRefs,
  wallStyleInfo,
} from "../../../src/gen/wallStyles";
import { createRoleResolver, loadPalettes } from "../../../src/palette";
import { validatePlan } from "../../../src/plan";
import { loadPlan } from "../../fixtures";

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const having = (key: "natural" | "low" | "uneven"): string[] =>
  WALL_STYLES.filter((s) => WALL_STYLE_INFO[s][key]);

describe("wall style traits", () => {
  it("has a row for every wall style and no other", () => {
    expect(sorted(Object.keys(WALL_STYLE_INFO))).toEqual(sorted(WALL_STYLES));
  });

  it("only cave rock is natural", () => {
    expect(having("natural")).toEqual(["cave_rock"]);
    expect(isNaturalWallStyle("cave_rock")).toBe(true);
    expect(isNaturalWallStyle("stone")).toBe(false);
    expect(isNaturalWallStyle(undefined)).toBe(false);
    expect(hasNaturalWallStyle(["wall", "cave_rock"])).toBe(true);
    expect(hasNaturalWallStyle(["wall", "stone"])).toBe(false);
    expect([...naturalStyleRefs(["wall", "cave_rock", "stone", "cave_rock"])]).toEqual([1, 3]);
  });

  it("kerbs, parapets and rails are low, a wall is not; no rim at all is low too", () => {
    expect(sorted(having("low"))).toEqual(sorted(["fence", "low_wall", "railing", "railing_stone"]));
    expect(isLowWallStyle("none")).toBe(true);
    expect(isLowWallStyle("low_wall")).toBe(true);
    expect(isLowWallStyle("wall")).toBe(false);
    expect(isLowWallStyle("stone")).toBe(false);
  });

  it("stone, brick and dark stone can stand uneven like the plain and the ruined wall", () => {
    expect(sorted(having("uneven"))).toEqual(sorted(["wall", "ruined", "stone", "brick", "dark_stone"]));
    for (const s of ["wall", "ruined", "stone", "brick", "dark_stone"]) expect(isUnevenWallStyle(s), s).toBe(true);
    // dressed, kept-up and open styles stay clean
    for (const s of ["marble", "plaster", "wood", "timber", "concrete", "metal", "panel", "iron_bars", "palisade", "hedge"])
      expect(isUnevenWallStyle(s), s).toBe(false);
    // a style that is not set is the theme's plain wall
    expect(isUnevenWallStyle(undefined)).toBe(true);
  });

  it("natural rock is never also uneven or low (the cave work owns it)", () => {
    for (const s of WALL_STYLES)
      if (WALL_STYLE_INFO[s].natural) expect(WALL_STYLE_INFO[s].uneven || WALL_STYLE_INFO[s].low, s).toBe(false);
  });

  it("names no theme and knows nothing about a name that is not a style", () => {
    expect(wallStyleInfo("granite")).toBeUndefined();
    expect(wallStyleInfo("none")).toBeUndefined();
    expect(wallStyleInfo("constructor")).toBeUndefined();
    expect(JSON.stringify(WALL_STYLE_INFO)).not.toMatch(/wood_town|stone_dungeon|city|tavern/);
  });
});

describe("the ridge cap is a palette role chain, not a role name in the compiler", () => {
  const cat = loadPalettes();

  it("generator 4: a kit with no cap or flat piece falls to roof.default.cap and the slate cap", () => {
    const r = createRoleResolver(cat, 4)("generic", "roof.default.cap").resolution;
    expect(r?.role).toBe("roof.slate.cap");
    expect(r?.variants.length).toBeGreaterThan(0);
    // the village kit has neither piece of its own
    expect(createRoleResolver(cat, 4)("generic", "roof.village.cap").resolution).toBeNull();
    expect(createRoleResolver(cat, 4)("generic", "roof.village.flat").resolution).toBeNull();
  });

  it("generator 3 does not see the role", () => {
    expect(createRoleResolver(cat, 3)("generic", "roof.default.cap").resolution).toBeNull();
  });
});

describe("generator 4 vocabulary on an earlier generator", () => {
  const withFeature = (generator: 3 | 4, type: string, roomDress?: false): MapPlan => {
    const plan = structuredClone<MapPlan>(loadPlan("single-room"));
    plan.generator = generator;
    const level = plan.levels[0] as MapPlan["levels"][number];
    level.features.push({ id: "extra", type, at: [4, 6] } as MapPlan["levels"][number]["features"][number]);
    if (roomDress === false) level.roomDress = false;
    return plan;
  };
  const noEffect = (plan: MapPlan): string[] =>
    validatePlan(plan).issues.filter((i) => i.code === "no_effect").map((i) => `${i.severity} ${i.path ?? ""}`);

  it("warns on clutter, shelf_line and roomDress below generator 4", () => {
    expect(noEffect(withFeature(3, "clutter"))).toHaveLength(1);
    expect(noEffect(withFeature(3, "clutter"))[0]).toMatch(/^warning \/levels\/0\/features\/\d+\/type$/);
    expect(noEffect(withFeature(3, "shelf_line"))).toHaveLength(1);
    expect(noEffect(withFeature(3, "chest", false))).toEqual(["warning /levels/0/roomDress"]);
  });

  it("is quiet on generator 4 and for older feature types", () => {
    expect(noEffect(withFeature(4, "clutter"))).toEqual([]);
    expect(noEffect(withFeature(4, "chest", false))).toEqual([]);
    expect(noEffect(withFeature(3, "chest"))).toEqual([]);
  });

  it("still validates (a warning is not an error)", () => {
    expect(validatePlan(withFeature(3, "clutter")).ok).toBe(true);
  });
});
