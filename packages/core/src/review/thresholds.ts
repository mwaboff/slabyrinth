/**
 * Design review thresholds (data, not code). Each note fires when its measure crosses the threshold; `weight` ranks
 * notes against each other (higher = shown first). Tuned on the team's proof history (docs/decisions.md).
 */
import { MATERIALS } from "../contracts/plan";
import { isNaturalGround } from "../resolve/materials";
import { typesWith, type FeatureInfo } from "../gen/catalog";
import { COMPLEX } from "../gen/complexLayout";

export const REVIEW = {
  /** Notes shown at most (the rest are dropped, lowest rank first). */
  maxNotes: 6,
  /** Levels with fewer walkable cells are not reviewed. */
  minCells: 40,
  flat: {
    weight: 10,
    /** Share of walkable cells on the most common height band (half-tile bands). */
    maxShare: 0.85,
    /** Generator 3: no real depth when under 12% of the walkable cells (1 - coarseShare) lie `farQ` or more off the main level. */
    coarseShare: 0.88,
    /** 1.5 tiles in quarters. */
    farQ: 6,
    /** Distinct height bands holding at least `bandShare` of the walkable cells. */
    minBands: 2,
    bandShare: 0.03,
    /** A level with this many buildings takes its depth from them and is not judged flat. */
    buildingsGiveDepth: 3,
  },
  /** Rifts and rivers (generator 3 records the course): deviation of the centreline from the line between its ends. */
  channels: {
    weight: 9,
    /** Courses shorter than this (cells between the ends) are not judged. */
    minChord: 8,
    /** Largest stray of the centreline as a share of the chord (the resolver aims for 0.2; reference builds 0.15+). */
    deviation: 0.16,
    /** Courses this long need at least `minBends` bends (an S, not one arc). */
    bendsFrom: 14,
    minBends: 2,
    /** A body of channel cells (pit, bridge deck included) smaller than this is not a pit of the crack. */
    brokenMinCells: 10,
    /** A bridge deck at least this long whose long side lies within acos(alongCos) of the channel's course runs along it. */
    alongMinLength: 6,
    alongCos: 0.82,
  },
  /** A river cut to one level down a slope (cells; quarter tiles). */
  trench: {
    weight: 9,
    minCells: 16,
    /** Water bodies shorter than this (cells along their course) are ponds, not rivers. */
    minLength: 8,
    /** The bed sits this much deeper below the banks in one place than in another: 2 tiles. */
    minGrowQ: 8,
    /** … and the deep place lies at least this far below its banks (3 tiles; a normal channel is 1). */
    deepQ: 12,
  },
  straight: {
    weight: 8,
    /** Longest straight outline of a natural trail or water channel, cells (board edges excluded). */
    trail: 8,
    water: 8,
    /** Longest straight riser of natural ground (a step of half a tile or more), cells. */
    riser: 6,
    riserMinQuarters: 2,
    /** Share of water cells within one cell of the board edge. */
    waterOnEdge: 0.35,
    /** A strip this share of the map wide along one edge … */
    edgeBand: 0.18,
    /** … holding this share of the water is a course that runs along the border. */
    edgeBandShare: 0.75,
  },
  scatter: {
    weight: 7,
    /** Natural pieces of one type, evenly spaced along a line: this many in a row. */
    row: 4,
    /** Small ground pieces (ground cover, flowers, mushrooms) need a longer row to count. */
    rowSmall: 6,
    rowMinStep: 2,
    /** Spacing tolerance (cells) and the longest step that still reads as a row. */
    rowTolerance: 0.35,
    rowMaxStep: 6,
    /** Clark–Evans ratio above which a group of natural pieces is spread evenly (1 = random, < 1 clustered). */
    evenRatio: 1.35,
    evenMinCount: 8,
  },
  deadSpace: {
    weight: 6,
    /** Cells this far (Chebyshev) from any feature, building, path or water count as empty. */
    clearance: 3,
    /** The largest empty region: at least this many cells and this share of the walkable cells. */
    minCells: 80,
    minShare: 0.25,
  },
  lookalike: {
    weight: 6,
    /** Buildings this close (cells between footprints) are neighbours. */
    gap: 3,
    /** Neighbours must differ on at least this many axes (storeys, walls, roof, size, height). */
    minAxes: 2,
  },
  tone: {
    weight: 6,
    /** Neighbouring buildings (cells between footprints) … */
    gap: 3,
    /** … this many dark-walled ones together is a dark cluster. */
    darkCluster: 2,
  },
  roofs: {
    weight: 5,
    gap: 3,
    /** This many neighbours with the same roof form and surface read as one roof from above. */
    alike: 3,
  },
  floors: {
    weight: 6,
    /** Materials holding at least this share of the open ground count. */
    minShare: 0.1,
    /** This many such materials with the largest under `dominant` is a patchwork. */
    materials: 3,
    dominant: 0.55,
    /** A material covering this share of the ground is judged for its tile families (this many or more). */
    familyFieldShare: 0.3,
    families: 3,
    /** Generator 3: the laid floor's largest family covers at least this share of a natural field. */
    laidDominant: 0.7,
    /** Generator 3: the second family's share of the open ground, and its share in single squares or thin strings. */
    patchShare: 0.08,
    patchLonely: 0.2,
  },
  blankLot: {
    weight: 6,
    /** Paved cells at least this far (Chebyshev) from anything with a purpose (features, buildings, roads, paths). */
    clearance: 1,
    minCells: 30,
    /** Cells whose whole 5×5 surroundings are empty: a strip behind buildings has none, a lot has many. */
    minCore: 12,
  },
  focus: {
    weight: 6,
    /** Levels this large with no focal feature and no building get a note. */
    minCellsForFocal: 150,
    /** Primary pieces within this many cells are one group; more groups than `maxPrimaries` compete. */
    groupRadius: 6,
    maxPrimaries: 2,
  },
  routes: {
    weight: 5,
    /** Levels with at least this many rooms are judged for a loop. */
    minRooms: 5,
  },
  identical: {
    weight: 5,
    /** This many pieces of one look (a feature type whose theme role has few kinds) … */
    count: 5,
    /** … when the theme has at most this many kinds of it. */
    maxKinds: 2,
  },
  symmetry: {
    weight: 5,
    /** Share of building and prop cells with a mirror twin across a centre line or road axis. */
    share: 0.7,
    minCells: 30,
  },
  relief: {
    weight: 4,
    /** Buildings plus roads that make a level built-up. */
    builtMin: 3,
    /** Natural (or, in the wild, paved) ground under this share counts as none. */
    minShare: 0.02,
    /** Fewer growing things (trees, shrubs, flowers) than this counts as none in a built place. */
    minGrowth: 3,
  },
  streets: {
    weight: 5,
    /** The weight's factor for misplaced props: base, plus this much per prop, up to the cap. */
    misplacedBase: 0.8,
    misplacedPerProp: 0.2,
    misplacedCap: 2,
  },
  brief: {
    /** A word of the request the map does not show ranks high. */
    weight: 9,
  },
  bare: {
    weight: 6,
    /** Growth or rock within this many cells covers a cell of natural ground. */
    reach: 2,
    /** Natural ground with less cover than this share is bare (judged on levels with this many natural cells). */
    minCover: 0.5,
    minCells: 200,
  },
  /** Outcrops (small natural rises): a block with square corners reads as a crate, not as rock. */
  outcrops: {
    weight: 4,
    /** Outcrops of at least this many cells are judged … */
    minCells: 6,
    /** … square when they have this many corners with straight sides of `arm` cells or more (reference: a plain 5x4 block has 4, a rounded one 0-1). */
    squareCorners: 3,
    arm: 2,
  },
  terraces: {
    weight: 5,
    /** Height bands of at least this many cells inside an uneven op are judged … */
    minBand: 6,
    /** … for corners whose two sides run straight for `arm` cells or more; this many is a square terrace. */
    arm: 3,
    squareCorners: 4,
  },
  patches: {
    weight: 4,
    /** A painted patch of natural ground this large … */
    minCells: 12,
    /** … with no path, water, building, feature or rise within this many cells has no cause. */
    reach: 2,
  },
  reach: {
    weight: 5,
    /** A path this close (cells) to the focal point reaches it. */
    reach: 3,
  },
  /** Cave wall mass (generator 3; gen/cavewall.ts): walls with under `thin` cells of rock behind them are palisades. */
  caveWall: { weight: 6, depth: 4, thin: 3, share: 0.35, minFaces: 20 },
  /** Rock of more than one tone family in a cliff or a cave (advisory; gen/cover.ts cliffRockKinds). */
  rockTones: { weight: 3 },
  /**
   * Cave rock mass as built (review/caveMass.ts, needs the realized pieces). Reference: good community cave builds
   * close the rock behind a face with about 6 overlapping neighbours per piece, so no gap shows through.
   */
  caveMass: {
    weight: 6,
    /** Judge only with this many solid cells / wall cells. */
    minSolid: 30,
    minFaces: 20,
    /** A solid cell counts as covered when this share of its area lies under a rock piece (seen from above). */
    coverFill: 0.55,
    /** Most solid cells that may show no rock from above. */
    uncovered: 0.08,
    /** Most wall length (neighbouring face cells) whose backing pieces neither share nor touch. */
    gaps: 0.25,
    /** Pieces closer than this (tiles) count as touching. */
    touchGap: 0.12,
    /** Most rock tone groups in one cave (a family under minFamilyShare of the pieces is a stray and ignored). */
    families: 1,
    minFamilyShare: 0.03,
    /** Longest run of identical wall pieces (same asset, turn and height) seen from inside. */
    run: 3,
    /** A focal feature with no light source within this many cells is unlit. */
    focalLight: 4,
    /** Weight of the focal_unlit note. */
    focalUnlitWeight: 4,
    /**
     * Generator 4: most solid cells that are hollow seen from the side (a gap of `hole` tiles or more between the foot of
     * the rock and its top: a cap or a course standing over nothing). The grotto v2 build: 26%; v3: 0.5%.
     */
    hollow: 0.08,
    hole: 0.5,
  },
  /**
   * Generator 4: a natural cave reads as one (review/caveWall.ts caveNaturalChecks). The floor is flat when `flatShare`
   * of its dry floor (`minCells` or more) is at one height (grotto v2: 91%, v3 with shelves: 56%); its outline is
   * straight-sided when over `straightShare` of the wall lies in straight runs longer than `run` cells, or one run is
   * longer than `longest` (v2: 46% / 11, v3: 12% / 8).
   */
  caveNatural: {
    weight: 4,
    flatShare: 0.8,
    minCells: 40,
    run: 5,
    straightShare: 0.3,
    longest: 10,
    minEdges: 30,
  },
  /** Cliff checks (rock bands as gen/cliffband.ts builds them; reference values in the comments). */
  cliffs: {
    weight: 6,
    /** Judge only with at least this many edge units / rock pieces. */
    minUnits: 6,
    minPieces: 8,
    /** Share of rise ≥ 2 edge units whose face rock does not hide (gen/cover.ts: width along the edge and height against the rise). */
    unclad: 0.1,
    /** The same for rises of 1–2 tiles: a bare one-tile bank still shows its face (the reference's 40% was measured by footprint). */
    uncladLow: 0.2,
    /** Share of the board's outer edge (ground a tile or more above the base) with no rock hiding the wall. */
    edgeBare: 0.75,
    /** The outer-edge note's score: below any other note, so it only fills a spare slot (the board is tiled beside others). */
    edgeScore: 0.05,
    /** Share of a terrace's walkable ground the rock may stand on (gen/cover.ts terraceRockShare); the band prunes to 0.3. */
    terraceShare: 0.5,
    /** Share of the boulders (or of the face rocks) standing in rows at an even interval (gen/rockSpacing.ts). */
    evenSpacing: 0.25,
    /** Share of faced units with no rock reaching a cell out over the low ground (reference ~3%). */
    sheer: 0.3,
    /** Median band width across a faced unit, cells (reference 5–6). */
    bandWidth: 2,
    /**
     * Share of rise ≥ 2 units with no crest boulder within 1.5 cells. Generator 3 sets boulders as accents in groups
     * with stretches of bare lip where the face rock hides the drop (face to boulder about 2:1), so only a lip with
     * almost none fails.
     */
    noCrest: 0.85,
    /** Share of the band's boundary in straight runs of `straightRun` cells or more (reference 12%). */
    straight: 0.25,
    straightRun: 6,
    /** Share of the commonest piece-and-turn among the rocks (reference ~0.25). */
    repetition: 0.5,
    /** Share of rocks with nothing under them (reference 6%). */
    hanging: 0.1,
    /** Natural level with 3+ levels: share of rises that are exactly 1 tile (reference 3%). */
    timid: 0.6,
    /** Natural map: open cells ÷ its rectangle (reference 0.79). */
    boardFill: 0.95,
  },
  /** Ruins (the building engineer's structureRuinMeasures; reference: tops differ 60% of the time, tall parts ~3×). */
  ruins: {
    weight: 6,
    /** Share of neighbouring wall tops at the same height above which the top reads flat. */
    flatTop: 0.6,
    /** p90 ÷ median wall height below which the decay reads even … */
    contrast: 1.8,
    /** … judged only when the intact walls stood at least this many tiles. */
    minIntact: 6,
    /** A weathered building (generator 3) showing fewer of the five signs than this reads as intact (WEATHER_MINIMUMS.signs). */
    weatherSigns: 3,
    /**
     * Generator 3: a ruin is judged on its cut wall tops only (a part standing whole under its roof is the anchor, not a
     * flat top): runs of equal-height cut columns two cells or shorter must be at least this share (the study's temple
     * 0.67; a clean cut is one long run) …
     */
    runShort: 0.55,
    /** … and a weathered or ruined building in a theme with climbing growth carries at least this many pieces per wall face. */
    growthPerFace: 0.06,
    /** A pitched roof makes at least this share of a cottage's or inn's visible height (the study: 55-65 %). */
    roofShare: 0.4,
    /** Generator 3: share of cut wall tops that are one-cell peaks or pits above which a ruin reads as battlements. */
    teeth: 0.5,
    /** Generator 3: share of level neighbouring cut tops above which a ruin is one level line (slopes and runs are allowed). */
    flatTop3: 0.8,
  },
  substitutions: {
    weight: 4,
  },
  pathEnd: {
    weight: 5,
    /** An end within this many cells of a feature, building, opening, water, another path or the board edge arrives somewhere. */
    reach: 2,
  },
  /**
   * Interiors (generator 4, review/interiors.ts). The study of a community interior the owner admired: 21 props per 10
   * floor tiles, 92% of the furniture within a tile of a wall, a light in every room, no two rooms alike; our dungeon
   * had 1.3, 40%, six rooms in the dark and four identical cells.
   */
  interiors: {
    /** Rooms smaller than this (floor tiles) are closets, not judged. */
    minFloor: 8,
    /** Props (every feature: furniture, small things, lights) per 10 floor tiles below which a room reads bare. */
    bareDensity: 3,
    /** A map is judged for bare rooms when some room is dressed to at least this many props per 10 floor tiles. */
    dressedDensity: 3,
    /** Rooms of one size class, floor material and prop multiset that read as copies of each other. */
    alike: 3,
    /** Size classes of a room, floor tiles (upper bounds; the last is open). */
    sizeClasses: [14, 24, 40],
    /** Furniture (blocking pieces) of a room: at least this many are judged for adrift … */
    adriftMin: 4,
    /** … and under this share of them within a tile of a wall is adrift (the study: 92%). */
    adriftShare: 0.6,
    weights: { bare: 6, alike: 5, unlit: 6.5, adrift: 4 },
    /**
     * Generator 5 (`reviewByKind`): a room is judged by its kind's row of the room-kind table (gen/roomTraits.ts
     * roomTargets). Lenient on purpose: the table's numbers are example ranges from a few training sets.
     *   bare        under this share of the kind's lowest props per 10 tiles, never stricter than `bareDensity` nor
     *               looser than `bareFloor`;
     *   adrift      under the kind's lowest near-wall share (never stricter than `adriftShare`); kinds that lay out
     *               floor groups or station rows are not judged;
     *   carried    a hall with this many floor heights, a column standing in it, or water in it reads full with few
     *               props: not judged bare.
     */
    byKind: { bareShare: 0.5, bareFloor: 1.5, carriedHeights: 3 },
    /** anchor_missing: a room of a furnished kind with none of its anchors (advisory). */
    anchorWeight: 3,
  },
  /**
   * Generator 5: how a complex of rooms is laid out (review/layout.ts, review/layoutNotes.ts; build plan §11.3,
   * technique catalogue Part 4 Q1, Q2, Q4, Q5, Q6). The numbers are one dungeon's [E] examples, set looser than the
   * example and weighted low until a second dungeon confirms them. Every note is advice among options: a plan may keep a
   * long corridor or rooms of one size on purpose.
   */
  layout: {
    /** A level with fewer rooms is not judged as a complex (the generator's number: gen/complexLayout.ts). */
    minRooms: COMPLEX.minRooms,
    /** Areas smaller than this (floor cells) are not judged for a way back. */
    minTrapCells: 4,
    /** corridor_heavy: corridor floor above this share of room and corridor floor (example: 0.25). */
    corridorShare: 0.3,
    /** rooms_same_size: at least this many rooms whose largest is under `sizeRatio` times the median (example: 2). */
    sizeRooms: 6,
    sizeRatio: 1.6,
    /**
     * dead_end_empty: more than this many rooms with one way on and nothing in them (the allowance the generator's bare
     * dead ends stay within: gen/complexLayout.ts, resolve/level/deadEnds.ts).
     */
    emptyDeadEnds: COMPLEX.emptyDeadEnds,
    /** entrances_few: a map of this many rooms or more with at most `entrances` ways in. */
    entrancesRooms: 12,
    entrances: 1,
    weights: { deadEnd: 2.5, sizeMix: 2, corridor: 2, entrances: 2, wayBack: 3.5 },
  },
  /** Market stalls (generator 4, review/stalls.ts). */
  stalls: {
    /** Fewer stalls than this on a level are not judged. */
    minStalls: 3,
    /** stalls_uncovered: at least this many bare tables a covered stall could have been ... */
    minBare: 2,
    /** ... and at least this share of the stalls. */
    bareShare: 0.5,
    /** stalls_grid: this many stalls of one size in one line at one gap (or all of one size) read as a grid. */
    gridRow: 4,
    weights: { uncovered: 3.6, grid: 3.2 },
  },
  /** Floor accents much paler than their room (generator 4, review/floorTone.ts). */
  floorAccent: {
    /** An accent patch of fewer cells than this is not judged ... */
    minCells: 6,
    /** ... nor one covering more than this share of the room (it is the room's floor, not an accent). */
    maxShare: 0.45,
    weight: 3.4,
  },
  /** A hole in an intact roof (review/roofGaps.ts): the score is base plus one point per `cellsPerPoint`, up to `extraMax`. */
  roofGap: { base: 2, cellsPerPoint: 8, extraMax: 2 },
  /**
   * Notes from the quality meter (generator 5, review/qualityNotes.ts; metrics in review/qualityMetrics.ts). Targets
   * from the training builds: a clear lane between a room's doors, a light at every outside door, something above the
   * roofline, contrast between neighbouring facades.
   */
  quality: {
    weights: { lane: 4.5, doors: 3.5, silhouette: 3, facades: 3 },
    /**
     * lane_blocked: a room whose lane is more than this share under the plan's own blocking features, or that has a
     * pair of doors with no free path round them.
     */
    laneShare: 0.1,
    /** doors_unlit: a building with at least this many unlit outside doors. */
    unlitDoors: 2,
    /** silhouette_flat: buildings of this many storeys, or this many footprint cells, want an accent above the roof. */
    silhouetteStoreys: 2,
    silhouetteCells: 40,
    /** An accent volume rises at least this far (tiles) above another volume of the building. */
    accentRise: 1,
    /** facades_alike: this many neighbours (chained within `gap` cells) with equal storeys and one wall style. */
    facadesRow: 3,
    gap: 3,
  },
} as const;

/** The most a measure counts past its threshold when a note is ranked (a note's score is its weight times this). */
export const MAX_OVER = 3;

/** How far past its threshold a measure is, for ranking: value / threshold, at most MAX_OVER. */
export function over(value: number, threshold: number): number {
  return capped(value / Math.max(1e-9, threshold));
}

/** A rank factor capped at MAX_OVER. */
export function capped(factor: number): number {
  return Math.min(MAX_OVER, factor);
}

/**
 * Ground that should read as natural (meandering, irregular) rather than built: the material table's `natural` trait
 * (resolve/materials.ts), so ice counts like snow.
 */
export const NATURAL_MATERIALS: ReadonlySet<string> = new Set(MATERIALS.filter(isNaturalGround));

/** The feature types with a trait of the feature table (gen/catalog.ts), as the review's checks ask them. */
const featuresWith = (test: (f: FeatureInfo) => boolean): ReadonlySet<string> =>
  new Set<string>(typesWith(test));

/** Feature types that are natural growth or rock (they should cluster, never stand in rows): the `natural` trait. */
export const NATURAL_FEATURES = featuresWith((f) => f.natural === true);

/**
 * Rock families by asset name, for the cave tone check (review/caveMass.ts). Names are the catalog's; each family is
 * one material as it reads in game (observed in the owner's cave proofs: Cavern pack walls are the dark brown posts,
 * flowstone the orange layered discs, bg_prop_stalagmite the pale grey stacks, Boulder - Large the pale lump).
 */
export const ROCK_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Cave (Wall|Corner|Rock|Floor)/i, "cavern"],
  [/^bg_(combo|wall|filler)/i, "bellowgloom"],
  [/^burrow_/i, "burrow"],
  [/flowstone/i, "flowstone"],
  [/stalagmite|stalactite/i, "stalagmite"],
  [
    /^Boulder - Large|^rock_large|^rock_mossy|^Moss Rock|^Cliff Face|Cliff \d|Rock - Small|Rubble|Rockpile/i,
    "grey_rock",
  ],
];

/** Families that read as one tone (the first is the group's name). Anything else is its own tone. */
export const ROCK_TONE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [["cavern"]];

/** Features that can be a focal point: the `focusPiece` trait. */
export const FOCAL_FEATURES = featuresWith((f) => f.focusPiece === true);

/** Big landmark pieces: one primary group per map, the rest supporting: the primary `focal` pieces. */
export const PRIMARY_FEATURES = featuresWith((f) => f.focal === "primary");

/** Focal pieces that should have a light near them: the `wantsLight` trait. */
export const LIT_FOCALS = featuresWith((f) => f.wantsLight === true);

/** Build diagnostics summarised as one "pieces substituted" note. */
export const SUBSTITUTION_CODES: ReadonlySet<string> = new Set([
  "custom_unresolved",
  "structure_style_fallback",
  "asset_substituted",
  "verify_material_substituted",
]);

/** Props whose repetition shows (vehicles, statues, landmark-class pieces, signs): the `repeatShows` trait. */
export const REPEAT_WATCH = featuresWith((f) => f.repeatShows === true);

/** Props that belong in the carriageway (parked along its edge), never on the pavement or a crossing: `road`. */
export const ROAD_FEATURES = featuresWith((f) => f.road === true);

/** Growing things, what relieves a built place: the `growth` trait. */
export const GROWTH_FEATURES = featuresWith((f) => f.growth === true);

/** Small ground pieces (rows of them must be longer to count): the `groundSmall` trait. */
export const SMALL_FEATURES = featuresWith((f) => f.groundSmall === true);

/** Pieces that make natural ground read as covered from above: the `cover` trait. */
export const COVER_FEATURES = featuresWith((f) => f.cover === true);
