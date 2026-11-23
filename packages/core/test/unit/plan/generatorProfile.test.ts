/**
 * The per-generator profile (src/plan/generator.ts) is the one place that says what each generator does. Released
 * generators are frozen, so their entries are pinned here by the names of the switches they turn on: a new switch
 * must stay off in them, and turning one on for a released generator fails this test before any golden would.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSION, GENERATOR_VERSIONS, type GeneratorVersion } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import {
  GENERATOR_PROFILES,
  SWITCH_DECLARATIONS,
  VOCABULARY_SINCE,
  generatorProfile,
  type GeneratorProfile,
  type SwitchName,
} from "../../../src/plan/generator";

const switchesOn = (p: GeneratorProfile): string[] =>
  Object.entries(p)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort();

/** What each released generator turned on, by name (in addition to the one before it). Never edit these lists. */
const RELEASED: Record<1 | 2 | 3 | 4, readonly string[]> = {
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
  4: [
    "accentTops",
    "buildingReach",
    "caveOutlines",
    "caveRelief",
    "ceilingOverRooms",
    "channelFloorWhole",
    "closedRoofs",
    "columnsCloseHighestFloor",
    "coveredStalls",
    "doorwaysKeepClear",
    "edgePiecesByBox",
    "everyStepVerified",
    "exactWallTops",
    "floorAccentReview",
    "flushRaisedFloors",
    "gatesTiled",
    "interiorWallTops",
    "lightsOffLandmarks",
    "linesClearPorches",
    "lowMassesOffNeighbours",
    "lowOpeningRims",
    "marketFurnitureOffWalls",
    "mountsOnBuiltWalls",
    "naturalCaveReview",
    "openingKindTraits",
    "outlineRoomReading",
    "paletteThemeDefaults",
    "partyWallsOutsideTaller",
    "pasteBesideMap",
    "piecesInCellTheme",
    "quietYardZones",
    "reachBlamesPathBlocker",
    "resolveWithCompilePalettes",
    "roomClassification",
    "roomFloors",
    "roomRecipes",
    "rubbleMounds",
    "secretDoorPlug",
    "sharedSmallThings",
    "solidCaveRock",
    "solidShell",
    "wallFootRubble",
    "wallNoteInFaceTheme",
    "waysInKeepClear",
    "windowsInOneVolume",
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

  it("every switch is declared with a description and a generator it starts in", () => {
    const names = Object.keys(SWITCH_DECLARATIONS);
    expect(names.length).toBeGreaterThan(0);
    for (const [name, decl] of Object.entries(SWITCH_DECLARATIONS)) {
      expect(GENERATOR_VERSIONS, `${name} starts in`).toContain(decl.since);
      expect(decl.description.trim().length, `${name} description`).toBeGreaterThan(10);
    }
    // the table is the changelog: it runs from the oldest generator to the newest
    const starts = Object.values(SWITCH_DECLARATIONS).map((d) => d.since);
    expect(starts, "switches are grouped by starting generator, oldest first").toEqual(
      [...starts].sort((a, b) => a - b),
    );
  });

  it("a refinement names an earlier or same-generator switch, and no released generator holds one of its own", () => {
    for (const [name, decl] of Object.entries(SWITCH_DECLARATIONS)) {
      if (decl.refines === undefined) continue;
      const base = (SWITCH_DECLARATIONS as Record<string, (typeof SWITCH_DECLARATIONS)[SwitchName]>)[
        decl.refines
      ];
      expect(base, `${name} refines ${decl.refines}`).toBeDefined();
      expect(base?.since ?? Infinity, `${name} refines a later switch`).toBeLessThanOrEqual(decl.since);
      // (a refinement of a switch of its own generator is folded into it before that generator is released)
      if (base?.since === decl.since)
        expect(decl.since, `${name}: fold it into ${decl.refines} before release`).toBe(GENERATOR_VERSION);
    }
  });

  it("every profile carries exactly the declared switches, on from the generator each starts in", () => {
    for (const v of GENERATOR_VERSIONS) {
      const profile = GENERATOR_PROFILES[v];
      for (const [name, decl] of Object.entries(SWITCH_DECLARATIONS))
        expect(profile[name as SwitchName], `${name} at generator ${v}`).toBe(decl.since <= v);
      const booleans = Object.entries(profile)
        .filter(([, value]) => typeof value === "boolean")
        .map(([key]) => key);
      expect(booleans.sort(), `generator ${v}`).toEqual(Object.keys(SWITCH_DECLARATIONS).sort());
    }
  });

  it("a switch once on stays on in later generators", () => {
    for (const v of GENERATOR_VERSIONS.slice(1)) {
      const before = switchesOn(GENERATOR_PROFILES[(v - 1) as GeneratorVersion]);
      const now = new Set(switchesOn(GENERATOR_PROFILES[v]));
      expect(
        before.filter((k) => !now.has(k)),
        `turned off at generator ${v}`,
      ).toEqual([]);
    }
  });

  it("the released generators turn on exactly what they shipped with", () => {
    let on: string[] = [];
    for (const v of [1, 2, 3, 4] as const) {
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
        ...GENERATOR_PROFILES[v].vocabulary.areaFields,
      ]).toEqual([]);
    }
    expect(GENERATOR_PROFILES[4].openingOutline).toEqual({
      grain: 2.2,
      cut: 0.36,
      keepShare: 0.45,
      lobeCut: 0.6,
    });
    expect(GENERATOR_PROFILES[4].vocabulary).toEqual({
      featureTypes: new Set(["clutter", "shelf_line"]),
      levelFields: new Set(["roomDress"]),
      areaFields: new Set(["purpose"]),
    });
  });

  it("VOCABULARY_SINCE names the first generator whose profile understands the word", () => {
    for (const kind of ["featureTypes", "levelFields", "areaFields"] as const)
      for (const [word, since] of Object.entries(VOCABULARY_SINCE[kind]))
        for (const v of GENERATOR_VERSIONS)
          expect(GENERATOR_PROFILES[v].vocabulary[kind].has(word), `${kind} ${word} at ${v}`).toBe(
            v >= since,
          );
    expect(VOCABULARY_SINCE).toEqual({
      featureTypes: { clutter: 4, shelf_line: 4 },
      levelFields: { roomDress: 4 },
      areaFields: { purpose: 4 },
    });
  });

  it("a feature type's palette role appears in the same generator as the word (minGenerator matches the profile)", () => {
    const generic = loadPalettes().palettes["generic"];
    for (const [type, since] of Object.entries(VOCABULARY_SINCE.featureTypes))
      expect(generic?.roles[`feature.${type}`]?.minGenerator, `feature.${type}`).toBe(since);
  });
});
