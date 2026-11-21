import { GENERATOR_VERSIONS, type GeneratorVersion } from "../contracts/plan";

/**
 * What each generator version does (architecture §2.7): one profile of named behaviour switches per version, the one
 * way to gate behaviour on a plan's generator. Code reads the switch, never a version number:
 *
 *   const gen = generatorProfile(plan);            // a plan, a resolved plan, or a placement grid's version
 *   if (gen.coveredStalls) { ...built from parts... }
 *
 * Each version's entry is the previous one plus what it turned on, so the table below is also the changelog of the
 * generators. Generators 1, 2 and 3 are released: their entries are frozen, and so is their output
 * (test/golden/generator2, generator3). New behaviour is a new switch, off in every released entry and on from the
 * open generator. Opening generator 5 means adding a version to GENERATOR_VERSIONS (contracts/plan.ts) and one entry
 * here built from generator 4's.
 *
 * Palette roles carry their own first generator (`minGenerator` in the palette data, palette/resolve.ts): palettes
 * are data, generated and user-written, so they name a version rather than a switch. A test keeps the roles of the
 * vocabulary below in step with it (test/unit/plan/generatorProfile.test.ts).
 *
 * Review policy (decided 2026-11-20, code review finding 4): the design review is advice about the build, not the
 * build, so its output is NOT frozen per generator: a new note may run on an older generator's plan when what it
 * measures is true there. Its advice must hold for the plan's own generator: a note whose action relies on newer
 * behaviour ("name the room and the generator dresses it") is gated on that behaviour's switch or words its action by
 * it (review/interiors.ts room_bare and room_unlit, review/review.ts opening_hidden).
 */
export interface GeneratorProfile {
  readonly version: GeneratorVersion;

  // ── generator 2 (released in 0.1.2) ──
  /** An under-layer `height` op sets the height of every cell in its shape, rock included (areas opened later inherit it). */
  readonly underHeightField: boolean;
  /** An area in a theme whose wall style is natural rock gets rock walls, not the built wall. */
  readonly naturalThemeWalls: boolean;
  /** Roads: sidewalks and crossings, pavements and frontages, vehicles parked in the kerb lane. */
  readonly roads: boolean;
  /** Natural paths wind like trails (a style "straight" path does not), with broken kerbs and spurs to what they serve. */
  readonly naturalPaths: boolean;
  /** A river or brook crosses the map from one board edge to another, off the high ground. */
  readonly riverCourses: boolean;
  /** Height ops and platforms on natural ground get ragged edges by default. */
  readonly raggedTerrainEdges: boolean;
  /** Stairs ops can be rock ramps; ramp cells stay clear of dressing. */
  readonly ramps: boolean;
  /** The bands of an uneven op wander like an organic outline (no straight or square stair-steps). */
  readonly organicBands: boolean;
  /** Generated dressing keeps off reserved, bridge and step cells. */
  readonly scatterKeepsClear: boolean;
  /** The placer knows the rock band's pieces at their real size (no band where a theme has none). */
  readonly realPieceSizes: boolean;
  /** A placement's `lift` raises the piece. */
  readonly featureLift: boolean;
  /** A level of natural ground gets an irregular outline instead of its rectangle. */
  readonly naturalLevelOutline: boolean;
  /** A dress op with no area dresses the whole level, region by region. */
  readonly dressWholeLevel: boolean;
  /** Natural pieces scatter in drifts and clumps and stand only where the ground carries them. */
  readonly naturalScatter: boolean;
  /** Natural cliff runs are recorded and faced by the dressing's rock band. */
  readonly cliffRockBand: boolean;
  /** A level has a foundation under its ground, the outside ground reaches down to it, and the water level is set. */
  readonly foundation: boolean;
  /** Rock walls reach down to the level's lowest floor, vary in height, turn their blocks and stop under the floor above. */
  readonly rockWallSkirt: boolean;
  /** Buildings and enclosures (level.structures). */
  readonly buildings: boolean;
  /** The agent runs the design review (and the substitution note) on the plan after each change. */
  readonly designReview: boolean;

  // ── generator 3 (released in 0.2.0) ──
  /** Rifts and rivers stray from the line between their ends (bridges span them square), are recorded as channels, rivers run in reaches. */
  readonly wanderingChannels: boolean;
  /** In a natural or cave level a platform is rock with a ragged outline unless the plan asks for worked stone. */
  readonly wildPlatforms: boolean;
  /** A gentle rise on natural ground is one rounded mound of fewer, taller steps. */
  readonly roundedRises: boolean;
  /** Small lumps and natural rises lose their square corners and get bitten sides. */
  readonly roughenedLumps: boolean;
  /** Floor openings look into the level below (rubble heaps, checks on both levels). */
  readonly floorOpenings: boolean;
  /** A link that does not fit says how long a run its rise needs and where it would lie. */
  readonly explainedLinkRuns: boolean;
  /** A void cell's ground is the base plane, not the stale height it kept. */
  readonly voidIsBasePlane: boolean;
  /** The placer knows pieces' real outlines and the cells off the board. */
  readonly realPieceOutlines: boolean;
  /** Market stalls and lines strung overhead. */
  readonly stallsAndLines: boolean;
  /** A wall-mounted piece asked for a cell without a wall snaps to the nearest wall face within one cell. */
  readonly wallMountSnap: boolean;
  /** A placement's sub-cell `offset` shifts the piece (within half a tile). */
  readonly subCellOffsets: boolean;
  /** Blocking furniture set against a wall stands clear of it. */
  readonly furnitureOffWalls: boolean;
  /** A trail spur ends exactly at its focal point and at the cell outside a building's door. */
  readonly spursReachTargets: boolean;
  /** Natural regions get a default rock band along their rises. */
  readonly defaultCliffBands: boolean;
  /** Fords are meant to be wet, and water above the board's water plane is reported dry. */
  readonly waterLevelChecks: boolean;
  /** Buildings vary along a street: style overrides, no repeated wall-and-roof pair, varied entrances. */
  readonly buildingVariety: boolean;
  /** No blank wall: windows on every long face, corners keep their wall, no chimney on a hip roof. */
  readonly wholeFacades: boolean;
  /** Weathered and ruined buildings read from the game camera: growth, ragged holes, stepped ruins, roof valleys. */
  readonly legibleCondition: boolean;
  /** Roofs that meet merge into valleys, and a chimney is a shorter stack on a breast (ResolvedStructure.valleys). */
  readonly roofValleys: boolean;
  /** A floor is one dominant tile family, a tonally close second only in feathered patches with a cause. */
  readonly floorFamilies: boolean;
  /** One rock tone per cliff; loose rock near a cliff follows it. */
  readonly cliffToneRule: boolean;
  /** Rock band pieces rest on the ground or on rock, plan with their real outline, turn and slide, and hide the face. */
  readonly restingCliffBand: boolean;
  /** A field of 1x2 floor pieces lies both ways round. */
  readonly turnedFloorTiles: boolean;
  /** Natural ground shows rock where its face is bare, never earth-coloured fill. */
  readonly rockGroundFaces: boolean;
  /** A passage that reaches the board edge is an exit: no rock column outside the bounds. */
  readonly boardEdgeExits: boolean;
  /** A cave wall is a mass of rock (gen/cavewall.ts), the wall column only its closing skin. */
  readonly caveRockMass: boolean;
  /** A natural standing piece (a stalagmite) is never a wall block. */
  readonly naturalStanding: boolean;
  /** Set pieces put things on things (parts on a support, toppers on tables). */
  readonly supportedParts: boolean;
  /** Dressed furniture stands on one height (no footprint across a step). */
  readonly levelFootprints: boolean;
  /** Water is dressed as one body (sunk boulders, shallows plants, shore rock, stepping stones). */
  readonly waterBody: boolean;
  /** Ground cover grows in fewer, denser drifts tied to a cause (damp ground, a camp, a tree). */
  readonly causedGroundCover: boolean;
  /** A landmark is lit: a floor light beside it when none stands near. */
  readonly litLandmarks: boolean;
  /** The review judges levels joined by links and floor openings as one map. */
  readonly levelsJudgedTogether: boolean;
  /** The review counts depth in whole tiles (half-tile lumps are not depth). */
  readonly depthInTiles: boolean;

  // ── generator 4 (open) ──
  /** Natural cave chambers and corridors get ragged outlines (resolve/caveOutline.ts). */
  readonly caveOutlines: boolean;
  /** A flat cave floor gets shelves (resolve/caveRelief.ts). */
  readonly caveRelief: boolean;
  /** Each room of a built interior gets a floor of its own and a step above the corridor. */
  readonly roomFloors: boolean;
  /** A platform top much paler than the room's floor takes a closer tone (resolve/interiorFloors.ts accentTop). */
  readonly accentTops: boolean;
  /** How a ragged floor opening is cut: noise grain and threshold of the rim bites, share kept, lobe threshold. */
  readonly openingOutline: {
    readonly grain: number;
    readonly cut: number;
    readonly keepShare: number;
    readonly lobeCut: number;
  };
  /** A floor opening's rim is low (a collapse none, with debris on its edge; a shaft a kerb; a balcony a railing). */
  readonly lowOpeningRims: boolean;
  /** The rubble under a collapse heaps into a mound. */
  readonly rubbleMounds: boolean;
  /** Rough interiors get rubble at the foot of their walls. */
  readonly wallFootRubble: boolean;
  /** Rooms are dressed and lit from their purpose (gen/rooms4.ts recipes); naming a room is enough. */
  readonly roomRecipes: boolean;
  /** A blocking piece keeps one more cell back from a doorway. */
  readonly doorwaysKeepClear: boolean;
  /** Covered market stalls built from parts (base, counters, posts, canopy). */
  readonly coveredStalls: boolean;
  /** Each area is classified once in resolve (purpose, abandoned, finish) for the compiler and the review. */
  readonly roomClassification: boolean;
  /** Built interior walls vary in height (rough tops) and settle beside raised rooms. */
  readonly interiorWallTops: boolean;
  /** A built interior is carved into a solid mass: cap, skirt and strips (compile/shell.ts). */
  readonly solidShell: boolean;
  /** A floor raised no more than its own slab abuts its neighbour's slab, with no fill course. */
  readonly flushRaisedFloors: boolean;
  /** Wall pieces and posts stop a quarter or half tile short where the edge says (sinking into the slab). */
  readonly exactWallTops: boolean;
  /** Cave rock is solid, filled from its foot with no see-through gap. */
  readonly solidCaveRock: boolean;
  /** A secret door is one removable plug in the wall line, reported to the GM. */
  readonly secretDoorPlug: boolean;
  /** Small things on surfaces (clutter, goods) share one family table over both roles (gen/surfaces.ts). */
  readonly sharedSmallThings: boolean;
  /** Verify checks every step of a stair run, not only the last. */
  readonly everyStepVerified: boolean;
  /** The review measures natural caves (hollow rock mass, flat floors, square outlines). */
  readonly naturalCaveReview: boolean;
  /** The review flags floor accents much paler than their room. */
  readonly floorAccentReview: boolean;
  /** Pitched roofs leave no open roof cell; the review measures roof gaps. */
  readonly closedRoofs: boolean;
  /** The resolver decides from the palettes the plan is compiled with (palette/view.ts paletteOptionsFor). */
  readonly resolveWithCompilePalettes: boolean;
  /** Plan vocabulary this generator understands beyond the base set (validation warns `no_effect` below it). */
  readonly vocabulary: {
    readonly featureTypes: ReadonlySet<string>;
    readonly levelFields: ReadonlySet<string>;
  };
}

const GENERATOR_1: GeneratorProfile = {
  version: 1,
  underHeightField: false,
  naturalThemeWalls: false,
  roads: false,
  naturalPaths: false,
  riverCourses: false,
  raggedTerrainEdges: false,
  ramps: false,
  organicBands: false,
  scatterKeepsClear: false,
  realPieceSizes: false,
  featureLift: false,
  naturalLevelOutline: false,
  dressWholeLevel: false,
  naturalScatter: false,
  cliffRockBand: false,
  foundation: false,
  rockWallSkirt: false,
  buildings: false,
  designReview: false,
  wanderingChannels: false,
  wildPlatforms: false,
  roundedRises: false,
  roughenedLumps: false,
  floorOpenings: false,
  explainedLinkRuns: false,
  voidIsBasePlane: false,
  realPieceOutlines: false,
  stallsAndLines: false,
  wallMountSnap: false,
  subCellOffsets: false,
  furnitureOffWalls: false,
  spursReachTargets: false,
  defaultCliffBands: false,
  waterLevelChecks: false,
  buildingVariety: false,
  wholeFacades: false,
  legibleCondition: false,
  roofValleys: false,
  floorFamilies: false,
  cliffToneRule: false,
  restingCliffBand: false,
  turnedFloorTiles: false,
  rockGroundFaces: false,
  boardEdgeExits: false,
  caveRockMass: false,
  naturalStanding: false,
  supportedParts: false,
  levelFootprints: false,
  waterBody: false,
  causedGroundCover: false,
  litLandmarks: false,
  levelsJudgedTogether: false,
  depthInTiles: false,
  caveOutlines: false,
  caveRelief: false,
  roomFloors: false,
  accentTops: false,
  openingOutline: { grain: 1.6, cut: 0.3, keepShare: 0.55, lobeCut: 0.74 },
  lowOpeningRims: false,
  rubbleMounds: false,
  wallFootRubble: false,
  roomRecipes: false,
  doorwaysKeepClear: false,
  coveredStalls: false,
  roomClassification: false,
  interiorWallTops: false,
  solidShell: false,
  flushRaisedFloors: false,
  exactWallTops: false,
  solidCaveRock: false,
  secretDoorPlug: false,
  sharedSmallThings: false,
  everyStepVerified: false,
  naturalCaveReview: false,
  floorAccentReview: false,
  closedRoofs: false,
  resolveWithCompilePalettes: false,
  vocabulary: { featureTypes: new Set(), levelFields: new Set() },
};

const GENERATOR_2: GeneratorProfile = {
  ...GENERATOR_1,
  version: 2,
  underHeightField: true,
  naturalThemeWalls: true,
  roads: true,
  naturalPaths: true,
  riverCourses: true,
  raggedTerrainEdges: true,
  ramps: true,
  organicBands: true,
  scatterKeepsClear: true,
  realPieceSizes: true,
  featureLift: true,
  naturalLevelOutline: true,
  dressWholeLevel: true,
  naturalScatter: true,
  cliffRockBand: true,
  foundation: true,
  rockWallSkirt: true,
  buildings: true,
  designReview: true,
};

const GENERATOR_3: GeneratorProfile = {
  ...GENERATOR_2,
  version: 3,
  wanderingChannels: true,
  wildPlatforms: true,
  roundedRises: true,
  roughenedLumps: true,
  floorOpenings: true,
  explainedLinkRuns: true,
  voidIsBasePlane: true,
  realPieceOutlines: true,
  stallsAndLines: true,
  wallMountSnap: true,
  subCellOffsets: true,
  furnitureOffWalls: true,
  spursReachTargets: true,
  defaultCliffBands: true,
  waterLevelChecks: true,
  buildingVariety: true,
  wholeFacades: true,
  legibleCondition: true,
  roofValleys: true,
  floorFamilies: true,
  cliffToneRule: true,
  restingCliffBand: true,
  turnedFloorTiles: true,
  rockGroundFaces: true,
  boardEdgeExits: true,
  caveRockMass: true,
  naturalStanding: true,
  supportedParts: true,
  levelFootprints: true,
  waterBody: true,
  causedGroundCover: true,
  litLandmarks: true,
  levelsJudgedTogether: true,
  depthInTiles: true,
};

const GENERATOR_4: GeneratorProfile = {
  ...GENERATOR_3,
  version: 4,
  caveOutlines: true,
  caveRelief: true,
  roomFloors: true,
  accentTops: true,
  // deeper bites at a coarser grain, so the outline reads as broken rather than as a nibbled rectangle
  openingOutline: { grain: 2.2, cut: 0.36, keepShare: 0.45, lobeCut: 0.6 },
  lowOpeningRims: true,
  rubbleMounds: true,
  wallFootRubble: true,
  roomRecipes: true,
  doorwaysKeepClear: true,
  coveredStalls: true,
  roomClassification: true,
  interiorWallTops: true,
  solidShell: true,
  flushRaisedFloors: true,
  exactWallTops: true,
  solidCaveRock: true,
  secretDoorPlug: true,
  sharedSmallThings: true,
  everyStepVerified: true,
  naturalCaveReview: true,
  floorAccentReview: true,
  closedRoofs: true,
  resolveWithCompilePalettes: true,
  vocabulary: { featureTypes: new Set(["clutter", "shelf_line"]), levelFields: new Set(["roomDress"]) },
};

/** Every generator's profile, by version. */
export const GENERATOR_PROFILES: Readonly<Record<GeneratorVersion, GeneratorProfile>> = {
  1: GENERATOR_1,
  2: GENERATOR_2,
  3: GENERATOR_3,
  4: GENERATOR_4,
};

/**
 * The profile of a plan's generator. Takes a plan, a resolved plan or a version number (a placement grid's
 * `generator`); it is a table lookup that returns the same object for the same version, so call it where it is needed.
 */
export function generatorProfile(subject: { readonly generator: number } | number): GeneratorProfile {
  const version = typeof subject === "number" ? subject : subject.generator;
  const profile = (GENERATOR_PROFILES as Partial<Record<number, GeneratorProfile>>)[version];
  if (!profile)
    throw new Error(`unknown generator version ${String(version)} (known: ${GENERATOR_VERSIONS.join(", ")})`);
  return profile;
}

/**
 * Plan vocabulary that exists only from a generator on, with that generator: derived from the profiles' `vocabulary`.
 * The schema accepts these names for every generator (a plan can be re-pointed at another generator without being
 * rejected), so a plan that uses one below its generator is warned: the generator would ignore the field or
 * substitute the piece, and the model should hear that instead of seeing nothing.
 */
export const VOCABULARY_SINCE: {
  readonly featureTypes: Readonly<Record<string, GeneratorVersion>>;
  readonly levelFields: Readonly<Record<string, GeneratorVersion>>;
} = (() => {
  const featureTypes: Record<string, GeneratorVersion> = {};
  const levelFields: Record<string, GeneratorVersion> = {};
  for (const v of [...GENERATOR_VERSIONS].reverse()) {
    for (const t of GENERATOR_PROFILES[v].vocabulary.featureTypes) featureTypes[t] = v;
    for (const f of GENERATOR_PROFILES[v].vocabulary.levelFields) levelFields[f] = v;
  }
  return { featureTypes, levelFields };
})();
