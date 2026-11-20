/**
 * Design review thresholds (data, not code). Each note fires when its measure crosses the threshold; `weight` ranks
 * notes against each other (higher = shown first). Tuned on the team's proof history (docs/decisions.md).
 */
export const REVIEW = {
  /** Notes shown at most (the rest are dropped, lowest rank first). */
  maxNotes: 6,
  /** Levels with fewer walkable cells are not reviewed. */
  minCells: 40,
  flat: {
    weight: 10,
    /** Share of walkable cells on the most common height band (half-tile bands). */
    maxShare: 0.85,
    /** Distinct height bands holding at least `bandShare` of the walkable cells. */
    minBands: 2,
    bandShare: 0.03,
    /** A level with this many buildings takes its depth from them and is not judged flat. */
    buildingsGiveDepth: 3,
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
  /** Cliff checks (docs/internal/cliffs-lessons-reference.md §4; reference values in the comments). */
  cliffs: {
    weight: 6,
    /** Judge only with at least this many edge units / rock pieces. */
    minUnits: 6,
    minPieces: 8,
    /** Share of rise ≥ 2 edge units with no rock over their midpoint (reference 3%). */
    unclad: 0.1,
    /** The same for rises of 1–2 tiles (reference 40%). */
    uncladLow: 0.5,
    /** Share of faced units with no rock reaching a cell out over the low ground (reference ~3%). */
    sheer: 0.3,
    /** Median band width across a faced unit, cells (reference 5–6). */
    bandWidth: 2,
    /** Share of rise ≥ 2 units with no crest boulder within 1.5 cells (reference ~20%). */
    noCrest: 0.4,
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
  },
  substitutions: {
    weight: 4,
  },
  pathEnd: {
    weight: 5,
    /** An end within this many cells of a feature, building, opening, water, another path or the board edge arrives somewhere. */
    reach: 2,
  },
} as const;

/** Ground that should read as natural (meandering, irregular) rather than built. */
export const NATURAL_MATERIALS: ReadonlySet<string> = new Set([
  "grass",
  "dirt",
  "gravel",
  "rock",
  "sand",
  "mud",
  "snow",
  "swamp",
]);

/** Feature types that are natural growth or rock (they should cluster, never stand in rows). */
export const NATURAL_FEATURES: ReadonlySet<string> = new Set([
  "tree",
  "dead_tree",
  "pine_tree",
  "tree_large",
  "bush",
  "rock",
  "boulder",
  "stump",
  "log",
  "mushroom",
  "giant_mushroom",
  "flowers",
  "tall_grass",
  "reeds",
  "stalagmite",
  "crystal",
  "rock_formation",
  "standing_stone",
  "cluster_tall",
  "undergrowth",
  "ground_cover",
  "formation",
]);

/** Features that can be a focal point. */
export const FOCAL_FEATURES: ReadonlySet<string> = new Set([
  "landmark",
  "statue",
  "statue_large",
  "altar",
  "fountain",
  "well",
  "monolith",
  "tree_large",
  "throne",
  "standing_stone",
  "tall_marker",
  "magic_fire",
  "fire_pit",
  "campfire",
  "giant_mushroom",
  "cave_column",
]);

/** Big landmark pieces: one primary group per map, the rest supporting. */
export const PRIMARY_FEATURES: ReadonlySet<string> = new Set([
  "landmark",
  "statue_large",
  "monolith",
  "tree_large",
  "giant_mushroom",
]);

/** Build diagnostics summarised as one "pieces substituted" note. */
export const SUBSTITUTION_CODES: ReadonlySet<string> = new Set([
  "custom_unresolved",
  "structure_style_fallback",
  "asset_substituted",
  "verify_material_substituted",
]);

/** Props whose repetition shows: vehicles, statues, landmark-class pieces, signs and seats. */
export const REPEAT_WATCH: ReadonlySet<string> = new Set([
  "vehicle",
  "cart",
  "wagon",
  "statue",
  "statue_large",
  "landmark",
  "monolith",
  "tree_large",
  "fountain",
  "well",
  "signage",
  "tent",
  "giant_mushroom",
]);

/** Themes whose places may be laid out in mirror symmetry (formal halls, palaces, temples). */
export const FORMAL_THEMES: ReadonlySet<string> = new Set(["castle", "palace", "temple"]);

/** Props that belong in the carriageway (parked along its edge), never on the pavement or a crossing. */
export const ROAD_FEATURES: ReadonlySet<string> = new Set(["vehicle", "cart", "wagon"]);

/** Growing things: what relieves a built place. */
export const GROWTH_FEATURES: ReadonlySet<string> = new Set([
  "tree",
  "dead_tree",
  "pine_tree",
  "tree_large",
  "bush",
  "flowers",
  "tall_grass",
  "reeds",
  "undergrowth",
  "cluster_tall",
  "vines",
]);

/** Small ground pieces: on a dense lattice they line up by chance, so their rows must be longer to count. */
export const SMALL_FEATURES: ReadonlySet<string> = new Set([
  "ground_cover",
  "flowers",
  "mushroom",
  "tall_grass",
  "reeds",
]);

/** Pieces that make natural ground read as covered from above: trees, tall growth, rock formations. */
export const COVER_FEATURES: ReadonlySet<string> = new Set([
  "tree",
  "dead_tree",
  "pine_tree",
  "tree_large",
  "cluster_tall",
  "giant_mushroom",
  "rock_formation",
  "formation",
  "boulder",
  "stalagmite",
  "bush",
]);

/** Rock-band pieces (the dressing's cliff band) the cliff checks measure. */
export const BAND_ROCK: ReadonlySet<string> = new Set(["cliff_face", "cliff_crest"]);
