/**
 * The per-generator profile (src/plan/generator.ts) is the one place that says what each generator does. Released
 * generators are frozen, so their entries are pinned here by the names of the switches they turn on: a new switch
 * must stay off in them, and turning one on for a released generator fails this test before any golden would.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSION, GENERATOR_VERSIONS } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import {
  GENERATOR_PROFILES,
  VOCABULARY_SINCE,
  generatorProfile,
  type GeneratorProfile,
} from "../../../src/plan/generator";

const switchesOn = (p: GeneratorProfile): string[] =>
  Object.entries(p)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort();

/** What each released generator turned on, by name (in addition to the one before it). Never edit these lists. */
const RELEASED: Record<1 | 2 | 3, readonly string[]> = {
  1: [],
  2: [
    "buildings",
    "cliffRockBand",
    "designReview",
    "dressWholeLevel",
    "featureLift",
    "foundation",
    "naturalLevelOutline",
    "naturalPaths",
    "naturalScatter",
    "naturalThemeWalls",
    "organicBands",
    "raggedTerrainEdges",
    "ramps",
    "realPieceSizes",
    "riverCourses",
    "roads",
    "rockWallSkirt",
    "scatterKeepsClear",
    "underHeightField",
  ],
  3: [
    "boardEdgeExits",
    "buildingVariety",
    "causedGroundCover",
    "caveRockMass",
    "cliffToneRule",
    "defaultCliffBands",
    "depthInTiles",
    "explainedLinkRuns",
    "floorFamilies",
    "floorOpenings",
    "furnitureOffWalls",
    "legibleCondition",
    "levelFootprints",
    "levelsJudgedTogether",
    "litLandmarks",
    "naturalStanding",
    "realPieceOutlines",
    "restingCliffBand",
    "rockGroundFaces",
    "roofValleys",
    "roughenedLumps",
    "roundedRises",
    "spursReachTargets",
    "stallsAndLines",
    "subCellOffsets",
    "supportedParts",
    "turnedFloorTiles",
    "voidIsBasePlane",
    "wallMountSnap",
    "wanderingChannels",
    "waterBody",
    "waterLevelChecks",
    "wholeFacades",
    "wildPlatforms",
  ],
};

describe("generator profiles", () => {
  it("has one profile per generator version, each naming its own version", () => {
    expect(Object.keys(GENERATOR_PROFILES).map(Number)).toEqual([...GENERATOR_VERSIONS]);
    for (const v of GENERATOR_VERSIONS) expect(generatorProfile(v).version).toBe(v);
    expect(generatorProfile({ generator: GENERATOR_VERSION })).toBe(GENERATOR_PROFILES[GENERATOR_VERSION]);
  });

  it("refuses a version it does not know", () => {
    expect(() => generatorProfile(0)).toThrow(/unknown generator/);
    expect(() => generatorProfile(GENERATOR_VERSION + 1)).toThrow(/unknown generator/);
  });

  it("every profile has the same switches, and a switch once on stays on in later generators", () => {
    const keys = Object.keys(GENERATOR_PROFILES[1]).sort();
    for (const v of GENERATOR_VERSIONS)
      expect(Object.keys(GENERATOR_PROFILES[v]).sort(), `generator ${v}`).toEqual(keys);
    for (const v of GENERATOR_VERSIONS.slice(1)) {
      const before = switchesOn(GENERATOR_PROFILES[(v - 1) as 1 | 2 | 3]);
      const now = new Set(switchesOn(GENERATOR_PROFILES[v]));
      expect(
        before.filter((k) => !now.has(k)),
        `turned off at generator ${v}`,
      ).toEqual([]);
    }
  });

  it("the released generators turn on exactly what they shipped with", () => {
    let on: string[] = [];
    for (const v of [1, 2, 3] as const) {
      on = [...on, ...RELEASED[v]].sort();
      expect(switchesOn(GENERATOR_PROFILES[v]), `generator ${v}`).toEqual(on);
    }
    // tunings and vocabulary of the released generators
    for (const v of [1, 2, 3] as const) {
      expect(GENERATOR_PROFILES[v].openingOutline).toEqual({
        grain: 1.6,
        cut: 0.3,
        keepShare: 0.55,
        lobeCut: 0.74,
      });
      expect([
        ...GENERATOR_PROFILES[v].vocabulary.featureTypes,
        ...GENERATOR_PROFILES[v].vocabulary.levelFields,
      ]).toEqual([]);
    }
  });

  it("VOCABULARY_SINCE names the first generator whose profile understands the word", () => {
    for (const [type, since] of Object.entries(VOCABULARY_SINCE.featureTypes))
      for (const v of GENERATOR_VERSIONS)
        expect(GENERATOR_PROFILES[v].vocabulary.featureTypes.has(type), `${type} at ${v}`).toBe(v >= since);
    for (const [field, since] of Object.entries(VOCABULARY_SINCE.levelFields))
      for (const v of GENERATOR_VERSIONS)
        expect(GENERATOR_PROFILES[v].vocabulary.levelFields.has(field), `${field} at ${v}`).toBe(v >= since);
    expect(VOCABULARY_SINCE.featureTypes).toEqual({ clutter: 4, shelf_line: 4 });
    expect(VOCABULARY_SINCE.levelFields).toEqual({ roomDress: 4 });
  });

  it("a feature type's palette role appears in the same generator as the word (minGenerator matches the profile)", () => {
    const generic = loadPalettes().palettes["generic"];
    for (const [type, since] of Object.entries(VOCABULARY_SINCE.featureTypes))
      expect(generic?.roles[`feature.${type}`]?.minGenerator, `feature.${type}`).toBe(since);
  });
});
