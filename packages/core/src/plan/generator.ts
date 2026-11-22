import { GENERATOR_VERSIONS, type GeneratorVersion } from "../contracts/plan";

/**
 * What each generator version does (architecture §2.7): one profile of named behaviour switches per version, the one
 * way to gate behaviour on a plan's generator. Code reads the switch, never a version number:
 *
 *   const gen = generatorProfile(plan);            // a plan, a resolved plan, or a placement grid's version
 *   if (gen.coveredStalls) { ...built from parts... }
 *
 * A profile has three kinds of data, each declared once below and built into every version's profile:
 *   - SWITCHES: named booleans, each declared with the generator it starts in and a one-line description;
 *   - TUNINGS: numbers a generator sets, as steps (the value from a generator on);
 *   - VOCABULARY: plan words a generator understands beyond the base set.
 *
 * A switch is on in its first generator and in every later one, by construction, so the SWITCHES table read top to
 * bottom is the changelog of the generators. Generators 1, 2, 3 and 4 are released: what they turn on is frozen, and
 * so is their output (test/golden/generator2, generator3, generator4). New behaviour is a new switch that starts in
 * the open generator, 5 (test/golden/generator5 follows it). A later generator never switches an old behaviour off:
 * it adds a new switch for the new behaviour, and the code reads the new one first. Opening generator 6 (after 5 is
 * released) means adding a version to GENERATOR_VERSIONS (contracts/plan.ts); the compiler then asks for its
 * VOCABULARY entry, and new switches start in 6.
 *
 * Palette roles carry their own first generator (`minGenerator` in the palette data, palette/resolve.ts): palettes
 * are data, generated and user-written, so they name a version rather than a switch. A test keeps the roles of the
 * vocabulary below in step with it (test/unit/plan/generatorProfile.test.ts).
 *
 * Review policy: the design review is advice about the build, not the
 * build, so its output is NOT frozen per generator: a new note may run on an older generator's plan when what it
 * measures is true there. Its advice must hold for the plan's own generator: a note whose action relies on newer
 * behaviour ("name the room and the generator dresses it") is gated on that behaviour's switch or words its action by
 * it (review/interiors.ts room_bare and room_unlit, review/review.ts opening_hidden).
 */

/** One switch: the generator it starts in, and what it does (the sentence says what is on from that generator). */
interface SwitchDeclaration {
  readonly since: GeneratorVersion;
  readonly description: string;
}

const on = (since: GeneratorVersion, description: string): SwitchDeclaration => ({ since, description });

/** Every behaviour switch, grouped by the generator it starts in. The names are what call sites read. */
const SWITCHES = {
  // ── generator 2 (released in 0.1.2) ──
  underHeightField: on(
    2,
    "An under-layer `height` op sets the height of every cell in its shape, rock included (areas opened later inherit it).",
  ),
  naturalThemeWalls: on(
    2,
    "An area in a theme whose wall style is natural rock gets rock walls, not the built wall.",
  ),
  roads: on(2, "Roads: sidewalks and crossings, pavements and frontages, vehicles parked in the kerb lane."),
  naturalPaths: on(
    2,
    'Natural paths wind like trails (a style "straight" path does not), with broken kerbs and spurs to what they serve.',
  ),
  riverCourses: on(
    2,
    "A river or brook crosses the map from one board edge to another, off the high ground.",
  ),
  raggedTerrainEdges: on(2, "Height ops and platforms on natural ground get ragged edges by default."),
  ramps: on(2, "Stairs ops can be rock ramps; ramp cells stay clear of dressing."),
  organicBands: on(
    2,
    "The bands of an uneven op wander like an organic outline (no straight or square stair-steps).",
  ),
  scatterKeepsClear: on(2, "Generated dressing keeps off reserved, bridge and step cells."),
  realPieceSizes: on(
    2,
    "The placer knows the rock band's pieces at their real size (no band where a theme has none).",
  ),
  featureLift: on(2, "A placement's `lift` raises the piece."),
  naturalLevelOutline: on(2, "A level of natural ground gets an irregular outline instead of its rectangle."),
  dressWholeLevel: on(2, "A dress op with no area dresses the whole level, region by region."),
  naturalScatter: on(
    2,
    "Natural pieces scatter in drifts and clumps and stand only where the ground carries them.",
  ),
  cliffRockBand: on(2, "Natural cliff runs are recorded and faced by the dressing's rock band."),
  foundation: on(
    2,
    "A level has a foundation under its ground, the outside ground reaches down to it, and the water level is set.",
  ),
  rockWallSkirt: on(
    2,
    "Rock walls reach down to the level's lowest floor, vary in height, turn their blocks and stop under the floor above.",
  ),
  buildings: on(2, "Buildings and enclosures (level.structures)."),
  designReview: on(
    2,
    "The agent runs the design review (and the substitution note) on the plan after each change.",
  ),

  // ── generator 3 (released in 0.2.0) ──
  wanderingChannels: on(
    3,
    "Rifts and rivers stray from the line between their ends (bridges span them square), are recorded as channels, rivers run in reaches.",
  ),
  wildPlatforms: on(
    3,
    "In a natural or cave level a platform is rock with a ragged outline unless the plan asks for worked stone.",
  ),
  roundedRises: on(3, "A gentle rise on natural ground is one rounded mound of fewer, taller steps."),
  roughenedLumps: on(3, "Small lumps and natural rises lose their square corners and get bitten sides."),
  floorOpenings: on(3, "Floor openings look into the level below (rubble heaps, checks on both levels)."),
  explainedLinkRuns: on(
    3,
    "A link that does not fit says how long a run its rise needs and where it would lie.",
  ),
  voidIsBasePlane: on(3, "A void cell's ground is the base plane, not the stale height it kept."),
  realPieceOutlines: on(3, "The placer knows pieces' real outlines and the cells off the board."),
  stallsAndLines: on(3, "Market stalls and lines strung overhead."),
  wallMountSnap: on(
    3,
    "A wall-mounted piece asked for a cell without a wall snaps to the nearest wall face within one cell.",
  ),
  subCellOffsets: on(3, "A placement's sub-cell `offset` shifts the piece (within half a tile)."),
  furnitureOffWalls: on(3, "Blocking furniture set against a wall stands clear of it."),
  spursReachTargets: on(
    3,
    "A trail spur ends exactly at its focal point and at the cell outside a building's door.",
  ),
  defaultCliffBands: on(3, "Natural regions get a default rock band along their rises."),
  waterLevelChecks: on(
    3,
    "Fords are meant to be wet, and water above the board's water plane is reported dry.",
  ),
  buildingVariety: on(
    3,
    "Buildings vary along a street: style overrides, no repeated wall-and-roof pair, varied entrances.",
  ),
  wholeFacades: on(
    3,
    "No blank wall: windows on every long face, corners keep their wall, no chimney on a hip roof.",
  ),
  legibleCondition: on(
    3,
    "Weathered and ruined buildings read from the game camera: growth, ragged holes, stepped ruins, roof valleys.",
  ),
  roofValleys: on(
    3,
    "Roofs that meet merge into valleys, and a chimney is a shorter stack on a breast (ResolvedStructure.valleys).",
  ),
  floorFamilies: on(
    3,
    "A floor is one dominant tile family, a tonally close second only in feathered patches with a cause.",
  ),
  cliffToneRule: on(3, "One rock tone per cliff; loose rock near a cliff follows it."),
  restingCliffBand: on(
    3,
    "Rock band pieces rest on the ground or on rock, plan with their real outline, turn and slide, and hide the face.",
  ),
  turnedFloorTiles: on(3, "A field of 1x2 floor pieces lies both ways round."),
  rockGroundFaces: on(3, "Natural ground shows rock where its face is bare, never earth-coloured fill."),
  boardEdgeExits: on(
    3,
    "A passage that reaches the board edge is an exit: no rock column outside the bounds.",
  ),
  caveRockMass: on(
    3,
    "A cave wall is a mass of rock (gen/cavewall.ts), the wall column only its closing skin.",
  ),
  naturalStanding: on(3, "A natural standing piece (a stalagmite) is never a wall block."),
  supportedParts: on(3, "Set pieces put things on things (parts on a support, toppers on tables)."),
  levelFootprints: on(3, "Dressed furniture stands on one height (no footprint across a step)."),
  waterBody: on(
    3,
    "Water is dressed as one body (sunk boulders, shallows plants, shore rock, stepping stones).",
  ),
  causedGroundCover: on(
    3,
    "Ground cover grows in fewer, denser drifts tied to a cause (damp ground, a camp, a tree).",
  ),
  litLandmarks: on(3, "A landmark is lit: a floor light beside it when none stands near."),
  levelsJudgedTogether: on(3, "The review judges levels joined by links and floor openings as one map."),
  depthInTiles: on(3, "The review counts depth in whole tiles (half-tile lumps are not depth)."),

  // ── generator 4 (released in 0.3.0) ──
  caveOutlines: on(4, "Natural cave chambers and corridors get ragged outlines (resolve/caveOutline.ts)."),
  caveRelief: on(4, "A flat cave floor gets shelves (resolve/caveRelief.ts)."),
  roomFloors: on(4, "Each room of a built interior gets a floor of its own and a step above the corridor."),
  accentTops: on(
    4,
    "A platform top much paler than the room's floor takes a closer tone (resolve/interiorFloors.ts accentTop).",
  ),
  lowOpeningRims: on(
    4,
    "A floor opening's rim is low (a collapse none, with debris on its edge; a shaft a kerb; a balcony a railing).",
  ),
  rubbleMounds: on(4, "The rubble under a collapse heaps into a mound."),
  wallFootRubble: on(4, "Rough interiors get rubble at the foot of their walls."),
  roomRecipes: on(
    4,
    "Rooms are dressed and lit from their purpose (gen/rooms4.ts recipes); naming a room is enough.",
  ),
  doorwaysKeepClear: on(4, "A blocking piece keeps one more cell back from a doorway."),
  coveredStalls: on(4, "Covered market stalls built from parts (base, counters, posts, canopy)."),
  roomClassification: on(
    4,
    "Each area is classified once in resolve (purpose, abandoned, finish) for the compiler and the review.",
  ),
  interiorWallTops: on(4, "Built interior walls vary in height (rough tops) and settle beside raised rooms."),
  solidShell: on(
    4,
    "A built interior is carved into a solid mass: cap, skirt and strips (compile/shell.ts).",
  ),
  flushRaisedFloors: on(
    4,
    "A floor raised no more than its own slab abuts its neighbour's slab, with no fill course.",
  ),
  exactWallTops: on(
    4,
    "Wall pieces and posts stop a quarter or half tile short where the edge says (sinking into the slab).",
  ),
  solidCaveRock: on(4, "Cave rock is solid, filled from its foot with no see-through gap."),
  secretDoorPlug: on(4, "A secret door is one removable plug in the wall line, reported to the GM."),
  sharedSmallThings: on(
    4,
    "Small things on surfaces (clutter, goods) share one family table over both roles (gen/surfaces.ts).",
  ),
  everyStepVerified: on(4, "Verify checks every step of a stair run, not only the last."),
  outlineRoomReading: on(
    4,
    "The outline shows how each room was read: its purpose (stated or from its words), abandoned or not.",
  ),
  wallNoteInFaceTheme: on(
    4,
    "Verify's wall-style substitution note asks each wall's own theme, not the level's first theme.",
  ),
  naturalCaveReview: on(
    4,
    "The review measures natural caves (hollow rock mass, flat floors, square outlines).",
  ),
  floorAccentReview: on(4, "The review flags floor accents much paler than their room."),
  closedRoofs: on(4, "Pitched roofs leave no open roof cell; the review measures roof gaps."),
  resolveWithCompilePalettes: on(
    4,
    "The resolver decides from the palettes the plan is compiled with (palette/view.ts resolveView).",
  ),
  openingKindTraits: on(
    4,
    "Opening tests read the opening-kind table's traits (a passage, a window) where they named one kind (gen/openingKinds.ts).",
  ),
  paletteThemeDefaults: on(
    4,
    "A theme's default floors and wall style come from the palette that supplies it, a user theme's included (resolve/themes.ts themeDefaults).",
  ),
  piecesInCellTheme: on(
    4,
    "Piece sizes (a rock band's pieces, the support a small thing rests on) are asked of the anchor cell's theme, the one the piece is built in, not the level's (resolve/level/grid.ts pieceTheme).",
  ),
  reachBlamesPathBlocker: on(
    4,
    "Verify names, for each area the build cuts off, the first blocker on the plan's way to it, and looks for a broken link from the plan's entry level (plan/links.ts entryLevelId), not the first blocker found anywhere or the highest level.",
  ),
  columnsCloseHighestFloor: on(
    4,
    "A rock wall column is a low stretch only where it still stands closed above the highest floor it walls in, not only the lowest (compile/realize/rockWalls.ts).",
  ),
  buildingReach: on(
    4,
    "A building's chimneys and windows keep out of the cells another building reaches (its footprint and the wall ring its walls, eaves and chimneys stand in: resolve/building/faces.ts reachedByOther).",
  ),
  lowMassesOffNeighbours: on(
    4,
    "A drawn building design never puts a lower ground mass (a lean-to, a twin's second mass, an ell's wing) against another building: the design is drawn again (resolve/structure.ts drawDesigns).",
  ),
  partyWallsOutsideTaller: on(
    4,
    "A party wall between two buildings is hosted outside the one whose walls stand higher there (the earlier one on a tie), the wall that closes the edge's full height (resolve/structure.ts afterOpenings).",
  ),
  waysInKeepClear: on(
    4,
    "No generated blocking piece stands in, or reaches with its real outline over, a cell in front of a way in: both sides of a door, archway or gap, and the lane before a stall's front (resolve/level/features.ts FeatureWork.blocksWayIn).",
  ),
  windowsInOneVolume: on(
    4,
    "A ground-storey window stands in the wall of one volume, never across the joint where a lower one (a lean-to) meets it.",
  ),
  quietYardZones: on(
    4,
    "An enclosure with no floor of its own is a plain zone with no walls field, so it raises no no_effect warning about walls the plan never set (resolve/structure.ts addEnclosureYards).",
  ),
  mountsOnBuiltWalls: on(
    4,
    "A room recipe hangs a torch or shelf only on a wall edge a wall piece stands on: not a rock wall on the board's edge when that edge is an exit (PlacementGrid.wallBuilt).",
  ),
  edgePiecesByBox: on(
    4,
    "A half-cell edge piece whose origin is not its box's min corner (palette geom boundsCenter: the palisade gate) is placed by its box, so it stands on the fence's half cell on any side (compile/realize/edges.ts placeEdgePiece).",
  ),
  gatesTiled: on(
    4,
    "An enclosure's gateway is filled with the longest gate pieces that fit, end to end, as a wide door is; a span no piece fits stays open with a note that says so (compile/realize/structures/enclosures.ts).",
  ),
  channelFloorWhole: on(
    4,
    "A chasm's part-way shelves never split its floor (lava, water, the pit) into pieces that touch only at a corner: a rift or river stays one edge-connected body at its narrowest (resolve/level/chasms.ts wholeFloorShelves).",
  ),
  lightsOffLandmarks: on(
    4,
    "The floor light that lights a landmark stands clear of the landmark's real outline (a tree's crown is wider than its footprint), never inside it (gen/setpieces.ts lightLandmarks).",
  ),
  ceilingOverRooms: on(
    4,
    "A room recipe's things lifted onto furniture or a shelf stay under the floor of the level above (gen/rooms4.ts underCeiling, PlacementGrid.headroom).",
  ),
  linesClearPorches: on(
    4,
    "An overhead line hangs no lantern or flag over a building's roofed porch (it would hang into the porch roof); the rope still runs to the wall (resolve/level/market.ts stepLine).",
  ),
  marketFurnitureOffWalls: on(
    4,
    "The market's blocking pieces set against a wall (a trade's barrel or crate outside its door) stand clear of it, as other generated furniture does (resolve/level/features.ts offWalls).",
  ),
  pasteBesideMap: on(
    4,
    "A build of more than one chunk is pasted from bare ground beside the map: the shared box is padded so its centre (the paste anchor) is the middle of a cell south of the map's south edge, with clear cells between them (compile/chunk.ts besideMapBox).",
  ),

  // ── generator 5 (open) ──
  arrangements: on(
    5,
    "Arrangement instances a resolve stage attaches (ResolvedLevel.arrangements: palette pieces composed by the arrange/ operators) are built, one element each (compile/realize/arrangements.ts).",
  ),
  layeredProps: on(
    5,
    "Props of different elements may overlap (layered dressing pastes whole in game): verify warns only when two pieces of blocking furniture stand in one spot, reports other overlaps as info, and no longer says TaleSpire drops them.",
  ),
  jambPosts: on(
    5,
    "Detail recipe: a slender post at each jamb of a door or window on a seen wall, storey high, in the wall style's own post (resolve/recipes/walls.ts).",
  ),
  cornerPosts: on(
    5,
    "Detail recipe: a slender post standing at each outer corner of a seen wall, where the theme has one (resolve/recipes/walls.ts).",
  ),
  bandCourses: on(
    5,
    "Detail recipe: a band course along a building's outside floor lines (every one, or the first floor's), a thin beam of the theme or a floor slab of the trim's material showing (resolve/recipes/walls.ts).",
  ),
  plinths: on(
    5,
    "Detail recipe: a low course where a seen wall meets the ground with no footing of its own, past windows and broken by doors (resolve/recipes/walls.ts).",
  ),
  pilasters: on(
    5,
    "Detail recipe: pilasters on seen blank wall runs longer than 4 tiles, at the joints of bays phase-locked to the openings (resolve/recipes/walls.ts).",
  ),
  layeredGround: on(
    5,
    "Detail recipe: layered ground cover, flat pieces overlapping at free turns and low ones sunk, gathered where the ground meets something, by what the place is (resolve/recipes/ground.ts).",
  ),
  qualityNotes: on(
    5,
    "The review advises from the quality meter where plan words can act: a blocked lane between a room's doors, unlit outside doors, a flat roofline, alike facades in a row (review/qualityNotes.ts).",
  ),
  roomKinds: on(
    5,
    "A room's words name a finer kind (shop, stable, lounge, classroom, command, ward; a parlour is a lounge, a dormitory a barracks), furnished from its row of the room-kind table (gen/roomTraits.ts) and written as the purpose that hosts it.",
  ),
  companionGroups: on(
    5,
    "A room's anchor comes with its companions (a bed's nightstand and chest, a counter's stools and back store, a desk's chair), placed by the room-kind table's rule (facing the door, at a window, free-standing, on the axis) with the way from the door kept clear; a rug lies under the group; a room down to 3 floor tiles gets its minimum set (gen/rooms4/groups.ts).",
  ),
  exactWayInReach: on(
    5,
    "A generated blocking piece set square where it stands is kept out of a doorway by its real outline there, not by its outline turned any way, so furniture in a small room may stand beside its door (resolve/level/features.ts blocksWayIn).",
  ),
  occupancyLights: on(
    5,
    "A room is lit by who uses it: a light on each table, desk and nightstand, a light either side of a shared room's main door, lights per 10 floor tiles from the room-kind table, at least one in every lived-in room down to 3 tiles, a corridor one per 8 tiles of its length (gen/rooms4/occupancy.ts).",
  ),
  reviewByKind: on(
    5,
    "The review judges a room by its kind's row of the room-kind table (gen/roomTraits.ts roomTargets): bare below half its props per 10 tiles, adrift below its near-wall share (floor-group and station-row kinds not judged), a hall carried by columns, level changes or water is not bare; a room with none of its kind's anchors gets anchor_missing (review/interiors.ts).",
  ),
  deadEndReview: on(
    5,
    "The review notes rooms with one way on and nothing in them, when more than one (dead_end_empty, review/layoutNotes.ts).",
  ),
  roomSizeReview: on(
    5,
    "The review notes a complex whose rooms are all near one size (rooms_same_size, review/layoutNotes.ts).",
  ),
  corridorShareReview: on(
    5,
    "The review notes a complex whose corridors take a large share of its floor (corridor_heavy, review/layoutNotes.ts).",
  ),
  entrancesReview: on(
    5,
    "The review notes a large complex with a single way in (entrances_few, review/layoutNotes.ts).",
  ),
  wayBackReview: on(
    5,
    "The review notes an area the party reaches by a one-way drop with no walk back (drop_trap_dead, review/layoutNotes.ts).",
  ),
  waterUnderFloors: on(
    5,
    "A level's water surface and range stay a quarter tile under the dry floors of other levels inside its water's footprint (a ship's hold in the harbour), and a water_level warning names a floor the lowest sensible water would still flood (resolve/level/waterSurface.ts capWaterUnderOtherFloors).",
  ),
  wallFootGrowth: on(
    5,
    "Detail recipe: growth at the foot of a worn, ramshackle or ruined building's walls with no door, more away from its doors and least on its street face (resolve/recipes/condition.ts).",
  ),
  breachRubble: on(
    5,
    "Detail recipe: a ruin's rubble graded by distance from each breach, big blocks near the wall, piles further, small stones furthest (resolve/recipes/condition.ts).",
  ),
  guardianPair: on(
    5,
    "Detail recipe: a mirrored guardian pair flanking a sacred or formal building's main door, 1.25-2.5 from its axis (resolve/recipes/threshold.ts).",
  ),
  approachLights: on(
    5,
    "Detail recipe: a mirrored light pair where a sacred or formal building's approach meets the ground, beside the way (resolve/recipes/threshold.ts).",
  ),
  ruinBays: on(
    5,
    "A ruined building is a sound building that lost a few whole bays (about one per 25-35 tiles of long wall): a ragged breach, the roof and upper floors open above it, a notch in the opposite wall, its other walls level, rubble graded from the breach (resolve/building/ruinBays.ts).",
  ),
  roofPatches: on(
    5,
    "A worn or ramshackle building's roof has patches re-laid in a second roof kit (its treatment draws whether and how much; resolve/building/wear.ts, compile/realize/structures/roofs.ts).",
  ),
  porchWear: on(
    5,
    "A worn or ramshackle building's porch may sag one step (0.25) at its outer edge and stand on posts of two kinds; the building's own eave never sags (resolve/building/wear.ts, compile/realize/structures/attachments.ts).",
  ),
} as const satisfies Record<string, SwitchDeclaration>;

/** The name of a behaviour switch: a key of SWITCHES, so a misspelt `profile.name` is a compile error. */
export type SwitchName = keyof typeof SWITCHES;

/** A value a generator sets, from that generator on (until a later step replaces it). */
interface TuningStep<T> {
  readonly since: GeneratorVersion;
  readonly value: T;
}

/** How a ragged floor opening is cut: noise grain and threshold of the rim bites, share kept, lobe threshold. */
export interface OpeningOutlineTuning {
  readonly grain: number;
  readonly cut: number;
  readonly keepShare: number;
  readonly lobeCut: number;
}

/**
 * The detail budget (plan §5): detail pieces per footprint tile by what the tile is (a room or corridor, a built
 * exterior: building footprints, courtyards and bridges, natural ground), and the ceiling of a whole map; a level's own
 * ceiling is ARRANGE_LIMITS.piecesPerLevel. Read by resolve/recipes/budget.ts only.
 */
export interface DetailBudgetTuning {
  readonly interior: number;
  readonly builtExterior: number;
  readonly natural: number;
  readonly perMap: number;
}

/** Numbers a generator sets. Each tuning starts with a step for generator 1; a later step replaces it from there on. */
const TUNINGS = {
  openingOutline: [
    { since: 1, value: { grain: 1.6, cut: 0.3, keepShare: 0.55, lobeCut: 0.74 } },
    // deeper bites at a coarser grain, so the outline reads as broken rather than as a nibbled rectangle
    { since: 4, value: { grain: 2.2, cut: 0.36, keepShare: 0.45, lobeCut: 0.6 } },
  ],
  // (only detail recipes read it, and they start in generator 5)
  detailBudget: [
    {
      since: 1,
      value: { interior: 3, builtExterior: 2, natural: 1.5, perMap: 24000 } satisfies DetailBudgetTuning,
    },
  ],
} as const satisfies Record<string, readonly [TuningStep<unknown>, ...TuningStep<unknown>[]]>;

/**
 * Plan vocabulary a generator adds to what the one before understood: feature types (wherever a plan names one: a
 * feature, a scatter op), level fields and area fields.
 *
 * The rule, the same for every kind: a word used below its generator is refused by validation (plan/validate.ts
 * `checkVocabulary`, an error with code `schema`). That is what the released generator did before the word existed,
 * since its own schema did not know it, so a released generator's plans validate exactly as they did when it shipped.
 * The schema accepts the word for every generator (one schema serves every plan); validation holds each plan to its
 * own generator's words. A new kind of word gets a key here and a check there.
 */
interface VocabularyDeclaration {
  readonly featureTypes: readonly string[];
  readonly levelFields: readonly string[];
  readonly areaFields: readonly string[];
}

const VOCABULARY: Readonly<Record<GeneratorVersion, VocabularyDeclaration>> = {
  1: { featureTypes: [], levelFields: [], areaFields: [] },
  2: { featureTypes: [], levelFields: [], areaFields: [] },
  3: { featureTypes: [], levelFields: [], areaFields: [] },
  4: { featureTypes: ["clutter", "shelf_line"], levelFields: ["roomDress"], areaFields: ["purpose"] },
  5: { featureTypes: [], levelFields: [], areaFields: [] },
};

/** The plan vocabulary one generator understands (what it added and what the generators before it did). */
export interface GeneratorVocabulary {
  readonly featureTypes: ReadonlySet<string>;
  readonly levelFields: ReadonlySet<string>;
  readonly areaFields: ReadonlySet<string>;
}

export type GeneratorProfile = {
  readonly version: GeneratorVersion;
  /** Plan vocabulary this generator understands beyond the base set. */
  readonly vocabulary: GeneratorVocabulary;
} & { readonly [K in SwitchName]: boolean } & {
  readonly [K in keyof typeof TUNINGS]: (typeof TUNINGS)[K][number]["value"];
};

/** What a switch is and when it starts, by name: the table the profiles are built from. */
export const SWITCH_DECLARATIONS: Readonly<Record<SwitchName, SwitchDeclaration>> = SWITCHES;

const SWITCH_NAMES = Object.keys(SWITCHES) as SwitchName[];

function profileFor(version: GeneratorVersion): GeneratorProfile {
  const upTo = GENERATOR_VERSIONS.filter((v) => v <= version);
  const switches = Object.fromEntries(SWITCH_NAMES.map((name) => [name, SWITCHES[name].since <= version]));
  const tunings = Object.fromEntries(
    Object.entries(TUNINGS).map(([name, steps]) => [
      name,
      steps.filter((s) => s.since <= version).reduce((_, s) => s, steps[0]).value,
    ]),
  );
  const words = (key: keyof VocabularyDeclaration): ReadonlySet<string> =>
    new Set(upTo.flatMap((v) => VOCABULARY[v][key]));
  return {
    version,
    ...switches,
    ...tunings,
    vocabulary: {
      featureTypes: words("featureTypes"),
      levelFields: words("levelFields"),
      areaFields: words("areaFields"),
    },
  } as GeneratorProfile;
}

/** Every generator's profile, by version. */
export const GENERATOR_PROFILES: Readonly<Record<GeneratorVersion, GeneratorProfile>> = Object.fromEntries(
  GENERATOR_VERSIONS.map((v) => [v, profileFor(v)]),
) as Record<GeneratorVersion, GeneratorProfile>;

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
 * Validation refuses a word below its generator (see VocabularyDeclaration).
 */
export const VOCABULARY_SINCE: {
  readonly [K in keyof GeneratorVocabulary]: Readonly<Record<string, GeneratorVersion>>;
} = (() => {
  const since = { featureTypes: {}, levelFields: {}, areaFields: {} } as {
    [K in keyof GeneratorVocabulary]: Record<string, GeneratorVersion>;
  };
  for (const v of [...GENERATOR_VERSIONS].reverse())
    for (const kind of Object.keys(since) as Array<keyof GeneratorVocabulary>)
      for (const word of GENERATOR_PROFILES[v].vocabulary[kind]) since[kind][word] = v;
  return since;
})();
