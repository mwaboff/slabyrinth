/**
 * Composed set pieces (dress presets added 2026-11-19): authored groups of features instead of weighted scatter.
 *
 * A set piece is
 *   - an optional FOCAL group (ritual ring, great tree, rockfall, camp fire), placed once, at the area's centre
 *     or against the wall farthest from the entrances;
 *   - a library of small VIGNETTES (a focal piece, supporting pieces, small detail), anchored to walls, corners
 *     or — only in large areas — to open ground, kept apart so clear ground separates them;
 *   - a LIGHTING pass: a light beside every entrance and along the walls at a set spacing, skipping walls that
 *     already have light nearby, so light pools at entrances and focal points and leaves darker pockets.
 *
 * Playability: blocking pieces never stand within two cells of a door or on a link, never cross a wall, and a
 * vignette is withdrawn when it would cut off any floor cell that was reachable before it.
 *
 * Coordinates inside a group are in a local frame: x runs along the anchor wall, y runs into the room
 * (y = 0 is the cell touching the wall). Open-ground groups use a random quarter turn instead.
 * Deterministic: one seeded PRNG stream, integer arithmetic only.
 */
import type { DressPreset, FeatureType, Rotation, Side } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng, type Prng } from "../util/prng";
import { ValueNoise } from "./noise";
import { dressWater } from "./water";
import { cliffBand, riseUnits, type BandResult } from "./cliffband";
import { featureInfo, LIGHT_FEATURES } from "./catalog";
import {
  footprintCrossesWall,
  type GeneratedPlacement,
  type PlacementGrid,
  type ScatterResult,
} from "./place";

export const COMPOSED_PRESETS = [
  "ritual_circle",
  "overgrown",
  "cavern",
  "collapse",
  "crystal_grotto",
  "campsite",
  "shrine_ruin",
  "bone_pit",
  "mine_works",
  "mushroom_grove",
  "barricade",
  "natural_clusters",
  "woodland",
  "forest",
  "dense_forest",
  "street",
  "alley",
  "plaza",
] as const satisfies readonly DressPreset[];
export type ComposedPreset = (typeof COMPOSED_PRESETS)[number];

export function isComposedPreset(p: DressPreset): p is ComposedPreset {
  return (COMPOSED_PRESETS as readonly string[]).includes(p);
}

/** One piece of a group. `size` is [along, into-room]; default: the catalog size. */
export interface Part {
  t: FeatureType;
  dx: number;
  dy: number;
  size?: readonly [number, number];
  /** Wall-mounted on the anchor wall (needs a wall on that side of its cell). */
  wall?: boolean;
  variant?: string;
  /** The group is only placed when this part fits too (the stones of a ring: a ring with gaps is no ring). */
  required?: boolean;
  /**
   * Generator 3: this small piece rests on the top of the part with this index (goods on a counter, a lantern on a
   * chest, moss on a boulder): same cell, lifted by the support's real top height (PlacementGrid.pieceExtent), slid a
   * little off the centre. It takes no cell of its own and is left out when the support is, or when the theme has no
   * such support piece. Below generator 3 the part stands at its own dx, dy as before.
   */
  on?: number;
  /** Generator 3 only: the part does not exist at earlier generators (their output is frozen). */
  gen3?: boolean;
}

export interface Group {
  name: string;
  /**
   * wall / corner: backed by walls. open: free ground (areas of 150+ cells only). ledge_low: at the foot of a
   * ledge or cliff (the higher ground is behind, x runs along the ledge). ledge_high: on the edge of a drop or
   * chasm (the drop is "behind", so y = 0 is the lip).
   */
  anchor: "wall" | "corner" | "open" | "ledge_low" | "ledge_high" | "water_edge" | "path_edge";
  /** parts[0] is the group's focal piece: the group is placed only if it fits. */
  parts: readonly Part[];
}

export interface SetPieceDef {
  focal?: { place: "center" | "far_wall"; build: (areaCells: number, radius?: number) => Group };
  groups: ReadonlyArray<readonly [Group, number]>;
  /** Floor cells per group at density 1 (groups = round(density × cells / cellsPerGroup)). */
  cellsPerGroup: number;
  /** Wall light used by the lighting pass, and the spacing (Chebyshev) kept between lights. */
  wallLight: FeatureType | null;
  lightSpacing: number;
  /** Open-ground groups in areas of any size (natural presets), not only in areas of 150+ cells. */
  openAnywhere?: boolean;
  /** Share of free open cells that get a ground-cover clump (in noise patches), to break up the floor grid. */
  groundCover?: number;
  /**
   * Canopy cover: target share of free ground (outside paths, entrances and the clearing) under trees, filled in
   * noise patches that thin toward paths and clearings (woodland ≈ grove, forest, dense_forest).
   */
  canopy?: number;
  /** Cells kept clear round the focal landmark (default 2; a small square's statue needs only 1). */
  landmarkApron?: number;
  /** What the canopy pass plants at each tree (default: a tree with undergrowth and ground cover at its foot). */
  canopyGroup?: Group;
  /**
   * Built places follow order, natural ones do not. "irregular" (default): line-following groups jitter, gaps never
   * repeat and upright pieces never stand in single file. "regular": the preset asks for a rhythm (street lamps
   * evenly spaced along a kerb), so those rules are off for its rows and line groups.
   */
  lineRhythm?: "regular" | "irregular";
  /**
   * Clad every cliff lip and foot: no stretch of a ledge longer than four cells is left bare (rocks and growth on
   * the lip, rock piles and shrubs at the foot), so a long face never shows its tiles for its whole length.
   */
  cladLedges?: boolean;
  /** Smallest rise (tiles) the rock band faces (default 1). */
  bandMinRise?: number;
  /**
   * The def that lays the rock band itself (the level-wide band pass, `defaultCliffBands`) and nothing else. From
   * generator 3 the band is laid once for the whole level before any dressing (so no zone's trees or props block a
   * face that crosses into the next zone), and the presets above only grow what follows the rock.
   */
  bandOnly?: boolean;
  /** Built places: one small pocket of green (a tree, shrubs) on a pavement corner at a junction. */
  junctionGreen?: boolean;
  /**
   * Rows along the edge of a path that runs through or beside the area (a road): "kerb" = on the pavement cells
   * next to the path, facing it; "lane" = on the path cells next to the pavement (a parking lane). regular: one
   * piece every `spacing` cells from a seeded phase (a shifted cell when one is taken), `between` halfway between
   * two of them; irregular: varied gaps of `spacing` ± half. Doors, crossings and entrances stay clear.
   */
  rows?: ReadonlyArray<KerbRow>;
}

export interface KerbRow {
  type: FeatureType;
  line: "kerb" | "lane";
  spacing: number;
  rhythm: "regular" | "irregular";
  /** Footprint along the line × away from it (a parked car 3×2). */
  size?: readonly [number, number];
  /** Halfway between two regular pieces (bins between lamps), placed with probability `betweenChance`. */
  between?: FeatureType;
  betweenChance?: number;
  /**
   * Instead of `between`, where the pavement is at least `tallDepth` cells deep from the kerb: a tall piece (a street
   * tree between the lamps on a wide pavement).
   */
  betweenTall?: FeatureType;
  tallDepth?: number;
  /** At most one piece per this many candidate cells (parked vehicles: one per 12 cells of kerb lane). */
  capPer?: number;
}

/**
 * Theme-neutral composition: natural dressing in a group is written as a SLOT, and each theme's palette says what
 * fills it (`feature.cluster_tall` is stalagmite columns in a cave, pines in a forest, stone columns in a dungeon).
 * Groups may still name a cave piece for readability; it is mapped to its slot here, so the same set piece works
 * in every theme. Semantic objects (trees, roots, rubble, bones, candles, furniture) keep their own types.
 */
export const NEUTRAL_SLOT: Partial<Record<FeatureType, FeatureType>> = {
  stalagmite: "cluster_tall",
  cave_column: "cluster_tall",
  crystal: "accent_light",
  giant_mushroom: "undergrowth",
  mushroom: "ground_cover",
  stalactite: "small_detail",
  rock_formation: "formation",
};

const p = (t: FeatureType, dx: number, dy: number, more: Omit<Part, "t" | "dx" | "dy"> = {}): Part => {
  const slot = NEUTRAL_SLOT[t];
  if (slot === undefined) return { t, dx, dy, ...more };
  // a cave-specific variant name means nothing to the slot: dropped
  const rest: Omit<Part, "t" | "dx" | "dy"> = { ...more };
  delete rest.variant;
  return { t: slot, dx, dy, ...rest };
};

// ───────────────────────────── group library ─────────────────────────────

const G = {
  stalagmiteCluster: {
    name: "stalagmite cluster",
    anchor: "corner",
    parts: [
      p("rock_formation", 0, 0),
      p("stalagmite", 2, 0),
      p("stalagmite", 2, 1),
      p("stalagmite", 0, 2),
      p("rock", 3, 0),
      p("stalactite", 1, 2),
      p("debris", 3, 2),
    ],
  },
  stalagmiteWall: {
    name: "stalagmites along the wall",
    anchor: "wall",
    parts: [
      p("stalagmite", 0, 0),
      p("stalagmite", 1, 0),
      p("rock", 2, 0),
      p("stalagmite", -1, 1),
      p("stalactite", 1, 1),
      p("debris", 0, 2),
    ],
  },
  crystalNook: {
    name: "crystal nook",
    anchor: "corner",
    parts: [p("crystal", 0, 0), p("crystal", 1, 0), p("crystal", 0, 1), p("rock", 2, 0), p("debris", 1, 1)],
  },
  crystalVein: {
    name: "crystal vein",
    anchor: "wall",
    parts: [
      p("crystal", 0, 0),
      p("crystal", 2, 0),
      p("stalagmite", 1, 0),
      p("crystal", 1, 1),
      p("debris", 3, 1),
    ],
  },
  mushroomPatch: {
    name: "mushroom grove",
    anchor: "wall",
    parts: [
      p("giant_mushroom", 0, 0),
      p("mushroom", 1, 0),
      p("giant_mushroom", 2, 0),
      p("mushroom", 1, 1),
      p("mushroom", -1, 1),
      p("root", 2, 1),
    ],
  },
  rubbleSpill: {
    name: "rubble spill",
    anchor: "wall",
    parts: [
      p("cave_in", 0, 0),
      p("rubble", 2, 0),
      p("rubble", 0, 2),
      p("debris", 2, 2),
      p("debris", 3, 1),
      p("debris", 1, 3),
    ],
  },
  boulderIsland: {
    name: "boulder cover",
    anchor: "open",
    // generator 3: a tuft or cap on the boulder's top
    parts: [
      p("boulder", 0, 0),
      p("rock", 1, 0),
      p("stalagmite", 0, 1),
      p("debris", 1, 1),
      p("small_detail", 0, 0, { on: 0, gen3: true }),
    ],
  },
  bonesNook: {
    name: "bones in a corner",
    anchor: "corner",
    parts: [p("bones", 0, 0), p("skull_pile", 1, 0), p("rock", 0, 1), p("web", 1, 1)],
  },
  rootBurst: {
    name: "roots through the wall",
    anchor: "wall",
    parts: [
      p("roots_wall", 0, 0, { wall: true }),
      p("root", 0, 1),
      p("vines", 1, 0, { wall: true }),
      p("root", 1, 2),
      p("root", -1, 2),
      p("mushroom", -1, 0),
    ],
  },
  rootTangle: {
    name: "root tangle",
    anchor: "corner",
    parts: [
      p("root_large", 0, 1),
      p("roots_wall", 0, 0, { wall: true }),
      p("vines", 1, 0, { wall: true }),
      p("root", 2, 1),
      p("giant_mushroom", 0, 2),
      p("mushroom", 1, 2),
    ],
  },
  fallenLog: {
    name: "fallen log",
    anchor: "wall",
    parts: [p("log", 0, 1), p("mushroom", 2, 1), p("root", 0, 2), p("stump", -1, 0), p("mushroom", 1, 0)],
  },
  vineWall: {
    name: "hanging vines",
    anchor: "wall",
    parts: [
      p("vines", 0, 0, { wall: true }),
      p("roots_wall", 1, 0, { wall: true }),
      p("vines", 2, 0, { wall: true }),
      p("root", 1, 1),
    ],
  },
  stumpIsland: {
    name: "old stump",
    anchor: "open",
    parts: [p("stump", 0, 0), p("mushroom", 1, 0), p("root", 0, 1), p("root", -1, 0)],
  },
  offerings: {
    name: "offerings",
    anchor: "wall",
    parts: [p("skull_pile", 0, 0), p("candles", 1, 0), p("candles", -1, 0), p("bones", 0, 1)],
  },
  standingPair: {
    name: "standing stones",
    anchor: "wall",
    parts: [p("standing_stone", 0, 1), p("candles", 1, 1), p("standing_stone", 2, 1), p("skull_pile", 1, 0)],
  },
  boneHeap: {
    name: "bone heap",
    anchor: "corner",
    parts: [p("bones", 0, 0), p("skull_pile", 1, 0), p("skull_pile", 0, 1), p("rubble", 1, 1)],
  },
  supplies: {
    name: "stacked supplies",
    anchor: "corner",
    parts: [p("crate", 0, 0), p("crate", 1, 0), p("barrel", 0, 1), p("sack", 1, 1), p("barrel", 2, 0)],
  },
  sleepingSpot: {
    name: "sleeping spot",
    anchor: "wall",
    // generator 3: the lantern stands on the chest, and a candle stub beside it
    parts: [
      p("sack", 0, 0),
      p("chest", 1, 0),
      p("lantern", 2, 0, { on: 1 }),
      p("sack", 0, 1),
      p("candles", 1, 0, { on: 1, gen3: true }),
    ],
  },
  woodpile: {
    name: "woodpile",
    anchor: "wall",
    parts: [p("log", 0, 0, { variant: "pile" }), p("stump", 2, 0), p("crate", 2, 1)],
  },
  // ── round 2: tall pieces and skyline ──
  columnCluster: {
    name: "rock columns",
    anchor: "corner",
    parts: [
      p("cave_column", 0, 0),
      p("stalagmite", 1, 0),
      p("cave_column", 0, 2),
      p("stalagmite", 1, 1),
      p("rock", 2, 0),
      p("stalactite", 2, 2),
      p("debris", 1, 3),
    ],
  },
  monolithPair: {
    name: "monoliths",
    anchor: "wall",
    parts: [
      p("monolith", 0, 1),
      p("monolith", 2, 1),
      p("candles", 1, 1),
      p("skull_pile", 1, 0),
      p("debris", 3, 2),
    ],
  },
  brokenColumns: {
    name: "broken columns",
    anchor: "wall",
    parts: [
      p("pillar", 0, 0, { variant: "ruined" }),
      p("rubble", 1, 0),
      p("pillar", 2, 1, { variant: "ruined" }),
      p("debris", 1, 2),
      p("debris", 3, 0),
    ],
  },
  statueAlcove: {
    name: "statue alcove",
    anchor: "wall",
    parts: [
      p("statue_large", 0, 0),
      p("brazier", -1, 1),
      p("brazier", 2, 1),
      p("candles", 2, 0),
      p("candles", -1, 0),
    ],
  },
  // ── ledges: scree at the foot of a cliff, roots and stones on a lip ──
  scree: {
    name: "scree at the cliff foot",
    anchor: "ledge_low",
    parts: [
      p("rubble", 0, 0),
      p("boulder", 1, 0),
      p("debris", -1, 0),
      p("rock", 0, 1),
      p("debris", 1, 1),
      p("debris", 2, 2),
      p("small_detail", 1, 0, { on: 1, gen3: true }),
    ],
  },
  rootSpill: {
    name: "roots over the edge",
    anchor: "ledge_high",
    parts: [p("root", 0, 0), p("root", 1, 0), p("root_large", -2, 1), p("mushroom", 0, 1), p("root", 2, 1)],
  },
  lipStones: {
    name: "stones on the lip",
    anchor: "ledge_high",
    parts: [p("rock", 0, 0), p("stalagmite", 2, 0), p("debris", 1, 0), p("debris", 1, 1)],
  },
  // ── bone pit, mining, mushrooms, barricades ──
  hangingCage: {
    name: "hanging cage",
    anchor: "wall",
    parts: [
      p("cage", 0, 0, { variant: "hanging" }),
      p("chains", 1, 0, { wall: true }),
      p("bones", 0, 2),
      p("skull_pile", 1, 2),
    ],
  },
  webCorner: {
    name: "webbed corner",
    anchor: "corner",
    parts: [p("web", 0, 0, { variant: "large" }), p("bones", 1, 0), p("skull_pile", 0, 1), p("web", 2, 1)],
  },
  chainWall: {
    name: "chained wall",
    anchor: "wall",
    parts: [
      p("chains", 0, 0, { wall: true }),
      p("chains", 2, 0, { wall: true }),
      p("bones", 1, 0),
      p("skull_pile", 1, 1),
    ],
  },
  mineFace: {
    name: "timbered mine face",
    anchor: "wall",
    parts: [
      p("mine_support", 0, 0),
      p("mine_support", 3, 0),
      p("rubble", 1, 0),
      p("crystal", 2, 0),
      p("lantern", 1, 1),
      p("debris", 2, 1),
    ],
  },
  cartLine: {
    name: "cart on rails",
    anchor: "wall",
    parts: [
      p("mine_cart", 0, 1),
      p("rails", 1, 1),
      p("rails", 2, 1),
      p("rails", 3, 1),
      p("rails", -1, 1),
      p("barrel", 0, 0),
      p("crate", 4, 0),
    ],
  },
  orePile: {
    name: "ore pile",
    anchor: "corner",
    parts: [p("rubble", 0, 0), p("crystal", 1, 0), p("barrel", 0, 1), p("sack", 1, 1), p("debris", 2, 0)],
  },
  glowcaps: {
    name: "glowcap ring",
    anchor: "open",
    parts: [
      p("giant_mushroom", 0, 0),
      p("giant_mushroom", 2, 1),
      p("crystal", 1, 0),
      p("mushroom", 1, 1),
      p("mushroom", 0, 2),
      p("root", -1, 1),
    ],
  },
  barricadeLine: {
    name: "barricade",
    anchor: "open",
    parts: [
      p("crate", 0, 0),
      p("barrel", 1, 0),
      p("log", 3, 0),
      p("crate", -2, 0),
      p("sack", -3, 0),
      p("torch_floor", 1, 1),
    ],
  },
  // ── theme-neutral natural groups (slots): the same pattern is a stalagmite stand in a cave, a stand of
  //    pines over ferns in a forest, a colonnade in a dungeon ──
  tallStand: {
    name: "tall stand",
    anchor: "corner",
    parts: [
      p("cluster_tall", 0, 0),
      p("cluster_tall", 1, 0),
      p("cluster_tall", 0, 1),
      p("cluster_tall", 2, 1),
      p("cluster_tall", 1, 2),
      p("undergrowth", 1, 1),
      p("undergrowth", 2, 0),
      p("undergrowth", 0, 2),
      p("ground_cover", 2, 2),
      p("ground_cover", 3, 1),
      p("small_detail", 3, 0),
    ],
  },
  grove: {
    name: "grove",
    anchor: "open",
    parts: [
      p("cluster_tall", 0, 0),
      p("cluster_tall", 1, 1),
      p("cluster_tall", -1, 1),
      p("cluster_tall", 0, 2),
      p("cluster_tall", 2, 0),
      p("cluster_tall", 2, 2),
      p("cluster_tall", -2, 0),
      p("cluster_tall", 1, 3),
      p("cluster_tall", -1, 3),
      p("undergrowth", -2, 1),
      p("undergrowth", 3, 1),
      p("undergrowth", 1, 0),
      p("undergrowth", 0, 1),
      p("undergrowth", -1, 2),
      p("undergrowth", 2, 2),
      p("ground_cover", 1, 2),
      p("ground_cover", -1, 0),
      p("small_detail", 3, 1),
    ],
  },
  thicket: {
    name: "thicket",
    anchor: "wall",
    parts: [
      p("undergrowth", 0, 0),
      p("undergrowth", 1, 0),
      p("cluster_tall", 2, 0),
      p("undergrowth", 0, 1),
      p("undergrowth", 3, 1),
      p("ground_cover", 1, 1),
      p("ground_cover", 2, 2),
      p("small_detail", 0, 2),
    ],
  },
  formationPile: {
    name: "rock formation",
    anchor: "wall",
    parts: [
      p("formation", 0, 0),
      p("formation", 1, 1),
      p("edge_dressing", 2, 0),
      p("edge_dressing", -1, 1),
      p("undergrowth", 0, 1),
      p("undergrowth", 2, 2),
      p("small_detail", 3, 1),
      p("small_detail", 0, 3),
    ],
  },
  boulderField: {
    name: "boulder field",
    anchor: "open",
    parts: [
      p("formation", 0, 0),
      p("edge_dressing", 2, 0),
      p("formation", -1, 1),
      p("undergrowth", 1, 1),
      p("cluster_tall", 2, 2),
      p("small_detail", -1, 0),
      p("ground_cover", 1, 3),
    ],
  },
  edgeDress: {
    name: "dressed edge",
    anchor: "ledge_high",
    parts: [
      p("formation", 0, 0),
      p("formation", 2, 0),
      p("edge_dressing", 1, 1),
      p("formation", 4, 0),
      p("undergrowth", 3, 1),
      p("edge_dressing", -1, 0),
      p("ground_cover", 0, 2),
      p("small_detail", 2, 2),
    ],
  },
  cliffFoot: {
    name: "cliff foot",
    anchor: "ledge_low",
    parts: [
      p("formation", 0, 0),
      p("formation", 1, 1),
      p("formation", 3, 0),
      p("edge_dressing", 2, 2),
      p("edge_dressing", -1, 0),
      p("undergrowth", -1, 1),
      p("small_detail", 1, 3),
      p("small_detail", 4, 2),
    ],
  },
  // ── water's edge: reeds, lily pads, stones and driftwood along a bank (the side faces the water) ──
  bank: {
    name: "river bank",
    anchor: "water_edge",
    parts: [
      p("bank_dressing", 0, 0),
      p("bank_dressing", 1, 0),
      p("edge_dressing", 2, 0),
      p("bank_dressing", 3, 0),
      p("undergrowth", 1, 1),
      p("small_detail", 2, 1),
    ],
  },
  // ── path verges: tufts, pebbles and stones so a path sits in the ground ──
  verge: {
    name: "path verge",
    anchor: "path_edge",
    parts: [
      p("ground_cover", 0, 0),
      p("small_detail", 1, 0),
      p("ground_cover", 2, 0),
      p("edge_dressing", 3, 1),
      p("small_detail", 4, 0),
    ],
  },
  rockPile: {
    name: "rock pile",
    anchor: "open",
    parts: [
      p("formation", 0, 0),
      p("formation", 1, 1),
      p("edge_dressing", 2, 0),
      p("edge_dressing", -1, 1),
      p("small_detail", 0, 2),
      p("small_detail", 2, 2),
    ],
  },
  wallDress: {
    name: "dressed wall",
    anchor: "wall",
    parts: [
      p("wall_dressing", 0, 0, { wall: true }),
      p("undergrowth", 1, 0),
      p("wall_dressing", 2, 0, { wall: true }),
      p("ground_cover", 0, 1),
      p("small_detail", 2, 1),
    ],
  },
  accentNook: {
    name: "lit nook",
    anchor: "corner",
    parts: [
      p("accent_light", 0, 0),
      p("undergrowth", 1, 0),
      p("small_detail", 0, 1),
      p("ground_cover", 1, 1),
    ],
  },
} satisfies Record<string, Group>;

/** Natural focal: a landmark (great tree, statue, rock spire…) with a stand of tall growth round it. */
// ── built places (city street, 2026-11-20): the same slots in a medieval lane, a modern street, a concourse ──
const BUILT = {
  // a shopfront: a sign on the wall, goods or a bin by the door, a little litter
  frontage: {
    name: "shopfront",
    anchor: "wall",
    parts: [
      p("signage", 0, 0, { wall: true }),
      p("crate", 1, 0),
      p("barrel", -1, 0),
      p("small_detail", 2, 1),
    ],
  },
  // seating at the kerb with a bin beside it
  kerbSeat: {
    name: "kerb seating",
    anchor: "path_edge",
    parts: [p("seating", 0, 1), p("edge_dressing", 2, 1), p("ground_cover", -1, 1)],
  },
  // a signpost at the kerb
  kerbSign: {
    name: "kerb sign",
    anchor: "path_edge",
    parts: [p("signpost", 0, 0), p("small_detail", 1, 1)],
  },
  // alley: a large bin against the wall, bags and boxes heaped beside it, rubbish on the ground
  binBay: {
    name: "bin bay",
    anchor: "wall",
    parts: [
      p("edge_dressing", 0, 0, { variant: "large", size: [2, 1] }),
      p("sack", 2, 0),
      p("sack", 2, 1),
      p("crate", -1, 0),
      p("ground_cover", 0, 1),
      p("small_detail", 1, 1),
    ],
  },
  // alley: units, pipes and signs on the walls, crates stacked below
  wallClutter: {
    name: "wall clutter",
    anchor: "wall",
    parts: [
      p("wall_dressing", 0, 0, { wall: true }),
      p("wall_dressing", 3, 0, { wall: true }),
      p("crate", 1, 0),
      p("crate", 1, 1),
      p("barrel", 4, 0),
    ],
  },
  litter: {
    name: "litter",
    anchor: "open",
    parts: [p("ground_cover", 0, 0), p("ground_cover", 1, 1), p("small_detail", 2, 0)],
  },
  // plaza: a street tree with a bench in its shade and shrubs at its foot
  treeSeat: {
    name: "tree and seat",
    anchor: "open",
    parts: [p("cluster_tall", 0, 0), p("seating", 0, 2), p("undergrowth", 1, 0), p("undergrowth", -1, 1)],
  },
  flowerBed: {
    name: "flower bed",
    anchor: "open",
    parts: [p("undergrowth", 0, 0), p("undergrowth", 1, 0), p("undergrowth", 0, 1), p("ground_cover", 1, 1)],
  },
} satisfies Record<string, Group>;

/** A square's centre: a landmark, seating facing it, lamps at the corners of its paving. */
function plazaCentre(): Group {
  return {
    name: "plaza centre",
    anchor: "open",
    parts: [
      p("landmark", 0, 0, { size: [2, 2] }),
      p("seating", -4, 0),
      p("seating", 3, 0),
      p("lantern", -2, -2),
      p("lantern", 3, -2),
      p("lantern", -2, 3),
      p("lantern", 3, 3),
    ],
  };
}

function landmarkStand(): Group {
  return {
    name: "landmark",
    anchor: "wall",
    parts: [
      p("landmark", -1, 0),
      p("cluster_tall", -2, 0),
      p("cluster_tall", 1, 0),
      p("cluster_tall", -3, 1),
      p("cluster_tall", 2, 1),
      p("undergrowth", -2, 1),
      p("undergrowth", 1, 1),
      p("undergrowth", -1, 2),
      p("ground_cover", 0, 2),
      p("formation", 3, 0),
      p("accent_light", -3, 2),
      p("small_detail", 1, 3),
      p("ground_cover", -2, 3),
    ],
  };
}

// ───────────────────────────── focal groups ─────────────────────────────

/** Ritual circle: a ring of standing stones (gaps between them) round a glowing centre and the spawn point. */
/**
 * Ring stones on cells, as round as the grid allows (from a phase search over equal angles, checked by the
 * ring-geometry test: radius spread under 6 %, every gap within 12° of 360°/N, no two stones touching).
 */
export const RING_TABLES: Readonly<Record<number, ReadonlyArray<readonly [number, number]>>> = {
  2: [
    [0, -2],
    [2, -1],
    [2, 1],
    [0, 2],
    [-2, 1],
    [-2, -1],
  ],
  3: [
    [1, -3],
    [3, -1],
    [3, 1],
    [1, 3],
    [-1, 3],
    [-3, 1],
    [-3, -1],
    [-1, -3],
  ],
  4: [
    [0, -4],
    [3, -3],
    [4, -1],
    [3, 2],
    [1, 4],
    [-1, 4],
    [-3, 2],
    [-4, -1],
    [-3, -3],
  ],
  5: [
    [3, -4],
    [5, -2],
    [5, 2],
    [3, 4],
    [-1, 5],
    [-4, 3],
    [-5, 0],
    [-4, -3],
    [-1, -5],
  ],
};

function ritualRing(areaCells: number, radius?: number): Group {
  // radius: from the top tier of a dais when there is one, else from the area's size
  const r = Math.max(2, Math.min(5, radius ?? (areaCells >= 300 ? 4 : areaCells >= 90 ? 3 : 2)));
  const ring = RING_TABLES[r] ?? [];
  // candles in every other gap, pulled a little inside the ring; the centre stays clear round the fire
  const candles: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i += 2) {
    const [ax, ay] = ring[i] as readonly [number, number];
    const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
    // a small ring has no room inside: its candles stand in the gap itself, or just outside it
    for (const k of [0.75, 1, 1.3]) {
      const c: [number, number] = [Math.round(((ax + bx) / 2) * k), Math.round(((ay + by) / 2) * k)];
      const clash =
        ring.some(([x, y]) => x === c[0] && y === c[1]) ||
        (Math.abs(c[0]) <= 1 && Math.abs(c[1]) <= 1) ||
        candles.some(([x, y]) => x === c[0] && y === c[1]);
      if (clash) continue;
      candles.push(c);
      break;
    }
  }
  return {
    name: "ritual circle",
    anchor: "open",
    parts: [
      // the lit centre: one distinct piece, nothing else within a cell of it
      p("magic_fire", 0, 0, { required: true }),
      // every stone at an equal angle round the ring, one family (monolith and standing stone resolve to the
      // same stones); one is broken off short
      ...ring.map(([x, y], i) =>
        p(i % 2 === 0 ? "monolith" : "standing_stone", x, y, {
          required: true,
          ...(i === ring.length - 2 ? { variant: "broken" } : {}),
        }),
      ),
      ...candles.map(([x, y]) => p("candles", x, y)),
      // the boss starts just outside the ring
      p("spawn_point", 0, r + 1, { variant: "boss" }),
    ],
  };
}

/**
 * Great tree against a wall (round 5: it read as a dark tangle on dark rock). The tree stands proud with a cleared
 * apron in front of it: light pools at its base (two accent lights, a glow either side of the trunk), roots run
 * up the wall beside it, and the smaller pieces keep their distance — mushrooms and crystals at the apron's edge,
 * columns framing it — so nothing clutters the trunk.
 */
function greatTree(): Group {
  return {
    name: "great tree",
    anchor: "wall",
    parts: [
      p("tree_large", -1, 0),
      p("accent_light", -2, 1),
      p("accent_light", 2, 1),
      p("roots_wall", -3, 0, { wall: true }),
      p("roots_wall", 3, 0, { wall: true }),
      p("spawn_point", 0, 4, { variant: "boss" }),
      p("mushroom", -3, 2),
      p("mushroom", 3, 2),
      p("crystal", -3, 4),
      p("crystal", 3, 4),
      p("root_large", -4, 3),
      p("vines", -4, 0, { wall: true }),
      p("vines", 4, 0, { wall: true }),
      p("giant_mushroom", 4, 1),
      p("cave_column", 5, 2),
      p("cave_column", -5, 2),
    ],
  };
}

/** Cavern focal: a grove of floor-to-ceiling rock columns against the far wall, for skyline. */
function columnGrove(): Group {
  return {
    name: "column grove",
    anchor: "wall",
    parts: [
      p("cave_column", 0, 0),
      p("rock_formation", 1, 0),
      p("cave_column", 3, 1),
      p("cave_column", -2, 1),
      p("stalagmite", -1, 0),
      p("stalagmite", 3, 0),
      p("stalactite", 0, 2),
      p("rock", -1, 2),
      p("debris", 2, 3),
      p("crystal", 4, 2),
    ],
  };
}

/** Ruined shrine against the far wall: a great statue flanked by braziers and broken columns. */
function shrine(): Group {
  return {
    name: "ruined shrine",
    anchor: "wall",
    parts: [
      p("statue_large", -1, 0),
      p("brazier", -2, 1),
      p("brazier", 1, 1),
      p("pillar", -4, 0, { variant: "ruined" }),
      p("pillar", 3, 0, { variant: "ruined" }),
      p("altar", -1, 3),
      p("candles", -2, 3),
      p("candles", 1, 3),
      p("rubble", -4, 2),
      p("debris", 3, 2),
      p("monolith", -4, 4),
      p("monolith", 3, 4),
      p("spawn_point", -1, 5, { variant: "boss" }),
    ],
  };
}

/** Bone pit: a heap of bones round a great skeleton, lit by magic fire. */
function bonePile(): Group {
  return {
    name: "bone pit",
    anchor: "open",
    parts: [
      p("statue_large", 0, 0, { variant: "bones" }),
      p("magic_fire", 2, 0),
      p("bones", -1, 0),
      p("bones", 0, 2),
      p("skull_pile", 1, 2),
      p("skull_pile", -1, 1),
      p("bones", 2, 2),
      p("skull_pile", 2, -1),
      p("spawn_point", -1, 2, { variant: "boss" }),
    ],
  };
}

/** Mushroom grove: a cluster of giant mushrooms round glowing crystals. */
function grove(): Group {
  return {
    name: "mushroom grove",
    anchor: "open",
    parts: [
      p("giant_mushroom", 0, 0),
      p("crystal", 1, 0, { variant: "large" }),
      p("giant_mushroom", 2, 0),
      p("giant_mushroom", 1, 2),
      p("giant_mushroom", -1, 1),
      p("mushroom", 0, 1),
      p("mushroom", 2, 1),
      p("mushroom", 1, -1),
      p("root", -1, -1),
      p("crystal", 3, 1),
    ],
  };
}

/** Rockfall against a wall: big pieces at the wall grading to small debris. */
function rockfall(): Group {
  return {
    name: "rockfall",
    anchor: "wall",
    parts: [
      p("cave_in", 0, 0),
      p("cave_in", 2, 0),
      p("boulder", -1, 0),
      p("boulder", 0, 2),
      p("rubble", 2, 2),
      p("rubble", -2, 1),
      p("debris", 1, 3),
      p("debris", -1, 3),
      p("debris", 3, 3),
      p("debris", 4, 1),
      p("debris", 0, 4),
    ],
  };
}

function crystalBloom(): Group {
  return {
    name: "crystal bloom",
    anchor: "open",
    parts: [
      p("crystal", 0, 0, { variant: "large" }),
      p("crystal", 1, 0),
      p("crystal", 0, 1),
      p("crystal", -1, 0),
      p("debris", 1, 1),
      p("rock", -1, -1),
    ],
  };
}

function campFire(): Group {
  return {
    name: "camp fire",
    anchor: "open",
    parts: [
      p("fire_pit", 0, 0),
      p("log", -1, -2),
      p("log", -1, 2),
      p("stump", 2, 0),
      p("stump", -2, 0),
      p("sack", 2, 2),
    ],
  };
}

const NATURAL_CLUSTERS: SetPieceDef = {
  focal: { place: "far_wall", build: landmarkStand },
  groups: [
    [G.cliffFoot, 6],
    [G.edgeDress, 6],
    [G.rockPile, 3],
    [G.bank, 5],
    [G.verge, 3],
    [G.tallStand, 4],
    [G.formationPile, 3],
    [G.grove, 2],
    [G.thicket, 2],
    [G.boulderField, 2],
    [G.accentNook, 1],
    [G.wallDress, 1],
    [G.edgeDress, 3],
    [G.cliffFoot, 3],
  ],
  cellsPerGroup: 12,
  wallLight: "torch_wall",
  lightSpacing: 8,
  openAnywhere: true,
  cladLedges: true,
  groundCover: 0.16,
};

const WOODLAND_GROUPS: SetPieceDef["groups"] = [
  [G.cliffFoot, 4],
  [G.edgeDress, 4],
  [G.rockPile, 2],
  [G.bank, 4],
  [G.verge, 5],
  [G.grove, 5],
  [G.tallStand, 4],
  [G.thicket, 3],
  [G.formationPile, 2],
  [G.accentNook, 1],
];

export const SET_PIECES: Record<ComposedPreset, SetPieceDef> = {
  natural_clusters: NATURAL_CLUSTERS,
  forest: {
    focal: { place: "far_wall", build: landmarkStand },
    groups: WOODLAND_GROUPS,
    cellsPerGroup: 12,
    wallLight: null,
    lightSpacing: 10,
    openAnywhere: true,
    cladLedges: true,
    groundCover: 0.2,
    canopy: 0.55,
  },
  dense_forest: {
    focal: { place: "far_wall", build: landmarkStand },
    groups: WOODLAND_GROUPS,
    cellsPerGroup: 10,
    wallLight: null,
    lightSpacing: 10,
    openAnywhere: true,
    cladLedges: true,
    groundCover: 0.22,
    canopy: 0.75,
  },
  woodland: {
    focal: { place: "far_wall", build: landmarkStand },
    groups: [
      [G.cliffFoot, 4],
      [G.edgeDress, 4],
      [G.rockPile, 2],
      [G.bank, 4],
      [G.verge, 4],
      [G.grove, 5],
      [G.tallStand, 4],
      [G.thicket, 3],
      [G.formationPile, 2],
      [G.edgeDress, 3],
      [G.cliffFoot, 2],
      [G.accentNook, 1],
    ],
    cellsPerGroup: 10,
    wallLight: null,
    lightSpacing: 10,
    openAnywhere: true,
    cladLedges: true,
    groundCover: 0.18,
    canopy: 0.25,
  },
  ritual_circle: {
    focal: { place: "center", build: ritualRing },
    groups: [
      [G.offerings, 3],
      [G.standingPair, 2],
      [G.boneHeap, 2],
      [G.monolithPair, 2],
      [G.stalagmiteCluster, 1],
      [G.rubbleSpill, 1],
      [G.scree, 2],
      [G.lipStones, 1],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 6,
  },
  overgrown: {
    focal: { place: "far_wall", build: greatTree },
    groups: [
      [G.rootBurst, 4],
      [G.rootTangle, 3],
      [G.fallenLog, 2],
      [G.vineWall, 2],
      [G.mushroomPatch, 2],
      [G.stumpIsland, 1],
      [G.columnCluster, 2],
      [G.rootSpill, 3],
      [G.scree, 1],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 7,
    groundCover: 0.14,
  },
  cavern: {
    ...NATURAL_CLUSTERS,
    focal: { place: "far_wall", build: columnGrove },
    groups: [
      ...NATURAL_CLUSTERS.groups,
      [G.stalagmiteCluster, 4],
      [G.stalagmiteWall, 3],
      [G.crystalNook, 2],
      [G.mushroomPatch, 2],
      [G.rubbleSpill, 2],
      [G.bonesNook, 1],
      [G.boulderIsland, 1],
      [G.columnCluster, 4],
      [G.scree, 3],
      [G.lipStones, 2],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 8,
    groundCover: 0.12,
  },
  collapse: {
    focal: { place: "far_wall", build: rockfall },
    groups: [
      [G.rubbleSpill, 4],
      [G.boulderIsland, 2],
      [G.stalagmiteWall, 1],
      [G.bonesNook, 1],
      [G.scree, 4],
      [G.columnCluster, 1],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 8,
    groundCover: 0.12,
  },
  crystal_grotto: {
    focal: { place: "center", build: crystalBloom },
    groups: [
      [G.crystalNook, 4],
      [G.crystalVein, 3],
      [G.stalagmiteCluster, 2],
      [G.mushroomPatch, 1],
      [G.columnCluster, 2],
    ],
    cellsPerGroup: 30,
    // cold light only: the crystals glow; torches only at the entrances
    wallLight: null,
    lightSpacing: 12,
    groundCover: 0.08,
  },
  campsite: {
    focal: { place: "center", build: campFire },
    groups: [
      [G.supplies, 3],
      [G.sleepingSpot, 3],
      [G.woodpile, 2],
      [G.stalagmiteWall, 1],
    ],
    cellsPerGroup: 36,
    wallLight: "torch_wall",
    lightSpacing: 8,
  },
  shrine_ruin: {
    focal: { place: "far_wall", build: shrine },
    groups: [
      [G.brokenColumns, 4],
      [G.statueAlcove, 2],
      [G.offerings, 2],
      [G.monolithPair, 1],
      [G.rubbleSpill, 2],
      [G.scree, 2],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 7,
  },
  bone_pit: {
    focal: { place: "center", build: bonePile },
    groups: [
      [G.hangingCage, 3],
      [G.webCorner, 3],
      [G.chainWall, 2],
      [G.boneHeap, 2],
      [G.scree, 1],
    ],
    cellsPerGroup: 30,
    wallLight: "torch_wall",
    lightSpacing: 9,
  },
  mine_works: {
    groups: [
      [G.mineFace, 4],
      [G.cartLine, 3],
      [G.orePile, 3],
      [G.supplies, 2],
      [G.rubbleSpill, 1],
      [G.scree, 2],
    ],
    cellsPerGroup: 28,
    wallLight: "torch_wall",
    lightSpacing: 7,
  },
  mushroom_grove: {
    focal: { place: "center", build: grove },
    groups: [
      [G.mushroomPatch, 4],
      [G.glowcaps, 2],
      [G.crystalNook, 2],
      [G.rootBurst, 2],
      [G.rootSpill, 2],
    ],
    cellsPerGroup: 28,
    // the glowcaps and crystals light the grove; torches only at the entrances
    wallLight: null,
    lightSpacing: 10,
    groundCover: 0.12,
  },
  barricade: {
    groups: [
      [G.barricadeLine, 4],
      [G.supplies, 3],
      [G.sleepingSpot, 2],
      [G.woodpile, 1],
    ],
    cellsPerGroup: 36,
    wallLight: "torch_wall",
    lightSpacing: 8,
  },
  // a street: dress a zone that takes in the road (a path op) and its pavements. Lamps stand in a regular row
  // along each kerb with bins between them, vehicles park along the road edge with varied gaps, shopfronts and
  // seating line the pavement; the carriageway, doors and crossings stay clear.
  street: {
    groups: [
      [BUILT.frontage, 4],
      [BUILT.kerbSeat, 2],
      [BUILT.kerbSign, 1],
    ],
    cellsPerGroup: 30,
    wallLight: null,
    lightSpacing: 99,
    openAnywhere: true,
    groundCover: 0.04,
    lineRhythm: "regular",
    junctionGreen: true,
    rows: [
      {
        type: "lantern",
        line: "kerb",
        spacing: 7,
        rhythm: "regular",
        between: "edge_dressing",
        betweenChance: 0.6,
        betweenTall: "cluster_tall",
        tallDepth: 2,
      },
      { type: "vehicle", line: "lane", spacing: 7, rhythm: "irregular", size: [3, 1], capPer: 12 },
    ],
  },
  // a service alley: bins and bags against the walls, wall clutter, rubbish underfoot, a lamp or two
  alley: {
    groups: [
      [BUILT.binBay, 4],
      [BUILT.wallClutter, 3],
      [BUILT.litter, 2],
    ],
    cellsPerGroup: 14,
    wallLight: "torch_wall",
    lightSpacing: 8,
    openAnywhere: true,
    groundCover: 0.12,
  },
  // a square: a landmark in the middle with seats facing it, trees with benches and flower beds round it
  plaza: {
    focal: { place: "center", build: plazaCentre },
    groups: [
      [BUILT.treeSeat, 4],
      [BUILT.flowerBed, 2],
      [BUILT.kerbSeat, 1],
    ],
    cellsPerGroup: 20,
    wallLight: null,
    lightSpacing: 99,
    openAnywhere: true,
    groundCover: 0.05,
    // trees in loose noise patches over the square, a seat in the shade of some, shrubs at their feet
    canopy: 0.35,
    landmarkApron: 1,
    canopyGroup: {
      name: "shade tree",
      anchor: "open",
      parts: [p("cluster_tall", 0, 0), p("seating", 0, 2), p("undergrowth", 1, 0), p("ground_cover", -1, 1)],
    },
  },
};

// ───────────────────────────── placement ─────────────────────────────

const EDGE_WALL = 1;
const EDGE_OPENING = 2;
const EDGE_LEDGE = 3;
const FLAG_LINK = 16;
const FLAG_WATER = 4;
const FLAG_PATH = 8;
const FLAG_BRIDGE = 64;
const FLAG_STEPS = 128;
const EDGE_STAIR = 4;
const SIDES: readonly Side[] = ["N", "E", "S", "W"];
const SIDE_ROT: Record<Side, Rotation> = { N: 0, E: 90, S: 180, W: 270 };
const INWARD: Record<Side, [number, number]> = { N: [0, 1], E: [-1, 0], S: [0, -1], W: [1, 0] };
const sq = (v: number): number => v * v;
const NEIGHBOURS8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
/** Pieces whose crowns or masses overhang their cell: they keep one cell inside the board. */
const BIG = new Set<FeatureType>([
  "cluster_tall",
  "landmark",
  "tree_large",
  "formation",
  "tree",
  "pine_tree",
  "dead_tree",
  "statue_large",
]);
/** Upright pieces that read as a fence when they stand in single file (see makesSingleFile). */
export const RUNNERS: ReadonlySet<FeatureType> = new Set<FeatureType>([
  "cluster_tall",
  "formation",
  "boulder",
  "tree",
  "pine_tree",
  "dead_tree",
  "stalagmite",
  "tall_marker",
  "monolith",
  "standing_stone",
  "edge_dressing",
  "rock",
]);
/** One-off statement pieces: never repeated in one dress op, clear ring round structures. */
const STATEMENT = new Set<FeatureType>(["landmark", "tree_large", "statue_large"]);
/** Anchors along a line (cliff lips and feet, banks, path verges): their groups are placed irregularly. */
const LINE_ANCHORS = new Set<Group["anchor"]>(["ledge_low", "ledge_high", "water_edge", "path_edge"]);
/** What a line piece may become instead, so a run mixes sizes and kinds (a fallen log among the rocks). */
const LINE_SWAP: readonly FeatureType[] = [
  "formation",
  "edge_dressing",
  "undergrowth",
  "root_large",
  "edge_dressing",
];
const key = (x: number, y: number): number => (x + 16384) * 32768 + (y + 16384);
/** Anchors of two groups keep at least this Chebyshev distance (clear ground between vignettes). */
const GROUP_GAP = 5;
/** Candidate anchors tried per group before it is dropped. */
const TRIES = 30;

export interface ComposeParams {
  preset: ComposedPreset;
  areaIndex: number;
  areaCells: Array<[number, number]>;
  density: number;
  seed: number;
  remaining: number;
}

interface Frame {
  ox: number;
  oy: number;
  /** unit vector along the anchor wall, and into the room */
  ax: number;
  ay: number;
  ix: number;
  iy: number;
  side: Side | null;
  rot: Rotation;
}

interface Planned {
  placement: GeneratedPlacement;
  cells: Array<[number, number]>;
  blocking: boolean;
}

/**
 * Generator 3, the default for natural levels: cliffs are never left bare. A band-only area: the rock band and the
 * growth that follows it (roots at the lip, undergrowth, a tree behind), nothing else. The resolver calls
 * `defaultCliffBands` for the natural regions no dress op with a band covers.
 */
const BAND_ONLY: SetPieceDef = {
  groups: [],
  cellsPerGroup: 12,
  wallLight: null,
  lightSpacing: 10,
  openAnywhere: true,
  cladLedges: true,
  bandMinRise: 1,
  bandOnly: true,
};

export interface DefaultBandParams {
  /** Display area index + 1 of the region (0: the open ground outside any area), as for `dress`. */
  areaIndex: number;
  areaCells: Array<[number, number]>;
  seed: number;
  remaining: number;
}

/**
 * The default rock band of a natural region at generator 3 (grid.generator >= 3; nothing at 2): a face of rock on
 * every rise of 2 tiles or more in the region, however the model dressed it. Themes without the formation roles get
 * nothing (grid.pieceSize says so). The caller decides which regions are natural and open-air and honours any opt-out.
 */
export function defaultCliffBands(grid: PlacementGrid, prm: DefaultBandParams): ScatterResult {
  if ((grid.generator ?? 2) < 3) return { placements: [], capped: false };
  return composeArea(
    grid,
    { preset: "natural_clusters", density: 0, ...prm, seed: subSeed(prm.seed, "defaultband") },
    BAND_ONLY,
  );
}

export function composeArea(
  grid: PlacementGrid,
  prm: ComposeParams,
  defOverride?: SetPieceDef,
): ScatterResult {
  const def = defOverride ?? SET_PIECES[prm.preset];
  const rng = createPrng(subSeed(prm.seed, `compose:${prm.preset}`));
  const isG3 = (grid.generator ?? 2) >= 3;
  const inArea =(x: number, y: number): boolean =>
    grid.inBounds(x, y) && grid.area(x, y) === prm.areaIndex && grid.isFloor(x, y);
  const cells = prm.areaCells.filter(([x, y]) => inArea(x, y)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: GeneratedPlacement[] = [];
  if (cells.length === 0) return { placements: out, capped: false };

  const taken = new Set<number>();
  /** Cells and anchor cells of organic pieces (natural overlap is allowed onto these, never onto an anchor). */
  const takenOrg = new Set<number>();
  const anchorsOrg = new Set<number>();
  const pendingAnchorsOrg = new Set<number>();
  /** Cells of committed and pending upright pieces (trees, rock masses, stones): no single-file runs of them. */
  const tallCells = new Set<number>();
  const pendingTall = new Set<number>();
  /** The focal group (a ring of stones, a statue and its braziers) is laid out on purpose: the run rule skips it. */
  let runGuard = true;
  /** Off only for the junction green: a street's joins to its side streets are not doorways. */
  let doorZoneOn = true;
  /** Cells kept clear round a landmark (filled after the focal group). */
  const apron = new Set<number>();
  /** Cells under seating: two seats never touch (a picnic table is wider than its cell). */
  const seatCells = new Set<number>();
  if (grid.landmark)
    for (const [x, y] of prm.areaCells)
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (grid.landmark(x + dx, y + dy) && !grid.landmark(x, y)) apron.add(key(x, y));
  const blocked = new Set<number>();
  for (const [x, y] of cells) if (grid.occupied(x, y)) blocked.add(key(x, y));

  const ownCells = new Set(prm.areaCells.map(([x, y]) => key(x, y)));
  // entrances: cells with an opening (or a link) — blocking pieces keep two cells clear of them
  const entries: Array<[number, number]> = [];
  // a narrow open join into another area (merging caves, an "open" doorway) is an entrance too; a long shared
  // boundary (a zone inside a bigger area) is not, or a zone could never be dressed
  const joins = new Map<number, Array<[number, number]>>();
  for (const [x, y] of cells)
    for (const sd of SIDES) {
      // a wall, or a cliff (nobody walks across it), is no join
      if (grid.edge(x, y, sd) === EDGE_WALL) continue;
      const nx = x + (sd === "E" ? 1 : sd === "W" ? -1 : 0);
      const ny = y + (sd === "S" ? 1 : sd === "N" ? -1 : 0);
      if (
        grid.edge(x, y, sd) !== EDGE_STAIR &&
        Math.abs((grid.height?.(nx, ny) ?? 0) - (grid.height?.(x, y) ?? 0)) > 0.5
      )
        continue;
      const a = grid.inBounds(nx, ny) ? grid.area(nx, ny) : 0;
      if (a === 0 || a === prm.areaIndex || !grid.isFloor(nx, ny) || ownCells.has(key(nx, ny))) continue;
      const l = joins.get(a) ?? [];
      l.push([x, y]);
      joins.set(a, l);
    }
  for (const l of joins.values()) if (l.length <= 6) entries.push(...l);
  const joinEntries = entries.length;
  for (const [x, y] of cells) {
    if (SIDES.some((s0) => grid.edge(x, y, s0) === EDGE_OPENING) || (grid.flags(x, y) & FLAG_LINK) !== 0)
      entries.push([x, y]);
    // the approach to a walkway, bridge or flight of steps is an entrance too (those cells are not floor the
    // dressing may use, so they never show up as a join above)
    else if (
      SIDES.some((s0) => {
        if (grid.edge(x, y, s0) === EDGE_STAIR) return true;
        if (grid.edge(x, y, s0) === EDGE_WALL) return false;
        const nx = x + (s0 === "E" ? 1 : s0 === "W" ? -1 : 0);
        const ny = y + (s0 === "S" ? 1 : s0 === "N" ? -1 : 0);
        return grid.inBounds(nx, ny) && (grid.flags(nx, ny) & (FLAG_BRIDGE | FLAG_STEPS)) !== 0;
      })
    )
      entries.push([x, y]);
  }
  const approach = new Set<number>();
  for (const [ex, ey] of entries.slice(joinEntries))
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) approach.add(key(ex + dx, ey + dy));
  const doorZone = new Set<number>();
  for (const [ex, ey] of entries)
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) doorZone.add(key(ex + dx, ey + dy));

  const wallSides = (x: number, y: number): Side[] => SIDES.filter((s) => grid.edge(x, y, s) === EDGE_WALL);
  const thinWallOn = (x: number, y: number, s: Side): boolean => {
    if (grid.edge(x, y, s) !== EDGE_WALL) return false;
    const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
    const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
    return grid.inBounds(nx, ny) && grid.isFloor(nx, ny);
  };
  const hOf = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  const step = (x: number, y: number, s: Side): [number, number] => [
    x + (s === "E" ? 1 : s === "W" ? -1 : 0),
    y + (s === "S" ? 1 : s === "N" ? -1 : 0),
  ];
  const wallCands: Array<[number, number, Side]> = [];
  const cornerCands: Array<[number, number, Side]> = [];
  const openCands: Array<[number, number]> = [];
  // ledges: a LEDGE edge (height step) or an open edge onto floorless ground (a chasm lip)
  /** Cells on the boundary of the area (no wall): a zone or an outdoor area has few or no walls. */
  const edgeCands: Array<[number, number, Side]> = [];
  /** Cells beside water (side = toward the water) and beside a path (side = toward the path). */
  const waterCands: Array<[number, number, Side]> = [];
  const pathCands: Array<[number, number, Side]> = [];
  const ledgeLow: Array<[number, number, Side]> = [];
  const ledgeHigh: Array<[number, number, Side]> = [];
  for (const [x, y] of cells) {
    const own = grid.flags(x, y);
    for (const sd of SIDES) {
      const [wx, wy] = step(x, y, sd);
      if (!grid.inBounds(wx, wy) || grid.edge(x, y, sd) === EDGE_WALL) continue;
      const nf = grid.flags(wx, wy);
      if ((own & FLAG_WATER) === 0 && (nf & FLAG_WATER) !== 0) waterCands.push([x, y, sd]);
      if ((own & FLAG_PATH) === 0 && (nf & FLAG_PATH) !== 0) pathCands.push([x, y, sd]);
    }
  }
  for (const [x, y] of cells) {
    for (const sd of SIDES) {
      const e = grid.edge(x, y, sd);
      const [nx, ny] = step(x, y, sd);
      if (e === EDGE_LEDGE) {
        if (grid.height === undefined) {
          ledgeLow.push([x, y, sd]);
          ledgeHigh.push([x, y, sd]);
        } else if (hOf(nx, ny) > hOf(x, y)) ledgeLow.push([x, y, sd]);
        else ledgeHigh.push([x, y, sd]);
      } else if (e !== EDGE_WALL && grid.inBounds(nx, ny) && !grid.isFloor(nx, ny) && grid.area(nx, ny) !== 0)
        ledgeHigh.push([x, y, sd]);
    }
  }
  for (const [x, y] of cells) {
    const ws = wallSides(x, y);
    for (const s of ws) wallCands.push([x, y, s]);
    for (let i = 0; i < 4; i++) {
      const a = SIDES[i] as Side;
      if (ws.includes(a) && ws.includes(SIDES[(i + 1) % 4] as Side)) cornerCands.push([x, y, a]);
    }
    if (ws.length === 0) openCands.push([x, y]);
    for (const sd of SIDES) {
      if (grid.edge(x, y, sd) === EDGE_WALL) continue;
      const [nx, ny] = step(x, y, sd);
      if (!inArea(nx, ny) && grid.isFloor(nx, ny)) edgeCands.push([x, y, sd]);
    }
  }

  // ── reachability guard ──
  // Walks the way a player does: no walls, no height step over half a tile unless it is a flight of steps. It
  // floods from every entrance (doors, joins, the cells in front of walkways, bridges and stairs). A group may only
  // take its own cells out of the walkable set, and may never split the entrances into more separate groups: a
  // tree on the only cell-wide way between the head of a walkway and the top of a flight of stairs is refused, even
  // on a ledge of the area that only the walkway reaches.
  const sources = entries.length ? entries : cells.slice(0, 1);
  const reach = (): { cells: number; groups: number } => {
    const seen = new Set<number>();
    let groups = 0;
    for (const [sx, sy] of sources) {
      const k0 = key(sx, sy);
      if (blocked.has(k0) || seen.has(k0)) continue;
      groups++;
      seen.add(k0);
      const q: Array<[number, number]> = [[sx, sy]];
      while (q.length) {
        const [x, y] = q.pop() as [number, number];
        for (const s of SIDES) {
          const e = grid.edge(x, y, s);
          if (e === EDGE_WALL) continue;
          const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
          const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
          const k = key(nx, ny);
          if (seen.has(k) || blocked.has(k) || !inArea(nx, ny)) continue;
          if (grid.height !== undefined && e !== EDGE_STAIR && Math.abs(hOf(nx, ny) - hOf(x, y)) > 0.5)
            continue;
          seen.add(k);
          q.push([nx, ny]);
        }
      }
    }
    return { cells: seen.size, groups };
  };
  let reachable = reach();

  const frameFor = (x: number, y: number, side: Side | null, corner: boolean): Frame => {
    if (side === null) {
      const q = rng.int(4) as 0 | 1 | 2 | 3;
      const dirs: Array<[number, number]> = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
      const [ax, ay] = dirs[q] as [number, number];
      return { ox: x, oy: y, ax, ay, ix: -ay, iy: ax, side: null, rot: ((q * 90) % 360) as Rotation };
    }
    const [ix, iy] = INWARD[side];
    let ax = iy;
    let ay = -ix;
    // corners: run away from the second wall; plain walls: mirror at random for variety
    if (corner || rng.chance(0.5)) {
      ax = -ax;
      ay = -ay;
    }
    return { ox: x, oy: y, ax, ay, ix, iy, side, rot: SIDE_ROT[side] };
  };

  /**
   * True when upright pieces on these cells would extend a single-file run: four or more upright pieces along one
   * row or column, each within three cells of the next, with little beside them (fewer than half as many in the
   * rows or columns either side). Trees on a two-cell strip between a brook and the board edge, rocks along a lip:
   * they come in clumps of up to three with gaps, never as a fence.
   */
  const makesSingleFile = (fp: ReadonlyArray<readonly [number, number]>): boolean => {
    const mine = new Set(fp.map(([x, y]) => key(x, y)));
    const isT = (x: number, y: number): boolean => {
      const k = key(x, y);
      return mine.has(k) || tallCells.has(k) || pendingTall.has(k);
    };
    for (const horiz of [true, false]) {
      for (const [fx, fy] of fp) {
        // walk the run both ways along the axis, allowing gaps of up to two cells
        const at = (u: number): boolean => (horiz ? isT(u, fy) : isT(fx, u));
        const u0 = horiz ? fx : fy;
        const run = (maxGap: number): { us: number[]; beside: number } => {
          let lo = u0;
          let hi = u0;
          const steps = Array.from({ length: maxGap }, (_, i) => i + 1);
          for (;;) {
            const nx = steps.map((d) => hi + d).find((u) => at(u));
            if (nx === undefined) break;
            hi = nx;
          }
          for (;;) {
            const nx = steps.map((d) => lo - d).find((u) => at(u));
            if (nx === undefined) break;
            lo = nx;
          }
          const us: number[] = [];
          let beside = 0;
          for (let u = lo; u <= hi; u++) {
            if (at(u)) us.push(u);
            if (horiz ? isT(u, fy - 1) || isT(u, fy + 1) : isT(fx - 1, u) || isT(fx + 1, u)) beside++;
          }
          return { us, beside };
        };
        // single file: four or more, each within three cells of the next
        const close = run(3);
        if (close.us.length >= 4 && close.beside * 2 < close.us.length) return true;
        // a metronome: a looser run (gaps up to six) where one spacing of two cells or more repeats three times
        const loose = run(6);
        if (loose.us.length >= 4 && loose.beside * 2 < loose.us.length) {
          const gaps = new Map<number, number>();
          for (let i = 1; i < loose.us.length; i++) {
            const d = (loose.us[i] as number) - (loose.us[i - 1] as number);
            if (d < 2) continue;
            const n = (gaps.get(d) ?? 0) + 1;
            if (n > 2) return true;
            gaps.set(d, n);
          }
        }
      }
    }
    return false;
  };

  /** Plans one part in a frame; null when it does not fit. */
  const planPart = (f: Frame, part: Part, pending: Set<number>, pendingOrg: Set<number>): Planned | null => {
    const info = featureInfo(part.t);
    const [sa, si] = part.size ?? info.size;
    const corners: Array<[number, number]> = [
      [part.dx, part.dy],
      [part.dx + sa - 1, part.dy + si - 1],
    ];
    const pts = corners.map(([u, v]) => [f.ox + f.ax * u + f.ix * v, f.oy + f.ay * u + f.iy * v] as const);
    const x0 = Math.min(pts[0]?.[0] ?? 0, pts[1]?.[0] ?? 0);
    const y0 = Math.min(pts[0]?.[1] ?? 0, pts[1]?.[1] ?? 0);
    const w = Math.abs((pts[0]?.[0] ?? 0) - (pts[1]?.[0] ?? 0)) + 1;
    const h = Math.abs((pts[0]?.[1] ?? 0) - (pts[1]?.[1] ?? 0)) + 1;
    const blocking = info.blocking && !info.wallMounted;
    const x0p = x0;
    const y0p = y0;
    const fp: Array<[number, number]> = [];
    for (let yy = y0; yy < y0 + h; yy++)
      for (let xx = x0; xx < x0 + w; xx++) {
        const k = key(xx, yy);
        if (!inArea(xx, yy) || grid.occupied(xx, yy)) return null;
        if (taken.has(k) || pending.has(k)) {
          // natural pieces overlap other natural pieces (a shrub tucked under a pine, rocks piled into a formation)
          const natural = info.organic && (takenOrg.has(k) || pendingOrg.has(k));
          if (!natural) return null;
          // never two natural pieces on the same anchor cell (they would sit at the same point)
          if (xx === x0p && yy === y0p && (anchorsOrg.has(k) || pendingAnchorsOrg.has(k))) return null;
        }
        const fl = grid.flags(xx, yy);
        // reeds and lily pads may stand in shallow water; nothing else does
        if ((fl & FLAG_LINK) !== 0 || ((fl & FLAG_WATER) !== 0 && part.t !== "bank_dressing")) return null;
        // paths stay clear: their edges get verge dressing instead
        if ((fl & FLAG_PATH) !== 0 && part.t !== "vehicle") return null;
        // seating keeps a cell clear of other seating
        if (part.t === "seating")
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) if (seatCells.has(key(xx + dx, yy + dy))) return null;
        // road crossings and their kerb ends stay clear
        if (grid.keepClear?.(xx, yy) === true) return null;
        // the apron in front of a landmark stays clear (lights excepted: they pool light at its base)
        if (apron.has(k) && !LIGHT_FEATURES.has(part.t)) return null;
        if (blocking && doorZoneOn && doorZone.has(k)) return null;
        fp.push([xx, yy]);
      }
    if (footprintCrossesWall(grid, [x0, y0], [w, h])) return null;
    if (runGuard && RUNNERS.has(part.t) && makesSingleFile(fp)) return null;
    // big pieces keep one cell inside the board, so crowns and rock masses never hang off the slab
    // (a wall on that side hides the overhang)
    if (BIG.has(part.t))
      for (const [xx, yy] of fp)
        for (const sd of SIDES)
          for (let d = 1; d <= 1; d++) {
            const [nx, ny] = step(xx, yy, sd);
            if (!grid.inBounds(nx, ny) && grid.edge(xx, yy, sd) !== EDGE_WALL) return null;
          }
    // statement pieces keep a clear ring round structures and yard pieces already on the map
    if (STATEMENT.has(part.t))
      for (let yy = y0 - 1; yy <= y0 + h; yy++)
        for (let xx = x0 - 1; xx <= x0 + w; xx++)
          if (grid.inBounds(xx, yy) && (grid.occupied(xx, yy) || SIDES.some((sd) => thinWallOn(xx, yy, sd))))
            return null;
    // never half on a ledge: no height step inside the footprint, every cell at the anchor's floor height
    // (natural masses — a great tree, a rock pile — may sit across a half-tile step of uneven ground: their roots
    // and base hide it; they stand on the LOWEST cell so nothing floats)
    if (w * h > 1) {
      const hs = fp.map(([xx, yy]) => hOf(xx, yy));
      const lo = Math.min(...hs);
      const hi = Math.max(...hs);
      const natural = info.organic || part.t === "landmark";
      if (hi - lo > (natural ? 0.5 : 0)) return null;
      if (hOf(x0, y0) !== lo) return null;
      if (!natural)
        for (const [xx, yy] of fp) {
          if (xx + 1 < x0 + w && grid.edge(xx, yy, "E") === EDGE_LEDGE) return null;
          if (yy + 1 < y0 + h && grid.edge(xx, yy, "S") === EDGE_LEDGE) return null;
        }
    }
    // A wall between two open cells is a thin (0.5-deep) strip hosted inside one of them: big pieces stay off
    // those cells so they never poke into the strip.
    if (!info.wallMounted && fp.some(([xx, yy]) => SIDES.some((s) => thinWallOn(xx, yy, s)))) return null;
    let wall: Side | undefined;
    if (part.wall || info.wallMounted) {
      if (f.side === null || w !== 1 || h !== 1 || grid.edge(x0, y0, f.side) !== EDGE_WALL) return null;
      wall = f.side;
    }
    // rotation: wall-backed pieces face into the room; small organic pieces away from walls get a ±15° seeded
    // jitter (multi-cell pieces and pieces beside a wall stay square so their bounds never poke into the wall)
    let rotFine: number = f.rot;
    const jitter = rng.int(3) - 1;
    const besideWall = SIDES.some((s) => grid.edge(x0, y0, s) === EDGE_WALL);
    if (info.organic && !wall && w === 1 && h === 1 && !besideWall)
      rotFine = (f.rot + jitter * 15 + 360) % 360;
    const rot = ((Math.round(rotFine / 90) % 4) * 90) as Rotation;
    const placement: GeneratedPlacement = { type: part.t, at: [x0, y0], size: [w, h], rot, rotFine };
    if (wall) placement.wall = wall;
    if (part.variant !== undefined) placement.variant = part.variant;
    return { placement, cells: fp, blocking };
  };

  /** Tries to place a whole group at a frame; the focal part must fit, the rest are optional. */
  const tryGroup = (f: Frame, g: Group, keepOptional = 1, dryRun = false): Planned[] | null => {
    const pending = new Set<number>();
    const pendingOrg = new Set<number>();
    pendingAnchorsOrg.clear();
    pendingTall.clear();
    const planned: Planned[] = [];
    const byPart = new Map<number, Planned>();
    for (let i = 0; i < g.parts.length; i++) {
      // generator 3 parts do not exist (and draw nothing) at earlier generators
      if ((g.parts[i] as Part).gen3 === true && !isG3) continue;
      // optional pieces drop out at random so repeated groups never look stamped
      if (i > 0 && keepOptional < 1 && (g.parts[i] as Part).required !== true && !rng.chance(keepOptional))
        continue;
      const part = g.parts[i] as Part;
      if (isG3 && part.on !== undefined) {
        const sup = byPart.get(part.on);
        const ext = sup ? grid.pieceExtent?.(sup.placement.type) : undefined;
        if (!sup || !ext) continue;
        const sp = sup.placement;
        const mx = sp.at[0] + sp.size[0] / 2;
        const my = sp.at[1] + sp.size[1] / 2;
        const cell: [number, number] = [Math.floor(mx), Math.floor(my)];
        const room = Math.max(0, Math.min(0.3, (Math.min(ext.w, ext.d, 1) - 0.4) / 2));
        const top: Planned = {
          placement: {
            type: part.t,
            at: cell,
            size: [1, 1],
            rot: 0,
            rotFine: rng.int(24) * 15,
            lift: ext.h,
            offset: [
              mx - (cell[0] + 0.5) + (rng.next() * 2 - 1) * room,
              my - (cell[1] + 0.5) + (rng.next() * 2 - 1) * room,
            ],
          },
          cells: [],
          blocking: false,
        };
        planned.push(top);
        byPart.set(i, top);
        continue;
      }
      const pl = planPart(f, part, pending, pendingOrg);
      if (!pl) {
        if (i === 0 || part.required === true) return null;
        continue;
      }
      for (const [x, y] of pl.cells) pending.add(key(x, y));
      if (RUNNERS.has(pl.placement.type)) for (const [x, y] of pl.cells) pendingTall.add(key(x, y));
      if (featureInfo(pl.placement.type).organic) {
        for (const [x, y] of pl.cells) pendingOrg.add(key(x, y));
        pendingAnchorsOrg.add(key(pl.placement.at[0], pl.placement.at[1]));
      }
      planned.push(pl);
      byPart.set(i, pl);
    }
    // a group is a composition: at least two of its pieces must land, or nothing is placed (no lone logs)
    if (planned.length < Math.min(2, g.parts.length)) return null;
    // reachability: the group may only remove its own cells from the walkable set
    // newly blocked cells only (overlapping natural pieces share cells; each counts once)
    const added = [
      ...new Set(planned.filter((q) => q.blocking).flatMap((q) => q.cells.map(([x, y]) => key(x, y)))),
    ].filter((k) => !blocked.has(k));
    for (const k of added) blocked.add(k);
    const after = reach();
    const cuts = after.cells < reachable.cells - added.length || after.groups > reachable.groups;
    if (cuts || dryRun) {
      for (const k of added) blocked.delete(k);
      return cuts ? null : planned;
    }
    reachable = after;
    return planned;
  };

  const anchors: Array<[number, number]> = [];
  const farFromAnchors = (x: number, y: number, gap: number): boolean =>
    anchors.every(([ax, ay]) => Math.max(Math.abs(ax - x), Math.abs(ay - y)) >= gap);
  const st = { capped: false };
  const commit = (planned: Planned[], ax: number, ay: number): void => {
    for (const q of planned) {
      if (out.length >= prm.remaining) {
        st.capped = true;
        return;
      }
      for (const [x, y] of q.cells) taken.add(key(x, y));
      if (RUNNERS.has(q.placement.type)) for (const [x, y] of q.cells) tallCells.add(key(x, y));
      if (q.placement.type === "seating") for (const [x, y] of q.cells) seatCells.add(key(x, y));
      if (featureInfo(q.placement.type).organic) {
        for (const [x, y] of q.cells) takenOrg.add(key(x, y));
        anchorsOrg.add(key(q.placement.at[0], q.placement.at[1]));
      }
      out.push(q.placement);
    }
    anchors.push([ax, ay]);
  };

  const distToEntry = (x: number, y: number): number =>
    entries.length === 0
      ? 0
      : Math.min(...entries.map(([ex, ey]) => (ex - x) * (ex - x) + (ey - y) * (ey - y)));

  // ── 0. cliffs as rock bands (cliffband.ts), first so the rock claims every edge before focal aprons and vignettes: courses of face rock stepping back up every rise, crest boulders over
  //    the lip; then growth that follows the rock: roots at the lip, shrubs on and behind the crest, a tree or a
  //    broken trunk a cell or two behind it ──
  if (def.cladLedges === true && !st.capped) {
    const levelBand = (grid.generator ?? 2) >= 3 && def.bandOnly !== true;
    const band: BandResult = levelBand
      ? {
          placements: [],
          units: 0,
          clad: 0,
          cells: [],
          rises: riseUnits(grid, cells, def.bandMinRise ?? 1),
          footprints: [],
          restsOn: [],
        }
      : cliffBand(grid, {
          areaCells: cells,
          seed: prm.seed,
          ...(def.bandMinRise !== undefined ? { minRise: def.bandMinRise } : {}),
          // routes keep their gap (cliffband.ts) and the reachability guard below keeps every entrance reachable; the
          // band keeps off the approach to a door, link or flight of steps (the cell in front and its neighbours), not
          // the whole two-cell door zone, which would leave a bare face beside every flight of steps
          avoid: (x, y) =>
            approach.has(key(x, y)) ||
            grid.keepClear?.(x, y) === true ||
            grid.occupied(x, y) ||
            apron.has(key(x, y)) ||
            (taken.has(key(x, y)) && !takenOrg.has(key(x, y))),
          // each rock passes the reachability guard: the band never closes the only way between two entrances (it
          // tries another way to cover that edge instead)
          accept: (fp) => {
            const added = [...new Set(fp.filter(([x, y]) => inArea(x, y)).map(([x, y]) => key(x, y)))].filter(
              (k) => !blocked.has(k),
            );
            for (const k of added) blocked.add(k);
            const after = reach();
            if (after.cells < reachable.cells - added.length || after.groups > reachable.groups) {
              for (const k of added) blocked.delete(k);
              return false;
            }
            reachable = after;
            return true;
          },
        });
    for (const q of band.placements) {
      if (out.length >= prm.remaining) {
        st.capped = true;
        break;
      }
      // other dressing keeps off the rock (growth may tuck into it)
      for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
        for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) {
          taken.add(key(x, y));
          takenOrg.add(key(x, y));
        }
      anchorsOrg.add(key(q.at[0], q.at[1]));
      out.push(q);
    }
    const STEPS: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
    for (const u of def.bandOnly === true ? [] : band.rises) {
      if (st.capped) break;
      const [dx, dy] = STEPS[u.side];
      const lipX = u.low[0] + dx;
      const lipY = u.low[1] + dy;
      const roll = rng.next();
      const [t, k]: [FeatureType, number] =
        roll < 0.22
          ? ["root", 0]
          : roll < 0.5
            ? ["undergrowth", 1]
            : roll < 0.6
              ? ["cluster_tall", 2]
              : roll < 0.63
                ? ["dead_tree", 2]
                : ["ground_cover", -1];
      if (k < 0) continue;
      const gx = lipX + dx * k;
      const gy = lipY + dy * k;
      const planned = tryGroup(frameFor(gx, gy, null, false), {
        name: "growth by the rock",
        anchor: "open",
        parts: [p(t, 0, 0)],
      });
      if (planned) commit(planned, gx, gy);
    }
  }

  // ── 1. focal group ──
  if (def.focal) {
    // a raised dais: size the focal (a ritual ring) to its top tier
    const top = Math.max(...cells.map(([x, y]) => hOf(x, y)));
    const topCells = cells.filter(([x, y]) => hOf(x, y) === top).length;
    // a small top (a mound's crown): the ring stands round it on the tiers below, sized to the whole rise
    const low = Math.min(...cells.map(([x, y]) => hOf(x, y)));
    const raised = cells.filter(([x, y]) => hOf(x, y) > low).length;
    const tierR =
      topCells < cells.length
        ? Math.max(
            Math.floor(Math.sqrt(topCells / 3.14159) - 0.4),
            raised > topCells && raised < cells.length ? Math.floor(Math.sqrt(raised / 3.14159) - 1) : 0,
          )
        : undefined;
    // a ring sized to the dais top, or smaller when the full ring does not fit (its stones are all required)
    const r0 = tierR !== undefined ? Math.max(2, Math.min(5, tierR)) : undefined;
    const builds: Group[] = [def.focal.build(cells.length, r0)];
    if (def.focal.place === "center")
      for (let r = (r0 ?? 4) - 1; r >= 2; r--) builds.push(def.focal.build(cells.length, r));
    let cands: Array<[number, number, Side | null]>;
    if (def.focal.place === "center") {
      let sx = 0;
      let sy = 0;
      for (const [x, y] of cells) {
        sx += x;
        sy += y;
      }
      const cx = sx / cells.length;
      const cy = sy / cells.length;
      // high ground first (a dais or platform), then nearest the middle
      cands = cells
        .map(([x, y]) => [x, y, null] as [number, number, Side | null])
        .sort(
          (a, b) =>
            hOf(b[0], b[1]) - hOf(a[0], a[1]) ||
            sq(a[0] + 0.5 - cx) + sq(a[1] + 0.5 - cy) - (sq(b[0] + 0.5 - cx) + sq(b[1] + 0.5 - cy)) ||
            a[1] - b[1] ||
            a[0] - b[0],
        );
    } else {
      cands = (wallCands.length >= 8 ? wallCands : [...wallCands, ...edgeCands])
        .map((c) => [c[0], c[1], c[2]] as [number, number, Side | null])
        .sort(
          (a, b) =>
            hOf(b[0], b[1]) - hOf(a[0], a[1]) ||
            distToEntry(b[0], b[1]) - distToEntry(a[0], a[1]) ||
            a[1] - b[1] ||
            a[0] - b[0],
        );
    }
    // centre: the first fit nearest the middle. Far wall: of the 40 wall spots farthest from the entrances, the
    // one where the most of the group fits (a great tree needs wall space for its roots either side).
    let best: { f: Frame; n: number; x: number; y: number; g: Group } | null = null;
    runGuard = false;
    for (const g of builds) {
      // a ragged natural wall: the group may stand one or two cells off it
      for (const [x, y, s] of cands.slice(0, def.focal.place === "center" ? 60 : 120)) {
        let done = false;
        for (const shift of s === null ? [0] : [0, 1, 2]) {
          const f0 = frameFor(x, y, s, false);
          const f = { ...f0, ox: f0.ox + f0.ix * shift, oy: f0.oy + f0.iy * shift };
          const planned = tryGroup(f, g, 1, true);
          if (!planned) continue;
          if (!best || planned.length > best.n) best = { f, n: planned.length, x, y, g };
          if (def.focal.place === "center" || planned.length >= g.parts.length - 2) done = true;
          break;
        }
        if (done) break;
      }
      if (best) break;
    }
    const planned = best ? tryGroup(best.f, best.g) : null;
    runGuard = true;
    if (best && planned) {
      commit(planned, best.x, best.y);
      // a landmark (great tree, statue) gets a cleared apron round it (two cells, or the preset's), so it reads on
      // its own
      const apronR = def.landmarkApron ?? 2;
      for (const q of planned)
        if (STATEMENT.has(q.placement.type))
          for (const [cx, cy] of q.cells)
            for (let dy = -apronR; dy <= apronR; dy++)
              for (let dx = -apronR; dx <= apronR; dx++)
                if (!q.cells.some(([qx, qy]) => qx === cx + dx && qy === cy + dy))
                  apron.add(key(cx + dx, cy + dy));
      // the focal group reserves a wider clearing
      anchors.push(...planned.map((q) => [q.placement.at[0], q.placement.at[1]] as [number, number]));
    }
  }

  // ── 1b. kerb rows (built places): a regular rhythm or varied gaps along the edge of a road ──
  for (const row of def.rows ?? []) {
    if (st.capped) break;
    // candidate cells and the side the road (row "kerb") or the pavement (row "lane") lies on
    const cands: Array<[number, number, Side]> = [];
    for (const [x, y] of cells) {
      const onPath = (grid.flags(x, y) & FLAG_PATH) !== 0;
      if (row.line === "kerb" ? onPath : !onPath) continue;
      for (const sd of SIDES) {
        if (grid.edge(x, y, sd) === EDGE_WALL) continue;
        const [nx, ny] = step(x, y, sd);
        if (!grid.inBounds(nx, ny) || !grid.isFloor(nx, ny)) continue;
        const nPath = (grid.flags(nx, ny) & FLAG_PATH) !== 0;
        // kerb: a pavement cell whose neighbour is road, the piece's back to the road; lane: a road cell whose
        // neighbour is pavement, the vehicle's side against the kerb
        if (row.line === "kerb" ? nPath : !nPath && inArea(nx, ny)) cands.push([x, y, sd]);
      }
    }
    // lines: one per side and row (or column), runs of consecutive cells along it
    const lines = new Map<string, Array<[number, number, Side]>>();
    for (const c of cands) {
      const ns = c[2] === "N" || c[2] === "S";
      const k = `${c[2]}:${String(ns ? c[1] : c[0])}`;
      lines.set(k, [...(lines.get(k) ?? []), c]);
    }
    const along = row.size?.[0] ?? 1;
    const placeAt = (
      x: number,
      y: number,
      sd: Side,
      t: FeatureType,
      size?: readonly [number, number],
    ): boolean => {
      // the piece runs along the line from its cell: a frame with its axis fixed along the line, inward away from
      // the edge (so a parked car lies along the kerb, a lamp's back is to the road)
      const [ix, iy] = INWARD[sd];
      // a vehicle lies along the road (a quarter turn from facing the kerb); everything else faces away from the road
      const rot = (t === "vehicle" ? (SIDE_ROT[sd] + 90) % 360 : SIDE_ROT[sd]) as Rotation;
      const f: Frame = { ox: x, oy: y, ax: Math.abs(iy), ay: Math.abs(ix), ix, iy, side: sd, rot };
      // a wide vehicle overhangs the kerb: nothing may stand on the pavement cells beside it
      if (t === "vehicle")
        for (let u = 0; u < (size?.[0] ?? 1); u++) {
          const [kx, ky] = step(x + Math.abs(iy) * u, y + Math.abs(ix) * u, sd);
          if (taken.has(key(kx, ky))) return false;
        }
      const part: Part = size ? { t, dx: 0, dy: 0, size } : { t, dx: 0, dy: 0 };
      const planned = tryGroup(f, { name: `${t} row`, anchor: "open", parts: [part] });
      if (!planned) return false;
      commit(planned, x, y);
      return true;
    };
    runGuard = row.rhythm !== "regular" && def.lineRhythm !== "regular";
    // the cap: one piece per `capPer` candidate cells, less what already stands in this area's lanes
    let rowCount = 0;
    let rowCap = Infinity;
    if (row.capPer !== undefined) {
      const already = new Set<number>();
      // every vehicle already on this area's carriageway counts, parked or stalled mid-road
      for (const [x, y] of cells)
        if ((grid.flags(x, y) & FLAG_PATH) !== 0 && grid.vehicle?.(x, y) === true) already.add(key(x, y));
      rowCap = Math.max(
        0,
        Math.floor(cands.length / row.capPer) - Math.round(already.size / (row.size?.[0] ?? 1)),
      );
    }
    for (const l of [...lines.values()].sort((a, b) => (a[0]?.[2] ?? "").localeCompare(b[0]?.[2] ?? ""))) {
      const ns = l[0]?.[2] === "N" || l[0]?.[2] === "S";
      l.sort((a, b) => (ns ? a[0] - b[0] : a[1] - b[1]));
      // runs of consecutive cells
      const runs: Array<Array<[number, number, Side]>> = [];
      for (const c of l) {
        const r = runs[runs.length - 1];
        const last = r?.[r.length - 1];
        if (r && last && (ns ? c[0] - last[0] : c[1] - last[1]) === 1) r.push(c);
        else runs.push([c]);
      }
      for (const r of runs) {
        if (r.length < along) continue;
        if (row.rhythm === "regular") {
          const phase = rng.int(Math.max(1, Math.min(row.spacing, r.length)));
          let prev: number | null = null;
          for (let i = phase; i < r.length; i += row.spacing) {
            // the rhythm's cell, or the nearest free one within three when it is taken (a door, a crossing)
            let done = -1;
            for (const d of [0, 1, -1, 2, -2, 3, -3]) {
              const c = r[i + d];
              if (c && placeAt(c[0], c[1], c[2], row.type, row.size)) {
                done = i + d;
                break;
              }
            }
            if (done < 0) continue;
            if (prev !== null && row.between && rng.chance(row.betweenChance ?? 1)) {
              const m = r[Math.round((prev + done) / 2)];
              if (m) {
                // pavement depth from the kerb, away from the road
                const [ix, iy] = INWARD[m[2]];
                let depth = 0;
                while (depth < 8 && inArea(m[0] + ix * depth, m[1] + iy * depth)) depth++;
                const tall = row.betweenTall !== undefined && depth >= (row.tallDepth ?? 3);
                if (!(tall && placeAt(m[0], m[1], m[2], row.betweenTall as FeatureType)))
                  placeAt(m[0], m[1], m[2], row.between);
              }
            }
            prev = done;
          }
        } else {
          let i = rng.int(Math.max(1, row.spacing));
          while (i + along <= r.length) {
            const c = r[i];
            // parked vehicles: at most one per `capPer` cells of kerb lane on the street, counting those the plan
            // placed itself, and never within four cells of one of them
            if (row.type === "vehicle" && c) {
              if (rowCount >= rowCap) break;
              const near = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].some((d) => {
                const [ax, ay] = ns ? [c[0] + d, c[1]] : [c[0], c[1] + d];
                return grid.vehicle?.(ax, ay) === true;
              });
              if (near) {
                i += 1;
                continue;
              }
            }
            if (c && placeAt(c[0], c[1], c[2], row.type, row.size)) {
              rowCount++;
              i += along + Math.max(1, Math.round(row.spacing / 2)) + rng.int(row.spacing);
            } else i += 1;
          }
        }
      }
    }
    runGuard = true;
  }

  // ── 1c. a pocket of green at a junction corner (a street tree with shrubs where two roads meet) ──
  if (def.junctionGreen === true && !st.capped) {
    const corners = cells.filter(([x, y]) => {
      if ((grid.flags(x, y) & FLAG_PATH) !== 0) return false;
      const road = (dx: number, dy: number): boolean =>
        grid.inBounds(x + dx, y + dy) && (grid.flags(x + dx, y + dy) & FLAG_PATH) !== 0;
      // the carriageway on two sides that meet at a corner: an outer pavement corner
      return (road(1, 0) || road(-1, 0)) && (road(0, 1) || road(0, -1));
    });
    // the corner cell or one just behind it (the corner itself may be a crossing approach)
    const spots: Array<[number, number]> = [];
    for (const [cx, cy] of corners)
      for (const [dx, dy] of [[0, 0], ...NEIGHBOURS8, [2, 0], [-2, 0], [0, 2], [0, -2]] as const)
        if (inArea(cx + dx, cy + dy) && (grid.flags(cx + dx, cy + dy) & FLAG_PATH) === 0)
          spots.push([cx + dx, cy + dy]);
    doorZoneOn = false;
    for (const [x, y] of rng.shuffle(spots)) {
      const planned = tryGroup(frameFor(x, y, null, false), {
        name: "corner green",
        anchor: "open",
        parts: [
          p("cluster_tall", 0, 0),
          p("undergrowth", 1, 0),
          p("undergrowth", 0, 1),
          p("ground_cover", 1, 1),
        ],
      });
      if (planned) {
        commit(planned, x, y);
        break;
      }
    }
    doorZoneOn = true;
  }

  // ── 2. vignettes ──
  const want = Math.max(1, Math.round((prm.density * cells.length) / def.cellsPerGroup));
  let midX = 0;
  let midY = 0;
  for (const [x, y] of cells) {
    midX += x + 0.5;
    midY += y + 0.5;
  }
  midX /= cells.length;
  midY /= cells.length;
  /** Squared radius of the clear middle: a quarter of the area's typical width. */
  const clearR2 = cells.length / 16;
  const big = cells.length >= 150 || def.openAnywhere === true;
  const wallish = wallCands.length >= 8 ? wallCands : [...wallCands, ...edgeCands];
  // each use halves a group's weight and at most MAX_REPEAT copies appear, so the room is a mix, not a pattern
  const groups = def.groups
    .filter(([g]) => (g.anchor !== "open" || big) && (g.anchor !== "ledge_low" || ledgeLow.length > 0))
    .filter(([g]) => g.anchor !== "ledge_high" || ledgeHigh.length > 0)
    .filter(([g]) => g.anchor !== "water_edge" || (waterCands.length > 0 && !isG3))
    .filter(([g]) => g.anchor !== "path_edge" || pathCands.length > 0)
    .map(([g, w]) => ({ g, w, used: 0 }));
  // large natural areas need many stands of trees and rocks, not three
  const maxRepeat = big ? Math.max(3, Math.ceil(cells.length / 150)) : 2;
  const gap = def.openAnywhere === true ? GROUP_GAP - 1 : GROUP_GAP;
  const pickGroup = (r: Prng): Group | null => {
    const live = groups.filter((e) => e.used < maxRepeat);
    const total = live.reduce((s, e) => s + e.w, 0);
    if (total <= 0) return null;
    let x = r.next() * total;
    for (const e of live) {
      x -= e.w;
      if (x < 0) return e.g;
    }
    return (live[live.length - 1] as { g: Group }).g;
  };
  const used = (g: Group): void => {
    const e = groups.find((q) => q.g === g);
    if (e) {
      e.used++;
      e.w /= 2;
    }
  };
  const openList: ReadonlyArray<readonly [number, number, Side | null]> = openCands.map(([x, y]) => [
    x,
    y,
    null,
  ]);
  /**
   * Placements along a line — cliff lips and feet, banks, path verges: the one routine every line-following group
   * goes through, so all of them share the irregularity rules.
   *  - spacing: the distance from a new run to the nearest earlier run on the same kind of line never repeats more
   *    than twice (no metronome of equal gaps);
   *  - shape: each piece after the first shifts along the line by up to a cell and up to two cells off it (some on
   *    the lip, some back from it);
   *  - kinds: rock masses and edge stones sometimes become something else (a log among the rocks), and at most two
   *    large pieces in one run touch;
   *  - single file: upright pieces never make a run of more than three (makesSingleFile, checked per piece).
   */
  const alongLine = (() => {
    const placed = new Map<Group["anchor"], Array<[number, number]>>();
    const gaps = new Map<string, number>();
    const nearest = (anchor: Group["anchor"], x: number, y: number): number | null => {
      const l = placed.get(anchor) ?? [];
      if (l.length === 0) return null;
      return Math.min(...l.map(([ax, ay]) => Math.max(Math.abs(ax - x), Math.abs(ay - y))));
    };
    return {
      spacingOk: (anchor: Group["anchor"], x: number, y: number): boolean => {
        const d = nearest(anchor, x, y);
        return d === null || (gaps.get(`${anchor}:${String(d)}`) ?? 0) < 2;
      },
      record: (anchor: Group["anchor"], x: number, y: number): void => {
        const d = nearest(anchor, x, y);
        if (d !== null) gaps.set(`${anchor}:${String(d)}`, (gaps.get(`${anchor}:${String(d)}`) ?? 0) + 1);
        placed.set(anchor, [...(placed.get(anchor) ?? []), [x, y]]);
      },
      parts: (g: Group): Group => {
        let large = 0;
        return {
          ...g,
          parts: g.parts.map((q, i) => {
            let t: FeatureType = q.t;
            if (i > 0 && (t === "formation" || t === "edge_dressing") && rng.chance(0.35))
              t = LINE_SWAP[rng.int(LINE_SWAP.length)] as FeatureType;
            if (t === "formation" && ++large > 2) t = rng.chance(0.5) ? "edge_dressing" : "undergrowth";
            return {
              ...q,
              t,
              dx: q.dx + (i > 0 ? rng.int(3) - 1 : 0),
              dy: q.dy + (i > 0 ? rng.int(3) : 0),
            };
          }),
        };
      },
    };
  })();
  let made = 0;
  for (let n = 0; n < want * 2 && made < want && !st.capped; n++) {
    const g = pickGroup(rng);
    if (!g) break;
    const anchored: ReadonlyArray<readonly [number, number, Side | null]> =
      g.anchor === "wall"
        ? wallish
        : g.anchor === "corner"
          ? cornerCands
          : g.anchor === "ledge_low"
            ? ledgeLow
            : g.anchor === "ledge_high"
              ? ledgeHigh
              : g.anchor === "water_edge"
                ? waterCands
                : g.anchor === "path_edge"
                  ? pathCands
                  : openList;
    // natural presets in open country (no walls or corners): wall and corner groups stand on open ground instead
    const list =
      anchored.length === 0 &&
      def.openAnywhere === true &&
      (g.anchor === "wall" || g.anchor === "corner") &&
      !g.parts.some((q) => LIGHT_FEATURES.has(q.t))
        ? openList
        : anchored;
    if (list.length === 0) continue;
    for (let t = 0; t < TRIES; t++) {
      const c = list[rng.int(list.length)] as readonly [number, number, Side | null];
      const line = LINE_ANCHORS.has(g.anchor);
      if (!farFromAnchors(c[0], c[1], line ? gap + 2 + rng.int(5) : gap)) continue;
      // negative space: open-ground groups keep out of the middle of the area (the combat floor and paths)
      if (c[2] === null && sq(c[0] + 0.5 - midX) + sq(c[1] + 0.5 - midY) < clearR2) continue;
      const regular = def.lineRhythm === "regular";
      if (line && !regular && !alongLine.spacingOk(g.anchor, c[0], c[1])) continue;
      const g2: Group = line && !regular ? alongLine.parts(g) : g;
      runGuard = !regular;
      const planned = tryGroup(frameFor(c[0], c[1], c[2], g.anchor === "corner"), g2, line ? 0.7 : 0.9);
      runGuard = true;
      if (!planned) continue;
      commit(planned, c[0], c[1]);
      if (line) alongLine.record(g.anchor, c[0], c[1]);
      used(g);
      made++;
      break;
    }
  }

  // ── 3. lighting pass: entrances first, then along the walls ──
  const lights: Array<[number, number]> = out
    .filter((q) => LIGHT_FEATURES.has(q.type))
    .map((q) => [q.at[0], q.at[1]]);
  const lit = (x: number, y: number, r: number): boolean =>
    lights.some(([lx, ly]) => Math.max(Math.abs(lx - x), Math.abs(ly - y)) < r);
  const placeLight = (x: number, y: number, s: Side, type: FeatureType | null = def.wallLight): boolean => {
    if (type === null) return false;
    if (out.length >= prm.remaining) {
      st.capped = true;
      return false;
    }
    const k = key(x, y);
    // a torch needs solid wall behind it: not a railing, fence or deck edge between two floors
    {
      const [bx, by] = step(x, y, s);
      if (grid.inBounds(bx, by) && (grid.isFloor(bx, by) || (grid.flags(bx, by) & FLAG_BRIDGE) !== 0))
        return false;
    }
    if (
      taken.has(k) ||
      grid.occupied(x, y) ||
      !inArea(x, y) ||
      grid.edge(x, y, s) !== EDGE_WALL ||
      thinWallOn(x, y, s)
    )
      return false;
    taken.add(k);
    out.push({
      type,
      at: [x, y],
      size: [1, 1],
      rot: SIDE_ROT[s],
      rotFine: SIDE_ROT[s],
      wall: s,
    });
    lights.push([x, y]);
    return true;
  };
  for (const [ex, ey] of entries) {
    if (lit(ex, ey, 3)) continue;
    const near = wallCands
      .filter(([x, y]) => Math.max(Math.abs(x - ex), Math.abs(y - ey)) <= 2)
      .sort(
        (a, b) => Math.abs(a[0] - ex) + Math.abs(a[1] - ey) - (Math.abs(b[0] - ex) + Math.abs(b[1] - ey)),
      );
    for (const [x, y, s] of near) if (placeLight(x, y, s, "torch_wall")) break;
  }
  // platform and chasm edges: a floor light on the upper side wherever the lip is dark (lights on both levels)
  // at most two per dress op, well apart: lights mark a lip, they do not line it
  let edgeLights = 0;
  const atStairOrBridge = (x: number, y: number): boolean =>
    SIDES.some((sd) => {
      if (grid.edge(x, y, sd) === EDGE_STAIR) return true;
      const [nx, ny] = step(x, y, sd);
      return (
        grid.inBounds(nx, ny) &&
        (grid.flags(nx, ny) & FLAG_BRIDGE) !== 0 &&
        (grid.flags(x, y) & FLAG_BRIDGE) === 0
      );
    });
  const lightSpots = cells
    .filter(([x, y]) => atStairOrBridge(x, y))
    .map(([x, y]) => [x, y] as [number, number]);
  for (const [x, y] of rng.shuffle(lightSpots)) {
    if (st.capped || edgeLights >= 2 || lit(x, y, def.lightSpacing + 4)) continue;
    const planned = tryGroup(frameFor(x, y, null, false), {
      name: "edge light",
      anchor: "open",
      parts: [p("torch_floor", 0, 0)],
    });
    if (!planned) continue;
    commit(planned, x, y);
    lights.push([x, y]);
    edgeLights++;
  }
  const order = rng.shuffle(wallCands);
  for (const [x, y, s] of order) {
    if (st.capped) break;
    if (lit(x, y, def.lightSpacing)) continue;
    placeLight(x, y, s);
  }
  // ── 3b. generator 3: a landmark is lit: a floor light a cell or two off its footprint when none stands within four
  //    cells (the review's focal_unlit check; the lights of a lit place stand at the focal points, not only at walls) ──
  if ((grid.generator ?? 2) >= 3) {
    const FOCAL_LIT = new Set<FeatureType>(["landmark", "statue", "statue_large", "altar", "fountain", "well", "monolith", "standing_stone", "tall_marker", "throne"]);
    for (const f of out.filter((q) => FOCAL_LIT.has(q.type))) {
      if (st.capped) break;
      const cx = f.at[0] + f.size[0] / 2;
      const cy = f.at[1] + f.size[1] / 2;
      if (lights.some(([lx, ly]) => Math.max(Math.abs(lx + 0.5 - cx), Math.abs(ly + 0.5 - cy)) < 4 + Math.max(f.size[0], f.size[1]) / 2)) continue;
      // the nearest free ground ring around the footprint, off the paths
      const ring = cells
        .filter(([x, y]) => {
          const dx = Math.max(f.at[0] - x, 0, x - (f.at[0] + f.size[0] - 1));
          const dy = Math.max(f.at[1] - y, 0, y - (f.at[1] + f.size[1] - 1));
          return Math.max(dx, dy) >= 1 && Math.max(dx, dy) <= 2 && !taken.has(key(x, y)) && !doorZone.has(key(x, y));
        })
        .sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy) || a[0] - b[0] || a[1] - b[1]);
      for (const [x, y] of ring.slice(0, 8)) {
        const planned = tryGroup(frameFor(x, y, null, false), { name: "focal light", anchor: "open", parts: [p("torch_floor", 0, 0)] });
        if (!planned) continue;
        commit(planned, x, y);
        lights.push([x, y]);
        break;
      }
    }
  }
  // ── 4. canopy: trees in noise patches over free ground up to the preset's cover, thinning toward paths and the
  //    clearing, with undergrowth between them ──
  if (def.canopy !== undefined && def.canopy > 0) {
    const field = new ValueNoise(subSeed(prm.seed, "canopy"));
    const nearPath = (x: number, y: number, r: number): boolean => {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (grid.inBounds(x + dx, y + dy) && (grid.flags(x + dx, y + dy) & FLAG_PATH) !== 0) return true;
      return false;
    };
    const target = Math.round(def.canopy * cells.length * 0.45);
    let trees = out.filter((q) => q.type === "cluster_tall").length;
    for (const [x, y] of rng.shuffle(cells)) {
      if (st.capped || trees >= target) break;
      if (taken.has(key(x, y)) || doorZone.has(key(x, y)) || apron.has(key(x, y))) continue;
      const clearing = sq(x + 0.5 - midX) + sq(y + 0.5 - midY) < clearR2 * (def.canopy >= 0.7 ? 0.5 : 1);
      let pr = def.canopy * (field.sample(x / 6, y / 6) > 0.4 ? 1.4 : 0.35);
      if (clearing) continue;
      // a ragged edge toward paths: how far the trees stay back varies along the path
      const back = field.sample(x / 2.3 + 17, y / 2.3 + 5) > 0.5 ? 2 : 1;
      if (nearPath(x, y, 1)) pr *= 0.1;
      else if (back === 2 && nearPath(x, y, 2)) pr *= 0.35;
      if (!rng.chance(Math.min(0.95, pr))) continue;
      const planned = tryGroup(
        frameFor(x, y, null, false),
        def.canopyGroup ?? {
          name: "tree",
          anchor: "open",
          parts: [
            p("cluster_tall", 0, 0),
            p("undergrowth", 1, 0),
            p("undergrowth", 0, 1),
            p("ground_cover", -1, 1),
          ],
        },
        0.5,
      );
      if (!planned) continue;
      commit(planned, x, y);
      trees++;
    }
  }

  // ── 5. ground cover: drifts in value-noise patches, denser at tree feet and verges, never on paths or entrances ──
  if (def.groundCover !== undefined && def.groundCover > 0) {
    const field = new ValueNoise(subSeed(prm.seed, "groundcover"));
    const types: FeatureType[] = ["ground_cover", "ground_cover", "small_detail"];
    const coverCells = new Set<number>();
    const CAUSES = new Set<FeatureType>(["campfire", "fire_pit", "tent", "tree_large", "landmark", "tree", "dead_tree", "pine_tree"]);
    const causes = out.filter((q) => CAUSES.has(q.type)).map((q) => [q.at[0], q.at[1]] as const);
    for (const [x, y] of cells) {
      if (st.capped) break;
      if (out.length >= prm.remaining) {
        st.capped = true;
        break;
      }
      const k = key(x, y);
      if (taken.has(k) || grid.occupied(x, y) || doorZone.has(k) || apron.has(k)) continue;
      const fl = grid.flags(x, y);
      if ((fl & FLAG_WATER) !== 0 && (fl & FLAG_LINK) === 0) {
        // reeds and lily pads drift along the water's edge, inside the water
        const atBank = SIDES.some((sd) => {
          const [nx, ny] = step(x, y, sd);
          return grid.inBounds(nx, ny) && grid.isFloor(nx, ny) && (grid.flags(nx, ny) & FLAG_WATER) === 0;
        });
        // (generator 3 dresses the water as one body: gen/water.ts)
        if (atBank && rng.chance(0.35) && !isG3) {
          taken.add(k);
          takenOrg.add(k);
          anchorsOrg.add(k);
          out.push({ type: "bank_dressing", at: [x, y], size: [1, 1], rot: 0, rotFine: rng.int(24) * 15 });
        }
        continue;
      }
      if ((fl & (FLAG_LINK | FLAG_PATH)) !== 0) continue;
      // generator 3: broader drifts (about 7 cells), so the bare ground between them is wide
      const patch = isG3 ? field.sample(x / 6.5, y / 7.5) : field.sample(x / 3.3, y / 4.7);
      const r = rng.next();
      const t = types[rng.int(types.length)] as FeatureType;
      // beside trees, rocks and paths the ground cover thickens (tree feet, verges)
      let near = 0;
      for (const sd of SIDES) {
        const [nx, ny] = step(x, y, sd);
        if (takenOrg.has(key(nx, ny))) near++;
        if (grid.inBounds(nx, ny) && (grid.flags(nx, ny) & FLAG_PATH) !== 0) near++;
      }
      // clumps, not a lattice (owner's watchtower run, 2026-11-20: one piece on every other cell of a dense patch
      // read as a planted grid): a seed grows into a clump of 2–4 touching pieces, and clumps keep a clear cell
      // between them, so a patch is tufts and gaps rather than an even sprinkle
      // generator 3: fewer, denser drifts with bare ground between them (clusters, not litter): a higher bar for a
      // patch, a thicker sowing inside it, and nothing at its feathered edge
      // and tied to a cause: damp ground by a rift or water, a camp, a tree; far from any, only the odd tuft
      let tied = false;
      if (isG3) {
        tied = causes.some(([cx, cy]) => Math.hypot(cx - x, cy - y) <= 3.5);
        for (let dy = -3; dy <= 3 && !tied; dy++)
          for (let dx = -3; dx <= 3; dx++)
            if (grid.inBounds(x + dx, y + dy) && (grid.flags(x + dx, y + dy) & (FLAG_WATER | 1)) !== 0) {
              tied = true;
              break;
            }
      }
      const pr = isG3
        ? 0.4 * def.groundCover * (patch > 0.64 ? 3.6 : patch > 0.58 ? 1.0 : 0) * (1 + near * 0.6) * (tied ? 1.6 : 0.15)
        : 0.4 * def.groundCover * (patch > 0.55 ? 2.2 : patch > 0.45 ? 0.6 : 0) * (1 + near * 0.6);
      if (r >= pr) continue;
      let crowded = false;
      for (let dy = -1; dy <= 1 && !crowded; dy++)
        for (let dx = -1; dx <= 1; dx++) if (coverCells.has(key(x + dx, y + dy))) crowded = true;
      if (crowded) continue;
      const clump: Array<[number, number]> = [[x, y]];
      const want = 2 + rng.int(3);
      for (const [dx, dy] of rng.shuffle(NEIGHBOURS8)) {
        if (clump.length >= want) break;
        const nx = x + dx;
        const ny = y + dy;
        const nk = key(nx, ny);
        if (!inArea(nx, ny) || taken.has(nk) || grid.occupied(nx, ny) || doorZone.has(nk) || apron.has(nk))
          continue;
        if ((grid.flags(nx, ny) & (FLAG_LINK | FLAG_PATH | FLAG_WATER)) !== 0) continue;
        clump.push([nx, ny]);
      }
      for (const [cx, cy] of clump) {
        if (out.length >= prm.remaining) {
          st.capped = true;
          break;
        }
        const ck = key(cx, cy);
        taken.add(ck);
        takenOrg.add(ck);
        anchorsOrg.add(ck);
        coverCells.add(ck);
        // mostly one kind per clump, now and then the other
        const ct = rng.chance(0.75) ? t : (types[rng.int(types.length)] as FeatureType);
        const rot = (rng.int(4) * 90) as Rotation;
        out.push({ type: ct, at: [cx, cy], size: [1, 1], rot, rotFine: (rot + rng.int(6) * 15) % 360 });
      }
    }
  }
  // ── 6. generator 3: the water is dressed as one body (sunk boulders, shallows plants, shore rock, stepping stones) ──
  if (isG3 && !st.capped) {
    const wd = dressWater(grid, {
      cells,
      inArea,
      taken: (x, y) => taken.has(key(x, y)) || doorZone.has(key(x, y)),
      seed: prm.seed,
      remaining: prm.remaining - out.length,
    });
    out.push(...wd.placements);
  }
  return { placements: out, capped: st.capped };
}
