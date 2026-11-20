/**
 * Converts the research palette (data/palette-draft.json, 125 resolved kit entries) into the bundled semantic-role
 * palettes (architecture §4.2):
 *   packages/core/data/palettes/{generic,stone_dungeon,cave,wood_town,outdoor}.json
 *   packages/core/data/palette-import-report.json     (role coverage and gaps against the plan IR vocabulary)
 *   packages/core/src/palette/bundled.ts              (generated TS copy of the palettes + data/orientation.json,
 *                                                       because core's tsconfig cannot import JSON outside src/)
 *
 * Run:  npx tsx packages/core/scripts/import-palette-draft.ts
 *
 * Layering rules:
 *   - every role a theme defines is also copied into `generic` (first theme in THEME_PRIORITY wins), so generic is
 *     the complete base kit and the last step of the fallback chain;
 *   - IR vocabulary the kits lack becomes an "alias role" in generic (`variants: []`, `fallback: <nearest role>`).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Palette, PaletteFacing, PaletteRole, PaletteVariant } from "../src/contracts/compiler";
import { FEATURE_TYPES, LINK_KINDS, MATERIALS, OPENING_KINDS, WALL_STYLES } from "../src/contracts/plan";
import { format, resolveConfig } from "prettier";
import { OBSERVED_TONES } from "../src/review/tones";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const coreDir = join(here, "..");

interface DraftEntry {
  theme: string;
  role: string;
  roleKind: string;
  uuid: string;
  name: string;
  kind: "tile" | "prop";
  folder: string;
  size: { x: number; y: number; z: number };
  footprintCells: { x: number; z: number };
  height: number;
  originAt: "minCorner" | "center" | "other";
  boundsCenter: { x: number; y: number; z: number };
  lengthAxis: "x" | "z" | "square";
}

interface MapEntry {
  /** "<draft theme>/<draft role>" */
  from: string;
  to: string;
  /** Palette to put the variant in (default: the draft theme). */
  into?: string;
  variant?: string;
  weight?: number;
  /** Make this entry an alternate of another draft entry instead of its own variant. */
  alternateOf?: string;
  footprint?: [number, number];
  facing?: PaletteFacing;
  offset?: { x?: number; y?: number; z?: number };
  /** Also add the same variant under these roles. */
  alsoAs?: string[];
  /** Make this draft entry an alternate of the first extra-asset variant of this role (palette-extra-assets.json). */
  alternateOfExtra?: string;
}

interface ExtraEntry {
  theme: string;
  to: string;
  uuid: string;
  name: string;
  kind: "tile" | "prop";
  size: { x: number; y: number; z: number };
  originAt: "minCorner" | "center" | "other";
  boundsCenter: { x: number; y: number; z: number };
  lengthAxis: "x" | "z" | "square";
  footprintCells: { x: number; z: number };
  variant?: string;
  weight?: number;
  offset?: { x?: number; y?: number; z?: number };
  facing?: PaletteFacing;
  parts?: PaletteVariant["parts"];
  stack?: PaletteVariant["stack"];
  tone?: PaletteVariant["tone"];
  hue?: string;
}

/** Research role → semantic role. Every draft entry must appear here exactly once (or in SKIPPED). */
const MAPPING: MapEntry[] = [
  // ── generic ──
  // marker.alignment comes from palette-extra-assets.json (Dungeon Pillar, easy to aim at); gravel is its alternate.
  { from: "generic/registration_marker", to: "marker.alignment", alternateOfExtra: "marker.alignment" },
  // Wall torch: origin at its back face (bounds centre z +0.166) ⇒ mounts on its S side at rot 0 (INFERRED). Raised to
  // a typical sconce height on a 2-tall wall.
  { from: "generic/torch_wall", to: "feature.torch_wall", facing: { mountsOn: "S" }, offset: { y: 1.25 } },
  { from: "generic/torch_floor", to: "feature.brazier", variant: "torch", weight: 0 },
  { from: "generic/brazier", to: "feature.brazier" },
  { from: "generic/candle", to: "feature.candelabra", variant: "candle" },
  { from: "generic/barrel", to: "feature.barrel" },
  { from: "generic/crate", to: "feature.crate" },
  { from: "generic/crate_small", to: "feature.crate", variant: "small", weight: 0.5 },
  { from: "generic/sack", to: "feature.sack" },
  { from: "generic/chest", to: "feature.chest" },
  { from: "generic/chest_treasure", to: "feature.chest", variant: "treasure", weight: 0 },
  { from: "generic/ladder", to: "link.ladder" },
  // ── stone_dungeon (Dungeon Cellar + MegaDungeon alternates) ──
  { from: "stone_dungeon/floor_1x1", to: "floor.flagstone" },
  { from: "stone_dungeon/floor_1x1_alt", to: "floor.flagstone", alternateOf: "stone_dungeon/floor_1x1" },
  { from: "stone_dungeon/floor_2x2", to: "floor.flagstone" },
  { from: "stone_dungeon/floor_2x2_alt2", to: "floor.flagstone", alternateOf: "stone_dungeon/floor_2x2" },
  { from: "stone_dungeon/floor_2x2_alt", to: "floor.flagstone", variant: "cracked", weight: 0.5 },
  { from: "stone_dungeon/wall_1", to: "wall.wall" },
  { from: "stone_dungeon/wall_1_alt", to: "wall.wall", alternateOf: "stone_dungeon/wall_1" },
  { from: "stone_dungeon/wall_2", to: "wall.wall" },
  { from: "stone_dungeon/wall_2_alt", to: "wall.wall", alternateOf: "stone_dungeon/wall_2" },
  { from: "stone_dungeon/wall_2_ruined", to: "wall.ruined" },
  { from: "stone_dungeon/corner_filler", to: "wall_post.wall" },
  {
    from: "stone_dungeon/corner_filler_alt",
    to: "wall_post.wall",
    alternateOf: "stone_dungeon/corner_filler",
  },
  { from: "stone_dungeon/doorway_arch_2", to: "opening.archway" },
  { from: "stone_dungeon/door_1", to: "opening.door", facing: { handleEnd: "W" } },
  { from: "stone_dungeon/door_2", to: "opening.double_door" },
  {
    from: "stone_dungeon/door_prison",
    to: "opening.door",
    variant: "prison",
    weight: 0,
    facing: { handleEnd: "W" },
  },
  { from: "stone_dungeon/door_portcullis_2", to: "opening.portcullis" },
  { from: "stone_dungeon/stairs", to: "link.stairs", facing: { ascendsToward: "W" } },
  { from: "stone_dungeon/stair_block", to: "link.stairs", variant: "solid", weight: 0 },
  { from: "stone_dungeon/pillar", to: "feature.pillar" },
  { from: "stone_dungeon/pillar_ruined", to: "feature.pillar", variant: "ruined", weight: 0 },
  { from: "stone_dungeon/prison_bars", to: "opening.bars", alsoAs: ["wall.iron_bars"] },
  { from: "stone_dungeon/altar", to: "feature.altar" },
  { from: "stone_dungeon/bones", to: "feature.bones" },
  { from: "stone_dungeon/skeleton", to: "feature.bones", variant: "skeleton", weight: 0.5 },
  { from: "stone_dungeon/cobweb", to: "feature.web" },
  { from: "stone_dungeon/statue", to: "feature.statue" },
  { from: "stone_dungeon/castle_pillar_prop", to: "feature.pillar", variant: "round", weight: 0 },
  // ── cave (Cavern) ──
  { from: "cave/floor_1x1", to: "floor.rock" },
  { from: "cave/floor_2x2", to: "floor.rock" },
  { from: "cave/wall_block_1", to: "wall.cave_rock" },
  { from: "cave/wall_block_2", to: "wall.cave_rock", variant: "long", weight: 0 },
  { from: "cave/wall_corner_2x2", to: "wall.cave_rock", variant: "corner", weight: 0 },
  { from: "cave/stalagmite", to: "feature.pillar" },
  { from: "cave/stalagmite_small", to: "feature.rock", variant: "stalagmite", weight: 0 },
  { from: "cave/boulder", to: "feature.boulder" },
  { from: "cave/rock_small", to: "feature.rock" },
  { from: "cave/moss_rock", to: "feature.rock", variant: "moss", weight: 0.5 },
  { from: "cave/mushrooms", to: "feature.mushroom" },
  { from: "cave/rubble", to: "feature.rubble" },
  // ── wood_town (Tavern + Rural) ──
  { from: "wood_town/floor_1x1", to: "floor.wood_plank" },
  { from: "wood_town/floor_2x2", to: "floor.wood_plank" },
  { from: "wood_town/floor_rural_1x1", to: "floor.wood_plank", variant: "rural", weight: 0 },
  { from: "wood_town/floor_rural_2x2", to: "floor.wood_plank", variant: "rural", weight: 0 },
  { from: "wood_town/wall_1", to: "wall.wall" },
  { from: "wood_town/wall_2", to: "wall.wall" },
  { from: "wood_town/wall_rural_1", to: "wall.wall", variant: "rural", weight: 0 },
  { from: "wood_town/wall_rural_2", to: "wall.wall", variant: "rural", weight: 0 },
  { from: "wood_town/wall_window_2", to: "opening.window" },
  { from: "wood_town/wall_window_2_alt", to: "opening.window", alternateOf: "wood_town/wall_window_2" },
  { from: "wood_town/corner_filler", to: "wall_post.wall" },
  { from: "wood_town/corner_filler_rural", to: "wall_post.wall", variant: "rural", weight: 0 },
  { from: "wood_town/door_1", to: "opening.door", facing: { handleEnd: "W" } },
  { from: "wood_town/door_2", to: "opening.double_door" },
  {
    from: "wood_town/door_town_1",
    to: "opening.door",
    variant: "town",
    weight: 0,
    facing: { handleEnd: "W" },
  },
  { from: "wood_town/stairs", to: "link.stairs", facing: { ascendsToward: "W" } },
  { from: "wood_town/stair_block", to: "link.stairs", variant: "solid", weight: 0 },
  {
    from: "wood_town/stairs_rural",
    to: "link.stairs",
    variant: "rural",
    weight: 0,
    facing: { ascendsToward: "W" },
  },
  { from: "wood_town/street_1x1", to: "floor.cobble" },
  { from: "wood_town/street_2x2", to: "floor.cobble" },
  { from: "wood_town/bar_counter", to: "feature.bar_counter" },
  { from: "wood_town/pillar_wood", to: "feature.pillar" },
  { from: "wood_town/table", to: "feature.table" },
  { from: "wood_town/table_round", to: "feature.round_table" },
  // VERIFIED IN GAME 2026-11-18 by the user orbiting the camera: chair front (seat side) faces N (+z) at rot 0.
  // (An earlier "S" reading of the screenshots was a misread.)
  { from: "wood_town/chair", to: "feature.chair", facing: { front: "N" } },
  { from: "wood_town/stool", to: "feature.stool" },
  { from: "wood_town/bench", to: "feature.bench" },
  // VERIFIED IN GAME 2026-11-18: Red Bed has its headboard at the S end at rot 0, so its front (foot) faces N.
  { from: "wood_town/bed", to: "feature.bed", facing: { front: "N" } },
  { from: "wood_town/bed_poor", to: "feature.bed", variant: "straw", weight: 0 },
  // VERIFIED IN GAME 2026-11-18: Bookshelf 01 shows its plank back to the S at rot 0; open shelves face N.
  { from: "wood_town/bookshelf", to: "feature.bookshelf", facing: { front: "N" } },
  { from: "wood_town/rug_2x2", to: "feature.rug", footprint: [2, 2] },
  { from: "wood_town/rug_2x1", to: "feature.rug", variant: "runner", weight: 0, footprint: [2, 1] },
  { from: "wood_town/lantern", to: "feature.candelabra", into: "generic", variant: "lantern", weight: 0 },
  {
    from: "wood_town/street_lantern",
    to: "feature.brazier",
    into: "generic",
    variant: "street_lantern",
    weight: 0,
  },
  { from: "wood_town/well", to: "feature.well" },
  { from: "wood_town/fence_wood", to: "wall.fence" },
  { from: "wood_town/fence_stone", to: "wall.low_wall" },
  { from: "wood_town/workbench", to: "feature.counter" },
  { from: "wood_town/anvil", to: "feature.anvil" },
  // ── outdoor (Nature) ──
  { from: "outdoor/grass_1x1", to: "floor.grass" },
  { from: "outdoor/grass_2x2", to: "floor.grass" },
  { from: "outdoor/grass_2x2_sparse", to: "floor.grass", variant: "sparse", weight: 0.5 },
  { from: "outdoor/dirt_1x1", to: "floor.dirt", alsoAs: ["floor.gravel"] },
  { from: "outdoor/swamp_1x1", to: "floor.swamp" },
  { from: "outdoor/swamp_2x2", to: "floor.swamp" },
  { from: "outdoor/snow_1x1", to: "floor.snow" },
  { from: "outdoor/desert_1x1", to: "floor.sand" },
  { from: "outdoor/desert_2x2", to: "floor.sand" },
  { from: "outdoor/tree", to: "feature.tree" },
  { from: "outdoor/tree_dead", to: "feature.dead_tree" },
  { from: "outdoor/tree_cypress", to: "feature.pine_tree" },
  { from: "outdoor/tree_stump", to: "feature.stump" },
  { from: "outdoor/log", to: "feature.log" },
  { from: "outdoor/bush", to: "feature.bush" },
  { from: "outdoor/bush_small", to: "feature.bush", variant: "small" },
  { from: "outdoor/bush_dead", to: "feature.bush", variant: "dead", weight: 0.3 },
  { from: "outdoor/fern", to: "feature.tall_grass", variant: "fern" },
  { from: "outdoor/reeds", to: "feature.reeds" },
  { from: "outdoor/boulder", to: "feature.boulder" },
  { from: "outdoor/rock_small", to: "feature.rock" },
  { from: "outdoor/rock_large", to: "feature.rock", variant: "large", weight: 0 },
  { from: "outdoor/cliff", to: "feature.boulder", variant: "cliff", weight: 0 },
  { from: "outdoor/gravestone", to: "feature.grave" },
];

/** Draft entries deliberately not mapped, with the reason (reported). */
const SKIPPED: Record<string, string> = {
  "generic/water_1x1":
    "tempWater does not render in game; water is the board water level and channels are floored with bed.* (2026-11-19)",
  "generic/water_2x2":
    "tempWater does not render in game; water is the board water level and channels are floored with bed.* (2026-11-19)",
  "wood_town/roof_flat_1x1": "no roofs in v1 (decisions.md #7)",
  "wood_town/roof_slope_1x1": "no roofs in v1 (decisions.md #7)",
  "wood_town/roof_corner_1x1": "no roofs in v1 (decisions.md #7)",
  "wood_town/roof_inner_corner_1x1": "no roofs in v1 (decisions.md #7)",
  "outdoor/road_2x2": "directional road tiles need path-aware tiling (not in v1); paths use floor.dirt",
  "outdoor/road_2x2_corner": "directional road tiles need path-aware tiling (not in v1)",
  "outdoor/road_2x2_t": "directional road tiles need path-aware tiling (not in v1)",
  "outdoor/road_2x2_cross": "directional road tiles need path-aware tiling (not in v1)",
};

/** Role-level settings, by exact role or prefix ("floor."). Exact entries win over prefixes. */
const ORGANIC = [
  "tree",
  "dead_tree",
  "pine_tree",
  "stump",
  "log",
  "bush",
  "rock",
  "boulder",
  "mushroom",
  "tall_grass",
  "reeds",
  "rubble",
  "bones",
  "web",
  "flowers",
  // caves and set dressing (2026-11-19). Wall-mounted roots_wall/vines stay "facing" so they turn to their wall.
  "stalagmite",
  "stalactite",
  "rock_formation",
  "cave_in",
  "crystal",
  "giant_mushroom",
  "root",
  "root_large",
  "tree_large",
  "skull_pile",
  "cave_column",
  // theme-neutral natural slots: seeded rotation (inherit) so no two pieces line up
  "formation",
  "cluster_tall",
  "undergrowth",
  "ground_cover",
  "edge_dressing",
  "small_detail",
  "bank_dressing",
];
function roleSettings(role: string): Partial<PaletteRole> {
  const [prefix, name = ""] = role.split(".") as [string, string?];
  switch (prefix) {
    case "floor":
      return { rotation: "random90", greedyTiling: true };
    case "fill":
      return { rotation: "fixed" };
    case "wall":
      if (name === "cave_rock")
        return { mount: "full-cell", rotation: "fixed", height: 2, greedyTiling: false };
      if (name === "parapet")
        // castle wall 1x1 half: a 1-tall, 0.5-deep stone run for bridge and platform edges
        return { mount: "half-cell", rotation: "facing", height: 1, greedyTiling: true };
      if (name === "fence" || name === "low_wall" || name === "railing" || name === "railing_stone")
        return { mount: "edge-center", rotation: "facing", greedyTiling: true };
      if (name === "ruined")
        return {
          mount: "half-cell",
          rotation: "facing",
          height: 2,
          greedyTiling: true,
          fallback: "wall.wall",
        };
      return { mount: "half-cell", rotation: "facing", height: 2, greedyTiling: true };
    case "wall_post":
      return { rotation: "fixed", height: 2 };
    case "opening":
      if (name === "portcullis")
        return { mount: "half-cell", rotation: "facing", height: 2, fallback: "opening.bars" };
      return { mount: "half-cell", rotation: "facing", height: 2 };
    case "link":
      return { rotation: "facing" };
    case "ledge":
      // Thin (0.5-deep) face pieces along an edge where the floor drops (cliff/chasm/lava edges), stacked downwards.
      return { mount: "half-cell", rotation: "facing", height: 2, greedyTiling: true };
    case "cliff":
      // Full-cell rock blocks stacked for tall vertical faces (cliff.rock), or the cliff band's rocks (cliff.formation_face / cliff.formation_crest, natural-rock themes only).
      return name === "face"
        ? { rotation: "random90" }
        : { mount: "full-cell", rotation: "fixed", height: 2, greedyTiling: false };
    case "kerb":
    case "trim":
      // 0.25-tall kerb along a platform edge, on the floor top of the upper cell
      return { mount: "half-cell", rotation: "facing", greedyTiling: true };
    case "bridge":
      return { rotation: "facing" };
    case "pier":
      // bridge piers: stacked from the ground under the deck up to it (terrain: pier.<material> → pier.default)
      return { rotation: "fixed", greedyTiling: false };
    case "step":
      // a 0.5 rise: one course of the lower floor, laid on the lower cell
      return { rotation: "facing" };
    case "stairs":
    case "stairs_block":
    case "ramp":
      return { rotation: "facing" };
    case "lintel":
      // Placed on top of each door leaf of this kit (its doors are visually shorter than its walls).
      return { mount: "half-cell", rotation: "facing" };
    case "marker":
      return { rotation: "fixed" };
    case "feature":
      return ORGANIC.includes(name) ? { rotation: "inherit" } : { rotation: "facing" };
    default:
      return {};
  }
}

/** Alias roles added to generic (only when no theme defines the role). */
const ALIASES: Record<string, string> = {
  "floor.stone_tile": "floor.flagstone",
  "floor.marble": "floor.stone_tile",
  "floor.brick": "floor.flagstone",
  "floor.carpet": "floor.wood_plank",
  "floor.mud": "floor.swamp",
  "floor.ice": "floor.snow",
  "floor.water_deep": "floor.water_shallow",
  "floor.water_shallow": "bed.default",
  "floor.lava": "floor.rock",
  "floor.bridge_wood": "floor.wood_plank",
  "wall.stone": "wall.wall",
  "wall.brick": "wall.stone",
  "wall.wood": "wall.wall",
  "wall.plaster": "wall.stone",
  "wall.palisade": "wall.wood",
  "wall.hedge": "wall.fence",
  "wall.railing": "wall.fence",
  "opening.locked_door": "opening.door",
  "opening.secret_door": "wall.wall",
  "opening.arrow_slit": "opening.window",
  "link.ramp": "link.stairs",
  // no spiral staircase asset in the catalog: a ladder in the footprint still connects the levels
  "link.spiral_stairs": "link.ladder",
  "feature.bunk_bed": "feature.bed",
  "feature.wardrobe": "feature.bookshelf",
  "feature.desk": "feature.table",
  "feature.shelf": "feature.bookshelf",
  "feature.throne": "feature.chair",
  "feature.cauldron": "feature.barrel",
  "feature.forge": "feature.anvil",
  "feature.tomb": "feature.sarcophagus",
  "feature.debris": "feature.rubble",
  "feature.flowers": "feature.tall_grass",
  "feature.standing_stone": "feature.boulder",
  // no catalog asset (2026-11-19 search): nearest stand-ins so nothing the model asks for vanishes from the slab
  "feature.chandelier": "feature.candelabra",
  "feature.pool": "feature.fountain",
  "feature.fence_post": "feature.signpost",
  // cliff band pieces resolve through the theme's formation roles; a theme without them places nothing (its cliff
  // keeps the built face)
  "feature.cliff_face": "cliff.formation_face",
  "feature.cliff_crest": "cliff.formation_crest",
};

const THEMES: Array<{
  id: string;
  name: string;
  description: string;
  extends?: string;
  defaults: Palette["defaults"];
}> = [
  {
    id: "generic",
    name: "Generic (base kit)",
    description:
      "Base kit and last fallback step: shared props plus a copy of every theme role (first theme wins).",
    defaults: { floor: "flagstone", wallStyle: "wall" },
  },
  {
    id: "stone_dungeon",
    name: "Stone dungeon",
    description: "Dungeon Cellar kit with MegaDungeon alternates.",
    extends: "generic",
    defaults: { floor: "flagstone", wallStyle: "wall" },
  },
  {
    id: "wood_town",
    name: "Wooden town",
    description: "Tavern and Rural kits: plank floors, thin wooden walls, peasant doors, furniture.",
    extends: "generic",
    defaults: { floor: "wood_plank", wallStyle: "wall" },
  },
  {
    id: "cave",
    name: "Cave",
    description:
      "Cavern kit: varied rock floors, full-cell rock wall blocks, thin rock walls, lava, and cave dressing (stalagmites, crystals, roots, great trees).",
    extends: "generic",
    defaults: { floor: "rock", wallStyle: "cave_rock", caveFloor: "rock" },
  },
  {
    id: "outdoor",
    name: "Outdoor",
    description: "Nature kit: grass, dirt, swamp, snow, sand, single-piece trees and rocks.",
    extends: "generic",
    defaults: { floor: "grass", wallStyle: "fence" },
  },
  {
    id: "forest",
    name: "Forest",
    description:
      "Woodland on top of the outdoor kit: pines and trees in tight groups, ferns and shrubs beneath, mossy boulders.",
    extends: "outdoor",
    defaults: { floor: "grass", wallStyle: "hedge" },
  },
  {
    id: "city",
    name: "Modern city",
    description:
      "A modern street from the Cyberpunk and Sci-fi pack: road and pavement tiles, concrete and brick, street lamps, bins, signs, litter, street trees. It has one ordinary car, a yellow taxi (about 1.3×2.6 tiles): a vehicle feature becomes that taxi, and no bus, van or truck exists; ask for fewer, well-parked cars rather than many kinds.",
    extends: "generic",
    defaults: { floor: "concrete", wallStyle: "wall" },
  },
];
/** Order in which theme roles are copied into generic. */
const THEME_PRIORITY = ["stone_dungeon", "wood_town", "cave", "outdoor", "forest", "city"];
/** Each theme's fill.default is its 1×1 floor tile stacked in 0.5 courses. */
const FILL_FROM: Record<string, string> = {
  stone_dungeon: "stone_dungeon/floor_1x1",
  wood_town: "wood_town/floor_1x1",
  cave: "cave/floor_1x1",
  outdoor: "outdoor/grass_1x1",
  forest: "outdoor/grass_1x1",
};

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

function geomOf(e: DraftEntry): PaletteVariant["geom"] {
  return {
    size: { x: r4(e.size.x), y: r4(e.size.y), z: r4(e.size.z) },
    originAt: e.originAt,
    boundsCenter: { x: r4(e.boundsCenter.x), y: r4(e.boundsCenter.y), z: r4(e.boundsCenter.z) },
    lengthAxis: e.lengthAxis,
  };
}

function footprintOf(e: DraftEntry): [number, number] {
  if (e.kind === "tile") return [e.footprintCells.x, e.footprintCells.z];
  return [Math.max(1, Math.round(e.size.x)), Math.max(1, Math.round(e.size.z))];
}

async function main(): Promise<void> {
  const draft = JSON.parse(readFileSync(join(repo, "data", "palette-draft.json"), "utf8")) as {
    entries: DraftEntry[];
  };
  const byKey = new Map(draft.entries.map((e) => [`${e.theme}/${e.role}`, e]));
  const problems: string[] = [];
  const mappedKeys = new Set(MAPPING.map((m) => m.from));
  for (const k of byKey.keys()) {
    if (!mappedKeys.has(k) && !(k in SKIPPED))
      problems.push(`draft entry ${k} is neither mapped nor skipped`);
  }
  for (const m of MAPPING)
    if (!byKey.has(m.from)) problems.push(`mapping refers to unknown draft entry ${m.from}`);
  if (problems.length) throw new Error(problems.join("\n"));

  const roles: Record<string, Record<string, PaletteRole>> = Object.fromEntries(
    THEMES.map((t) => [t.id, {}]),
  );
  const variantFor = (m: MapEntry, e: DraftEntry): PaletteVariant => {
    const v: PaletteVariant = {
      asset: e.uuid,
      name: e.name,
      geom: geomOf(e),
      footprint: m.footprint ?? footprintOf(e),
    };
    if (m.variant !== undefined) v.variant = m.variant;
    if (m.weight !== undefined) v.weight = m.weight;
    if (m.facing) v.facing = m.facing;
    if (m.offset) v.offset = m.offset;
    return v;
  };
  const variantIndex = new Map<string, PaletteVariant>();
  const addVariant = (theme: string, role: string, v: PaletteVariant): void => {
    const t = roles[theme];
    if (!t) throw new Error(`unknown theme ${theme}`);
    t[role] ??= { ...roleSettings(role), variants: [] };
    t[role].variants.push(v);
  };
  // Curated assets beyond the draft (catalog-copied geometry), added first so they are each role's preferred variant.
  const extras = (
    JSON.parse(readFileSync(join(here, "palette-extra-assets.json"), "utf8")) as { entries: ExtraEntry[] }
  ).entries;
  for (const x of extras) {
    const v: PaletteVariant = {
      asset: x.uuid,
      name: x.name,
      geom: { size: x.size, originAt: x.originAt, boundsCenter: x.boundsCenter, lengthAxis: x.lengthAxis },
      footprint:
        x.kind === "tile"
          ? [x.footprintCells.x, x.footprintCells.z]
          : [Math.max(1, Math.round(x.size.x)), Math.max(1, Math.round(x.size.z))],
    };
    if (x.variant !== undefined) v.variant = x.variant;
    if (x.weight !== undefined) v.weight = x.weight;
    if (x.offset) v.offset = x.offset;
    if (x.facing) v.facing = x.facing;
    if (x.parts) v.parts = x.parts;
    if (x.stack) v.stack = x.stack;
    if (x.tone) v.tone = x.tone;
    if (x.hue) v.hue = x.hue;
    addVariant(x.theme, x.to, v);
  }
  for (const m of MAPPING.filter((x) => !x.alternateOf && !x.alternateOfExtra)) {
    const e = byKey.get(m.from);
    if (!e) continue;
    const v = variantFor(m, e);
    variantIndex.set(m.from, v);
    addVariant(m.into ?? e.theme, m.to, v);
    for (const extra of m.alsoAs ?? []) addVariant(m.into ?? e.theme, extra, structuredClone(v));
  }
  for (const m of MAPPING.filter((x) => x.alternateOf ?? x.alternateOfExtra)) {
    const e = byKey.get(m.from);
    const target = m.alternateOfExtra
      ? roles[e?.theme ?? ""]?.[m.alternateOfExtra]?.variants[0]
      : variantIndex.get(m.alternateOf ?? "");
    if (!e || !target) throw new Error(`bad alternate ${m.from}`);
    (target.alternates ??= []).push(e.uuid);
    (target.alternateGeom ??= {})[e.uuid] = geomOf(e);
  }
  for (const [theme, key] of Object.entries(FILL_FROM)) {
    const e = byKey.get(key);
    if (!e) throw new Error(`fill source ${key} missing`);
    // a curated fill (palette-extra-assets.json) wins: outdoors the fill is earth, not the grass tile
    if (roles[theme]?.["fill.default"]) continue;
    addVariant(theme, "fill.default", {
      asset: e.uuid,
      name: e.name,
      geom: geomOf(e),
      footprint: [1, 1],
      stack: { unitHeight: 0.5 },
    });
  }
  // Union of theme roles into generic (first theme in priority wins).
  const generic = roles["generic"] ?? {};
  for (const theme of THEME_PRIORITY) {
    for (const [role, def] of Object.entries(roles[theme] ?? {})) {
      // lintels are kit-specific: a stone lintel must not reach wooden doors through generic
      // lintels are kit-specific, the cliff formation roles belong only to themes with natural rock (a city or a
      // dungeon keeps its built face), and the crenel remnant only to themes with castles: none is copied into generic
      if (
        !generic[role] &&
        !role.startsWith("lintel.") &&
        !role.startsWith("cliff.formation_") &&
        role !== "crenel.default"
      )
        generic[role] = structuredClone(def);
    }
  }
  for (const [role, target] of Object.entries(ALIASES)) {
    if (!generic[role]) generic[role] = { ...roleSettings(role), variants: [], fallback: target };
  }

  const sortRoles = (r: Record<string, PaletteRole>): Record<string, PaletteRole> =>
    Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const palettes: Palette[] = THEMES.map((t) => {
    const p: Palette = {
      schema: "slabyrinth/palette@1",
      id: t.id,
      name: t.name,
      description: t.description,
      defaults: t.defaults,
      roles: sortRoles(roles[t.id] ?? {}),
      source: { generatedBy: "packages/core/scripts/import-palette-draft.ts from data/palette-draft.json" },
    };
    if (t.extends) p.extends = t.extends;
    return p;
  });

  // ── coverage report against the IR vocabulary ──
  const vocab: string[] = [
    ...MATERIALS.map((m) => `floor.${m}`),
    ...WALL_STYLES.map((s) => `wall.${s}`),
    ...OPENING_KINDS.filter((k) => k !== "open").map((k) => `opening.${k}`),
    ...LINK_KINDS.filter((k) => k !== "pit_drop").map((k) => `link.${k}`),
    ...FEATURE_TYPES.filter((f) => f !== "custom").map((f) => `feature.${f}`),
  ];
  const pmap = Object.fromEntries(palettes.map((p) => [p.id, p]));
  const lookup = (theme: string, role: string): PaletteRole | undefined => {
    let cur: string | undefined = theme;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const d: PaletteRole | undefined = pmap[cur]?.roles[role];
      if (d) return d;
      cur = pmap[cur]?.extends;
    }
    return pmap["generic"]?.roles[role];
  };
  const classify = (
    theme: string,
    role: string,
  ): { status: "direct" | "alias" | "missing"; via?: string } => {
    let cur = role;
    const path: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = lookup(theme, cur);
      if (!d) return { status: "missing" };
      if (d.variants.length > 0)
        return path.length ? { status: "alias", via: [...path, cur].join(" → ") } : { status: "direct" };
      if (!d.fallback) return { status: "missing" };
      path.push(cur);
      cur = d.fallback;
    }
    return { status: "missing" };
  };
  const coverage: Record<string, Record<string, string>> = {};
  const counts: Record<string, { direct: number; alias: number; missing: number }> = {};
  for (const t of THEMES) {
    const cov: Record<string, string> = {};
    const cnt = { direct: 0, alias: 0, missing: 0 };
    for (const role of vocab) {
      const c = classify(t.id, role);
      cnt[c.status] += 1;
      cov[role] = c.status === "alias" ? `alias: ${c.via ?? ""}` : c.status;
    }
    coverage[t.id] = cov;
    counts[t.id] = cnt;
  }
  const missing = vocab.filter((r) => classify("generic", r).status === "missing");
  const aliased = vocab.filter((r) => classify("generic", r).status === "alias");
  const report = {
    generatedBy: "packages/core/scripts/import-palette-draft.ts",
    draftEntries: draft.entries.length,
    mapped: MAPPING.length,
    skipped: SKIPPED,
    vocabularyRoles: vocab.length,
    countsPerTheme: counts,
    missingEverywhere: missing,
    aliasedInGeneric: Object.fromEntries(aliased.map((r) => [r, coverage["generic"]?.[r] ?? ""])),
    notes: [
      "missing roles are dropped with a role_missing warning (aggregated per role and level); custom features use catalog search",
      "fill.<material> is resolved by the realizer as fill.<material> → fill.default; wall_post.<style> as wall_post.<style> → wall_post.wall",
      "unverified facings: fronts of props other than chair/bookshelf/bed (orientation.json defaultFacing.feature.front = N, adopted from those three verified assets), wall torch mountsOn S, Tavern/Rural stairs ascendsToward W, non-dungeon door handleEnd W",
    ],
    coverage,
  };

  // tones seen in game (review/tones.ts) on rows that carry none of their own
  for (const p of palettes)
    for (const def of Object.values(p.roles))
      for (const v of def.variants) {
        const seen = OBSERVED_TONES[v.asset.toLowerCase()];
        if (seen && v.tone === undefined) {
          v.tone = seen.tone;
          if (seen.hue !== undefined && v.hue === undefined) v.hue = seen.hue;
        }
      }

  const outDir = join(coreDir, "data", "palettes");
  mkdirSync(outDir, { recursive: true });
  for (const p of palettes) writeFileSync(join(outDir, `${p.id}.json`), JSON.stringify(p, null, 2) + "\n");
  writeFileSync(join(coreDir, "data", "palette-import-report.json"), JSON.stringify(report, null, 2) + "\n");
  const orientation = JSON.parse(readFileSync(join(coreDir, "data", "orientation.json"), "utf8")) as unknown;
  const ts =
    "/**\n * GENERATED by packages/core/scripts/import-palette-draft.ts — do not edit by hand.\n" +
    " * TypeScript copy of packages/core/data/palettes/*.json and packages/core/data/orientation.json (core's tsconfig\n" +
    " * cannot import JSON outside src/). A unit test checks that it matches the JSON files.\n */\n" +
    `export const BUNDLED_PALETTES: readonly unknown[] = ${JSON.stringify(palettes)};\n\n` +
    `export const BUNDLED_ORIENTATION: unknown = ${JSON.stringify(orientation)};\n`;
  const bundledPath = join(coreDir, "src", "palette", "bundled.ts");
  const prettierOptions = (await resolveConfig(bundledPath)) ?? {};
  writeFileSync(bundledPath, await format(ts, { ...prettierOptions, filepath: bundledPath }));

  process.stdout.write(
    `Wrote ${palettes.length} palettes (${palettes.map((p) => `${p.id}: ${Object.keys(p.roles).length} roles`).join(", ")})\n` +
      `IR vocabulary ${vocab.length} roles; generic: ${JSON.stringify(counts["generic"])}\n` +
      `Missing everywhere (${missing.length}): ${missing.join(", ")}\n`,
  );
}

await main();
