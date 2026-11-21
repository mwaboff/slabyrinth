/**
 * Slabyrinth — Map Plan IR (intermediate representation), schema "slabyrinth/plan@1".
 *
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/contracts/plan.ts.
 * Changes require architect sign-off and a schema version bump if not backward compatible.
 *
 * Coordinate conventions (see docs/architecture.md §2.2):
 *  - One cell = one TaleSpire tile = 5 ft.
 *  - Plan space is a single global 2D integer grid shared by ALL levels:
 *      x grows EAST, y grows SOUTH (screen convention, origin top-left).
 *  - "Cell (x,y)" covers the unit square [x, x+1) × [y, y+1).
 *  - "Vertex (x,y)" is the grid corner at the top-left of cell (x,y). Polygons and wall
 *    runs use vertex coordinates; areas/features use cell coordinates.
 *  - Heights are in tiles (1.0 = 5 ft) and MUST be multiples of 0.25 (TaleSpire vertical snap).
 *  - The compiler maps plan (x, y, height) → TaleSpire (x, up, z) with north = +z (§4.4).
 *
 * All ids are plan-wide unique across every element kind (levels, areas, openings, wall runs,
 * features, terrain ops, links, labels). Ids are chosen by the author (model or user) and are
 * stable across edits.
 */

export const PLAN_SCHEMA = "slabyrinth/plan@1" as const;
/**
 * Version of the deterministic generators and resolution rules (blob, cave, noise, scatter, dress, routing,
 * terrain layering). New plans get the current version; a plan keeps the version it was created with, so saved
 * maps resolve exactly as before (architecture §2.7).
 *  1: the original rules.
 *  2: a `height` terrain op with layer "under" sets the height of EVERY cell in its shape (rock included), so the
 *     areas that later open those cells inherit it unless they set their own floorHeight. In version 1 such an op
 *     only touched cells that were already open, which on a solid base is none of them.
 *     Released in 0.1.2 and frozen since (golden tests in test/golden/generator2 pin it).
 *  3: cliffs, cave walls, growth, floor openings, stalls and overhead lines, trades. Released in 0.2.0 and
 *     frozen since (golden tests in test/golden/generator3 pin it).
 *  4: unreleased, open for new work. Until behaviour is gated on it, it resolves exactly like 3.
 *     Gate new behaviour with `generatorAtLeast(plan, 4)` (plan/generator.ts); every `>= 3` rule stays on for 4.
 */
export const GENERATOR_VERSION = 4 as const;
/** Generator versions a reader accepts. */
export type GeneratorVersion = 1 | 2 | 3 | 4;
export const GENERATOR_VERSIONS: readonly GeneratorVersion[] = [1, 2, 3, 4];

// ───────────────────────────── primitives ─────────────────────────────

/** /^[a-z][a-z0-9_]{0,31}$/ — unique plan-wide. */
export type Id = string;
export type LevelId = Id;
export type AreaId = Id;
export type ElementId = Id;

/** Integer pair. Cell coordinates unless the field says "vertex". */
export type Vec2 = readonly [x: number, y: number];
export type Side = "N" | "E" | "S" | "W";
export type Rotation = 0 | 90 | 180 | 270;
/** Tiles; multiple of 0.25. */
export type Height = number;
/** Unsigned 32-bit integer. */
export type Seed = number;

/** Theme id; must name a palette theme known to the installed palette catalog (validation: warning + fallback). */
export type ThemeId = string;

export type MapKind =
  | "dungeon" | "cave" | "building" | "tower" | "town" | "outdoor" | "mixed";

/** Surface materials (what a cell's floor/ground is made of). Palette maps each to assets via role `floor.<material>`. */
export const MATERIALS = [
  "flagstone", "stone_tile", "marble", "brick", "cobble", "wood_plank", "carpet",
  "rock", "dirt", "grass", "sand", "gravel", "mud", "snow", "ice", "swamp",
  "water_shallow", "water_deep", "lava", "bridge_wood",
  "asphalt", "concrete",   // appended 2026-11-20 (roads and pavements; any theme maps them through its palette)
] as const;
export type Material = (typeof MATERIALS)[number];

export const WALL_STYLES = [
  "wall",        // theme default wall
  "stone", "brick", "wood", "cave_rock", "plaster",
  "palisade", "fence", "hedge", "low_wall", "railing", "iron_bars", "ruined",
  "railing_stone",   // stone parapet (bridges, balconies); appended 2026-11-19
  "concrete", "metal", "panel", // modern building walls (concrete, metal sheet, white panel); appended 2026-11-20
  "marble",      // buff dressed stone (civic, banks); appended 2026-11-20
  "dark_stone", "timber", // dark dressed stone; half-timbered panels (wizard tower treatments); appended 2026-11-20
] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

export const OPENING_KINDS = [
  "door", "double_door", "locked_door", "secret_door", "portcullis",
  "archway",   // framed opening, no leaf
  "open",      // simply removes the wall segment
  "window", "arrow_slit", "bars",
] as const;
export type OpeningKind = (typeof OPENING_KINDS)[number];

export const LINK_KINDS = ["stairs", "spiral_stairs", "ladder", "ramp", "trapdoor", "pit_drop"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * Closed catalog of semantic feature types. Palette maps each to assets via role `feature.<type>`.
 * "custom" requires `hint` and is resolved by palette keyword search (warning if unresolved).
 */
export const FEATURE_TYPES = [
  // furniture
  "table", "round_table", "chair", "bench", "stool", "bed", "bunk_bed", "wardrobe", "bookshelf",
  "desk", "chest", "barrel", "crate", "sack", "shelf", "counter", "bar_counter", "throne",
  "rug", "cauldron", "anvil", "forge", "weapon_rack", "armor_stand", "cage", "stocks",
  // architecture / dressing
  "pillar", "statue", "altar", "fountain", "well", "brazier", "torch_wall", "candelabra",
  "banner_wall", "painting_wall", "sarcophagus", "coffin", "tomb", "bones", "rubble",
  "web", "debris", "pool", "lever", "trap", "trap_plate", "chandelier",
  // outdoor
  "tree", "dead_tree", "pine_tree", "bush", "rock", "boulder", "stump", "log", "mushroom",
  "flowers", "tall_grass", "reeds", "campfire", "tent", "cart", "wagon", "fence_post",
  "signpost", "standing_stone", "grave",
  // caves and set dressing (additive, 2026-11-19)
  "stalagmite", "stalactite", "rock_formation", "cave_in", "crystal", "giant_mushroom",
  "root", "root_large", "roots_wall", "vines", "tree_large",
  // ritual, encounter and lights (additive, 2026-11-19)
  "candles", "skull_pile", "spawn_point", "torch_floor", "lantern", "magic_fire", "lava_glow", "fire_pit",
  // tall pieces, mining and hanging dressing (additive, 2026-11-19 round 2)
  "monolith", "cave_column", "statue_large", "mine_cart", "rails", "mine_support", "chains",
  // theme-neutral slots (additive, 2026-11-19): each theme's palette decides what fills them
  "landmark", "tall_marker", "formation", "cluster_tall", "undergrowth", "ground_cover",
  "accent_light", "edge_dressing", "small_detail", "wall_dressing",
  // water's edge (additive, 2026-11-19 round 3)
  "bank_dressing", "jetty",
  // built places (additive, 2026-11-20 city street): a vehicle parked along a road edge (a cart or wagon in a
  // medieval town, a car or taxi in a modern one), seating (a bench, a log, a picnic table), signage on a frontage
  "vehicle", "seating", "signage",
  // cliffs as rock bands (additive, 2026-11-20): a long low face rock and a rounded crest boulder
  // (palette roles cliff.formation_face / cliff.formation_crest; themes without natural rock keep a built face)
  "cliff_face", "cliff_crest",
  // markets (additive, generator 3): a stall by kind of goods (variant), small goods standing on a stall or table,
  // and the pieces of an overhead line (the line itself is Level.lines; these are what it resolves to)
  "stall", "goods", "overhead", "line_post",
  // interiors (additive, generator 4): small things the room recipes stand on tables, counters, desks and shelves
  // (variant = the family: table, study, store, tools, shelf), and a wall-mounted shelf plank they stand on
  "clutter", "shelf_line",
  "custom",
] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const DRESS_PRESETS = [
  "tavern", "library", "barracks", "bedroom", "kitchen", "storeroom", "throne_room",
  "shrine", "crypt", "prison", "forge", "laboratory", "treasury", "ruin", "camp",
  // composed set pieces (additive, 2026-11-19): authored groups, not weighted scatter
  "ritual_circle", "overgrown", "cavern", "collapse", "crystal_grotto", "campsite",
  "shrine_ruin", "bone_pit", "mine_works", "mushroom_grove", "barricade",
  "natural_clusters", "woodland", "forest", "dense_forest",
  // built places (additive, 2026-11-20): kerb-side rhythm on a street, a service alley, a square
  "street", "alley", "plaza",
] as const;
export type DressPreset = (typeof DRESS_PRESETS)[number];

export type AreaKind =
  | "room"        // built interior: floor + walls (default walls "auto")
  | "corridor"    // built interior passage (default walls "auto")
  | "cave"        // natural interior: rock floor, cave_rock walls (default walls "auto")
  | "building"    // footprint of a structure in an outdoor/town map (default walls "auto")
  | "courtyard"   // built exterior floor, no walls of its own (default walls "perimeter")
  | "zone"        // semantic only: never changes cells' material/walls; used for key/notes/hit-test
  /**
   * A walkable deck spanning a drop (chasm, river, pit): open air underneath (nothing is filled below it), the floor
   * beneath stays where it was, railings on the edges that face the drop. Deck height = floorHeight, or the height
   * of the highest floor it touches (its ends). Never gets area walls (default walls "none"); no automatic key.
   */
  | "bridge";

/**
 * Wall generation on an area's boundary edges (§2.4 wall rule):
 *  - "auto":      wall on every boundary edge (toward non-open cells AND toward other areas' cells)
 *  - "perimeter": wall only toward non-open cells (void/solid); open toward neighbouring areas
 *  - "none":      never demands a wall
 * An edge between two different open regions gets a wall iff at least one side is "auto".
 */
export type WallMode = "auto" | "perimeter" | "none";

// ───────────────────────────── shapes ─────────────────────────────

/** Cell-set shapes. Rasterization rule: a cell is inside iff its CENTER (x+0.5, y+0.5) is inside, unless stated. */
export type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number }
  /** Vertex coordinates; simple polygon (may be non-orthogonal); even-odd fill; 3..64 points. */
  | { type: "polygon"; points: Vec2[] }
  /** Center in cell units (may be .5); radius in cells. */
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  /** Organic blob: circle perturbed by seeded radial noise; roughness 0..1. Always 4-connected. */
  | { type: "blob"; cx: number; cy: number; r: number; roughness?: number; seed?: Seed }
  /** Cellular-automaton cave inside the rect; fill 0.3..0.7 (default 0.45), steps 0..8 (default 4). Largest region kept; always 4-connected. */
  | { type: "cave"; x: number; y: number; w: number; h: number; fill?: number; steps?: number; seed?: Seed }
  /** Explicit mask: rows of '#' (in) / '.' (out), top-left at (x,y); max 64×64. */
  | { type: "cells"; x: number; y: number; rows: string[] }
  /** Thick polyline through cell centers; consecutive points must be axis-aligned; width 1..5 cells. */
  | { type: "path"; points: Vec2[]; width?: number }
  /**
   * Corridor router: L-shaped path between two endpoints. Endpoint = an area id (uses that area's
   * anchor cell, §2.5) or explicit cell. bend "hv" = horizontal leg first. Only claims cells not owned
   * by other areas. Auto-creates openings of `openings` kind where it meets each endpoint area.
   */
  | {
      type: "route";
      from: AreaId | Vec2;
      to: AreaId | Vec2;
      width?: 1 | 2 | 3;
      bend?: "hv" | "vh";
      openings?: OpeningKind;
    };

// ───────────────────────────── elements ─────────────────────────────

export interface Area {
  id: AreaId;
  kind: AreaKind;
  name?: string;              // ≤ 80 chars; shown in room key
  /**
   * Room-key number/label shown on the map, e.g. "4", "A3". Unique PLAN-wide. When an area of kind
   * room/cave/building/courtyard is added without a key, applyOps assigns the next free integer
   * (max numeric key + 1), so numbering continues across levels and stays stable across versions.
   * Corridors/zones get no automatic key. A "renumber" op compacts numbers on request: the entry level
   * first (plan.entryLevel, else the level whose elevation is nearest 0), then the levels above it in
   * ascending order, then the levels below it in descending order, so room 1 is where the party starts.
   */
  key?: string;               // ≤ 8 chars
  /** Where the key badge is drawn (cell); default = resolved anchor. */
  labelAt?: Vec2;
  shape: Shape;
  /**
   * Omitted: theme default for room/corridor/cave/building/courtyard; "keep underlying" for zone. "none" = hole/chasm (open, no floor).
   * Generator 4, a room in a built interior (level base solid): a floor equal to the theme's default floor counts as
   * "no preference", like an omitted one, and the room takes the floor of its purpose (the model writes the default on
   * every room, which says nothing); so such a room cannot ask for exactly the default floor. Any other floor is kept.
   */
  floor?: Material | "none";
  /** Floor offset relative to level elevation, tiles, −4..+4, multiple of 0.25 (dais +0.5, pit −1). Omitted = keep the underlying height. */
  floorHeight?: Height;
  walls?: WallMode;           // default per AreaKind (see AreaKind docs)
  wallStyle?: WallStyle;      // default "wall" (cave: "cave_rock")
  wallHeight?: Height;        // default level.wallHeight; 0.25..8
  theme?: ThemeId;
  notes?: string;             // GM notes; ≤ 2000 chars; never compiled
  readAloud?: string;         // boxed text for players; ≤ 1500 chars
  encounter?: string;         // system-flavoured encounter line(s); ≤ 1000 chars
  tags?: string[];            // ≤ 8 tags, each ≤ 24 chars
  /** kind "bridge" only: wall style of the railings on the edges that face a drop (default "low_wall"); "none" = no railings. */
  railing?: WallStyle | "none";
  /** kind "bridge" only: deck cells that have fallen away (holes; the floor below shows through). ≤ 64. */
  broken?: Vec2[];
  /** kind "bridge" only: 0..0.6, fraction of deck cells crumbled away, chosen deterministically so a way across always remains. */
  crumble?: number;
  /** kind "bridge" only: the bridge's build (see BridgeSpan). Default "arch" for stone decks, "plank" for wood. */
  span?: BridgeSpan;
  /** kind "bridge" only: how far the middle of the deck rises above its ends, tiles 0..2 (default by span). */
  arch?: number;
}

/**
 * How a bridge is built (generator 2):
 *  - "arch":    stone; the deck rises toward the middle in 0.25 steps, stone piers under it, stone parapet.
 *  - "flat":    a level deck, piers under long spans, parapet or railing.
 *  - "plank":   wooden planks, rope-style railing, a slight sag in the middle, no piers.
 *  - "natural": a natural rock span or fallen column: rough rock deck, no railing, a slight hump, no piers.
 */
export type BridgeSpan = "arch" | "flat" | "plank" | "natural";

/** Door/window/arch on cell edges. Exactly one of `between` or `at` is required. */
export interface Opening {
  id: ElementId;
  kind: OpeningKind;
  /**
   * Two areas sharing a boundary; "@outside" may stand for "any non-area cell" (exterior door).
   * Placed on the shared boundary edge run at `position` (0..1 along the canonical ordering, default 0.5).
   */
  between?: [AreaId | "@outside", AreaId | "@outside"];
  position?: number;
  /** Explicit: the `side` edge of cell (x,y). */
  at?: { x: number; y: number; side: Side };
  /** Edges spanned, extending east (horizontal edge) or south (vertical edge) from the anchor edge. Default 1 ("double_door" default 2). */
  width?: 1 | 2 | 3;
  label?: string;
  notes?: string;
  /** Hidden in the player view (secret doors are always GM-only). */
  gmOnly?: boolean;
}

/** Explicit wall additions/removals along grid VERTICES; consecutive points axis-aligned; 2..64 points. */
export interface WallRun {
  id: ElementId;
  op: "add" | "remove";
  points: Vec2[];
  style?: WallStyle;
  height?: Height;
}

export interface Feature {
  id: ElementId;
  type: FeatureType;
  /** Anchor cell (top-left of footprint). */
  at: Vec2;
  /** Facing; 0 = "front faces south/toward viewer", clockwise. Default 0. */
  rot?: Rotation;
  /** Footprint in cells before rotation; default from palette role (usually [1,1]). */
  size?: readonly [w: number, h: number];
  /** Wall-mounted: attach to this edge of the anchor cell (torch_wall, banner_wall, painting_wall…). */
  wall?: Side;
  /** Extra vertical offset in tiles on top of the cell floor height (e.g. item on a table). */
  lift?: Height;
  /** Palette variant name hint, e.g. "ornate", "broken". Unknown variants fall back to default (info). */
  variant?: string;
  /** Required when type === "custom": free-text asset hint, e.g. "giant mushroom". */
  hint?: string;
  label?: string;
  notes?: string;
  /** Hidden in the player view (traps default true). */
  gmOnly?: boolean;
}

/**
 * Terrain layer: "under" ops run BEFORE areas (areas override them — e.g. outdoor ground, roads);
 * "over" ops run AFTER areas (e.g. water flooding a cave, a dais inside a chapel). Default "under".
 * paint/noise/path/height only affect OPEN cells; they never open rock or void.
 */
export type TerrainLayer = "under" | "over";

/** Deterministic terrain/generation operations, applied in array order within their layer (§2.5 resolution order). */
export type TerrainOp =
  | { id: ElementId; op: "paint"; shape: Shape; material: Material; layer?: TerrainLayer }
  | { id: ElementId; op: "height"; shape: Shape; /** add to current height */ delta?: Height; /** or set absolute (relative to level) */ set?: Height; /** soften edges into 0.25 steps over n cells */ smooth?: number; layer?: TerrainLayer;
      /** Generator 2: "ragged" breaks the shape's outline with noise (natural ground); default ragged on open-air levels, else clean. */
      edge?: "ragged" | "clean" }
  /** Patchy material mix: seeded value noise; cells with noise < coverage get `material`. scale = feature size in cells (2..32). */
  | { id: ElementId; op: "noise"; shape: Shape; material: Material; coverage: number; scale?: number; seed?: Seed; layer?: TerrainLayer }
  /** Road/river/trail along a polyline of cell centers (any direction; rasterized with given width). jitter 0..1 meanders deterministically. */
  /**
   * Give `points`, or `connect`: areas (their anchor cell), features (their cell) or cells to join in order with
   * L-shaped legs; the path winds between them with jitter. `kerb` edges it with kerb pieces (kerb.<material>).
   */
  | { id: ElementId; op: "path"; points?: Vec2[]; connect?: Array<ElementId | Vec2>; width: number; material: Material; jitter?: number; seed?: Seed; layer?: TerrainLayer; kerb?: boolean;
      /**
       * Generator 2: "natural" winds (meandering centreline, width varying ±, ragged edges, wider at the points it
       * connects; jitter = how much, default 0.5); "straight" keeps the legs ruler-straight (paved roads, corridors).
       * Default: natural for natural ground materials (dirt, gravel, grass, sand, mud, snow, rock), else straight.
       */
      style?: "natural" | "straight";
      /**
       * Generator 2, road form (implies style "straight", jitter ignored): a pavement strip `width` cells wide on each
       * side of the carriageway, of `material`, `raise` tiles above it (0..1, default 0.25: a thick pavement tile
       * stands a kerb's height above a thin road tile). It stops at building lots and at other roads' carriageways;
       * where roads meet, the carriageways merge. `kerb` defaults to true here: a continuous kerb line along the
       * pavement, with gaps at crossings and junction mouths.
       */
      sidewalk?: { width: number; material: Material; raise?: Height };
      /** Generator 2, road form: pedestrian crossings at these fractions (0..1) of the road's length, 2 cells wide, kept clear. */
      crossings?: number[] }
  /** Generate features in a region. density 0..1 = probability per eligible cell before spacing; minSpacing in cells. */
  | {
      id: ElementId; op: "scatter";
      feature: FeatureType;
      shape?: Shape;                       // default: whole level
      exclude?: Shape[];                   // ≤ 8
      density: number;
      minSpacing?: number;                 // default 1
      avoid?: Array<"water" | "paths" | "areas" | "walls" | "features" | "links">;  // default ["water","walls","features","links"]
      variants?: string[];
      randomRotation?: boolean;            // default true (organic) / false (built)
      seed?: Seed;
    }
  /** Furnish an area from a preset table (deterministic). density 0..1 (default 0.5). */
  /** Generator 2: `area` omitted (or the level's id) dresses the whole level: the open ground and each zone. */
  | { id: ElementId; op: "dress"; area?: AreaId; preset: DressPreset; density?: number; seed?: Seed }
  /**
   * Chasm / crevasse / ravine: a meandering trench cut `depth` tiles down into the floor along a polyline of cell
   * centres (any direction). Only cells that are already open (inside areas, or ground) are cut; its sides become
   * cliffs (rock faces in the build). Always applied after the areas, in array order with the "over" ops.
   * `bridges` span it at fractions of its length, square across the chasm, from rim to rim.
   */
  | {
      id: ElementId; op: "chasm";
      points: Vec2[];                      // 2..64 cell centres
      width: number;                       // average width in cells, 1..12
      depth?: Height;                      // tiles below the floor it cuts, 0.5..4 (default 3)
      meander?: number;                    // 0..1 (default 0.5): how much the course and the width wander
      floor?: Material | "none";           // bottom: lava, water_deep… (default: keep the floor material); "none" = bottomless
      bridges?: ChasmBridge[];             // ≤ 4
      seed?: Seed;
    }
  /**
   * Tiered platform (dais, stepped pyramid, terrace, sunken pit): `tiers` rings, each `inset` cells inside the one
   * below and `rise` tiles higher (negative = steps down into a pit). Cut into open floor only. Steps of 0.5 or
   * less are walkable everywhere; `stairs` adds a flight of steps (stair assets) on those sides of the shape.
   * Applied with the over layer, in array order.
   */
  | {
      id: ElementId; op: "platform";
      shape: Shape;
      tiers?: number;                      // 1..5 (default 3)
      rise?: Height;                       // per tier, -2..2, not 0 (default 0.5)
      inset?: number;                      // cells per tier, 1..4 (default 1)
      material?: Material;                 // floor of every tier (default: keep)
      topMaterial?: Material;              // floor of the top tier (default: material)
      stairs?: Side[];                     // sides that get a flight of steps (2 cells wide) up to the top
      /** "ragged": organic, wandering contours (natural mounds, terraces, hills); "clean": crisp built tiers. Default ragged on open-air levels for natural materials, else clean. */
      edge?: "ragged" | "clean";
    }
  /**
   * A straight flight of stairs between two floor cells on one row or column: the cells between them step evenly from
   * `from`'s height to `to`'s; every edge on the way is a stair (walkable, stair assets in the build). For a ledge
   * down to a floor, a way down into a dry chasm, steps up to a terrace. Applied with the over layer, in array order.
   */
  | { id: ElementId; op: "stairs"; from: Vec2; to: Vec2; width?: number /* 1..3, default 1 */;
      /**
       * Generator 2: "ramp" = a natural rock ramp up a cliff instead of a flight of stairs: any direction (diagonal
       * suits it), width 3..6 (default 4), climbing in half-tile steps at about 1 tile per 2.5–4 cells, rock floor.
       * Unverified in game for minis; stairs stay the default.
       */
      style?: "stairs" | "ramp" }
  /**
   * Uneven ground: seeded gentle bumps and hollows (heights in 0.25 steps, neighbours never more than 0.5 apart, so
   * it stays walkable) on the open, non-bridge floor in `shape` (default: the whole level) minus `exclude`.
   * amount = largest change in tiles (0.25..1, default 0.5); scale = bump size in cells (3..12, default 6).
   */
  | { id: ElementId; op: "uneven"; shape?: Shape; exclude?: Shape[]; amount?: Height; scale?: number; seed?: Seed }
  /**
   * Outcrop: a rock mass, column or buttress rising `height` tiles (0.5..4, default 2) out of the open floor of
   * `shape`, with natural cliff sides (any setting: a crag on a hillside, a pillar of rock in a hall or cave).
   * Material `material` (default rock) on top. Applied with the over layer, in array order.
   */
  | { id: ElementId; op: "outcrop"; shape: Shape; height?: Height; material?: Material }
  /**
   * Generator 3: an opening in a floor so the level below shows through. The cells of `shape` that are open floor
   * lose their floor (the area keeps them, so no wall rings the hole); the lower level is checked to have open floor
   * under them. kind "collapse" (default): ragged outline, a low broken edge, and a heap of rubble on the floor below;
   * "shaft": clean outline with a railing round it; "balcony": like shaft, meant for a hall or gallery looking down
   * into a room below. `rim` overrides the edge style (default ruined for a collapse, iron_bars otherwise; "none" =
   * an unguarded edge). `rubble` false = no rubble below a collapse. `edge` overrides the outline.
   */
  | { id: ElementId; op: "floor_opening"; shape: Shape; kind?: "collapse" | "shaft" | "balcony";
      edge?: "ragged" | "clean"; rim?: WallStyle | "none"; rubble?: boolean };

/** A bridge across a chasm terrain op (resolved like an area of kind "bridge"). */
export interface ChasmBridge {
  /** Where along the chasm, 0..1 of its length (default 0.5). */
  at?: number;
  /** Cells wide, 1..4 (default 2). */
  width?: number;
  /** Deck material (default flagstone). */
  floor?: Material;
  /** Railing wall style (default "low_wall"); "none" = no railings. */
  railing?: WallStyle | "none";
  /** 0..0.6: fraction of deck cells crumbled away (a way across always remains). Default 0. */
  crumble?: number;
  /** How the bridge is built (default "arch"; "plank" when floor is wood). */
  span?: BridgeSpan;
  /** Rise of the deck's middle above its ends, tiles 0..2 (default by span). */
  arch?: number;
}

/** What fills cells not covered by any area/terrain. */
export type LevelBase =
  | { type: "solid" }                         // unbuilt rock; rendered as rock; dungeon default
  | { type: "void" }                          // nothing (air); upper floors of towers
  | { type: "ground"; material: Material };   // every cell is OPEN built ground (outdoor)

export interface Level {
  id: LevelId;
  name: string;
  /** Floor elevation of this level in tiles, relative to plan origin. Levels are ordered by elevation (ties forbidden). */
  elevation: Height;
  /**
   * Generator 2: depth of the solid foundation under the level's edge (tiles, 0..4), so raised land has thickness
   * seen from the side. Default 2 on open-air levels (base ground), 0 otherwise; never less than the lowest floor.
   */
  foundation?: Height;
  /**
   * Generator 2, open-air natural levels: "natural" (default) gives the board a ragged, rounded outline with a strip
   * of low ground round it; "rect" keeps the full rectangle. Built-up levels (buildings, roads) stay rectangular.
   */
  outline?: "natural" | "rect";
  /** Generator 3: `false` turns off the default rock band on rises of 2 tiles or more in natural regions no dress op covers. */
  cliffBands?: false;
  /**
   * Generator 4: `false` turns off the default dressing of rooms (an area of kind room whose name, tags or notes tell its
   * purpose, no dress op over it and few features of its own gets that purpose's furniture, things on it and lights).
   */
  roomDress?: false;
  /** Default wall height for this level (tiles). Default 2 (10 ft); used for stacking checks. */
  wallHeight?: Height;
  /** Region of the global grid this level occupies (cells). 1..160 per side. */
  bounds: { x: number; y: number; w: number; h: number };
  base: LevelBase;
  theme?: ThemeId;
  areas: Area[];          // ≤ 200; painter order (later claims cells), routes excepted
  openings: Opening[];    // ≤ 400
  walls: WallRun[];       // ≤ 200
  features: Feature[];    // ≤ 2000
  terrain: TerrainOp[];   // ≤ 64
  labels: Label[];        // ≤ 200
  /**
   * RESERVED (future "imported slab stamps", docs/architecture.md §9.2). v1 readers accept the field;
   * v1 validation reports error "stamp_unsupported" if it is non-empty, and v1 writers omit it.
   */
  stamps?: StampRef[];
  /** Buildings and enclosures (generator 2): see `Structure`. ≤ PLAN_LIMITS.structuresPerLevel. */
  structures?: Structure[];
  /** Generator 3: rows or clusters of market stalls laid out in a rectangle. ≤ 8. */
  stalls?: StallRow[];
  /** Generator 3: lines strung overhead (lanterns, lights, flags) between two walls or posts. ≤ 12. */
  lines?: OverheadLine[];
  notes?: string;
}

/**
 * What a market stall sells. fruit, vegetables, magic and weapons are real stall pieces with the goods built in;
 * spices is a spice-counter kit piece; empty is a bare table; bread, dairy, fish, potions and grain are a bare table
 * with those goods standing on it (the goods are props resting on the table top).
 */
export const STALL_KINDS = [
  "fruit", "vegetables", "spices", "magic", "weapons", "empty",
  "bread", "dairy", "fish", "potions", "grain",
] as const;
export type StallKind = (typeof STALL_KINDS)[number];

/**
 * A row or cluster of market stalls in a rectangle (generator 3). The long side of the rectangle is the row. Deep
 * enough (aisle + 2 cells), two rows stand back to back along the outer edges facing each other across a clear aisle;
 * otherwise one row stands along the side away from `facing`. Spacing is irregular (gaps of 0 to 3 cells), kinds come
 * from `goods` in shuffled order, a stall is 2 cells wide and 1 deep. Cells already taken (a well, a building) are
 * skipped, never built over.
 */
export interface StallRow {
  id: ElementId;
  area: { x: number; y: number; w: number; h: number };
  /** Kinds on offer, used in shuffled rotation so neighbours differ. Default: fruit, vegetables, bread, dairy, potions, spices. */
  goods?: StallKind[];
  /** The side a lone row faces (default S). Two rows each face the aisle. */
  facing?: Side;
  /** Most stalls to place (default: as many as fit). */
  count?: number;
  /** Clear aisle between two rows, cells (default 2, 1..4). */
  aisle?: number;
  seed?: Seed;
}

/**
 * A line strung overhead between two points on one row or column of cells (generator 3): ropes with hanging lanterns,
 * a string of lights, or flags. Each end is anchored on a building wall within 3 cells beyond the end, else on a post
 * the generator adds on the end cell; a line that can be anchored neither way is dropped with a warning. The line
 * hangs `height` tiles above the ground (2 to 3, default 2.3) and its pieces are spaced along it.
 */
export interface OverheadLine {
  id: ElementId;
  from: Vec2;
  to: Vec2;
  /** lanterns (default): rope with lanterns hung along it; lights: a string of lights; flags: rope with hanging cloth flags. */
  kind?: "lanterns" | "lights" | "flags";
  height?: number;
  /** Cells between hung pieces (default 3, 2..6). */
  spacing?: number;
}

// ───────────────────────────── structures (generator 2, additive 2026-11-20) ─────────────────────────────

/**
 * Roof strategies (one per roof layer). Built: "gable", "hip", "shed" (also lean-tos), "flat" (deck + parapet),
 * "skirt" (rings of slope round the top, a mansard or a skirt below the next layer), "stepped" (rings of steps),
 * "spire" (a tapering shell with flared bands and a finial; "cone" is its alias), "none". Accepted and reported
 * (`structure_invalid` warning) and built as "flat" until their strategy lands: "dome", "vault".
 */
export const ROOF_TYPES = ["gable", "flat", "none", "hip", "shed", "cone", "dome", "skirt", "stepped", "spire", "vault"] as const;
export type RoofType = (typeof ROOF_TYPES)[number];

/** Pieces attached to a building. Built today: "porch". The others are reported and skipped until they land. */
export const ATTACHMENT_TYPES = ["porch", "lean_to", "balcony", "outside_stairs"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/**
 * A building or an enclosure. Buildings and yards are built from a STYLE PROFILE (data: storey height, wall courses,
 * window rhythm, roof defaults, door lights…) plus palette roles, so a cottage, a keep, a ruin, a desert house or a
 * modern block differ by data, not code. Every field below overrides the profile.
 */
export type Structure = Building | Enclosure;

export interface Building {
  id: ElementId;
  kind?: "building";
  name?: string;              // ≤ 80, shown in the room key
  key?: string;               // room-key label, unique plan-wide (like Area.key)
  theme?: ThemeId;
  /** Style profile id (e.g. "cottage", "keep", "ruin", "modern", "desert", "tower"); default "cottage". */
  style?: string;
  /**
   * Variety seed: choices the plan leaves open (door face, window offset, porch or not, chimney…) are drawn from the
   * style profile's ranges with this seed (default: from the plan seed and the id). Same seed, same building.
   */
  seed?: Seed;
  /**
   * Ground plan. Either `wings` (rectangles whose union is the footprint; each carries its own ridge) or `footprint`
   * (any cell shape). Pitched roofs need wings (or a rect footprint); other footprints get a flat roof (warning).
   */
  wings?: Array<{ x: number; y: number; w: number; h: number; ridge?: "ew" | "ns" }>;
  /**
   * State of the building: intact, weathered (worn, a few broken pieces, overgrown in places) or ruined (broken wall
   * tops, breaches, upper storeys partly gone, roof fallen in, rubble and growth at its foot, no lights, doorways
   * empty). Default: the style's (ruin is ruined).
   */
  condition?: "intact" | "weathered" | "ruined";
  /**
   * How overgrown a weathered or ruined building is (generator 3): none; light (a few vines and heaps at the foot);
   * medium (vines on about a fifth of the wall); heavy (vines and creepers climbing from the ground on a third to
   * half of the wall, bushes at the wall feet and inside, plants on the wall tops, trees in a roofless part). Default:
   * light for weathered, medium for ruined. Set heavy for overgrown, ivy-covered, reclaimed or abandoned places.
   */
  growth?: "none" | "light" | "medium" | "heavy";
  /**
   * Character: how the request's adjectives bend the form (any style). twisted (the shaft corkscrews storey by
   * storey), leaning (storeys step progressively one way), crooked (small random offsets, uneven storeys), top_heavy
   * (upper storeys wider), squat, slender. Overhangs are intended.
   */
  character?: Array<"twisted" | "leaning" | "crooked" | "top_heavy" | "squat" | "slender">;
  /** Shorthand for one wing (wings: [{x, y, w, h}]); ignored when wings, volumes or a footprint is given. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  footprint?: Shape;
  /** Number of storeys (1..12) or one entry per storey, ground first. Default 1. */
  storeys?: number | Storey[];
  /** Wall height of each storey above its floor, tiles (default from the style: 2 for a cottage, 3 for a block). */
  storeyHeight?: number;
  /**
   * Massing: boxes of their own height and roof. A volume without `on` stands on the ground (its ground storey
   * joins the building's ground storey); with `on` it stands on that volume's roof (a tower on a block, a rooftop
   * shed, a penthouse). When given, `volumes` replaces wings/footprint/storeys/roof at the top level.
   */
  volumes?: Volume[];
  /** Raised base under the building: a plinth, terrace or crag top, with a rim and steps or a ramp to each door. */
  plinth?: Plinth;
  /** Corner treatment of every storey: "chamfer" cuts each outer corner cell (an octagon-like plan). */
  corners?: "square" | "chamfer";
  roof?: Roof | "none";
  /** Doors, windows, arches on the outside walls, by face and position. */
  openings?: StructureOpening[];
  /** Automatic window rhythm on walls without openings of their own (default from the style). */
  windows?: "none" | "sparse" | "regular" | "dense";
  /** Chimney breasts in the wall line: a face and a position along it. */
  chimneys?: Array<{ side: Side; position?: number }>;
  attachments?: Attachment[];
  /** Roof furniture slots (defaults from the style): dormers, a clutter field on flat roofs, a mast, finials. */
  roofFurniture?: { dormers?: boolean; clutter?: number; mast?: boolean; finial?: boolean; hut?: boolean };
  /**
   * The face toward the street, road or square: the door (when none is given), a shopfront and the entrance lights
   * go there. Default: a face the seed picks.
   */
  front?: Side;
  /**
   * What the building is for (shop, apartments, office, warehouse, garage, townhouse, tavern, workshop, civic …): an
   * open word the style maps to weights for massing, roof, elevation and material. Default: the style's mix.
   */
  use?: string;
  /** Ground storey on the front face as a shopfront: wide glazing and a sign band (default from the style). */
  shopfront?: boolean;
  /** Light anchors (defaults from the style): lit windows ("warm", "glow" coloured, or "none"), door lights, entrance strips. */
  lighting?: { windows?: "none" | "warm" | "glow"; colour?: string; doors?: boolean; strips?: boolean };
  notes?: string;
  readAloud?: string;
  encounter?: string;
  tags?: string[];
}

export interface Storey {
  /** Wall style of this storey (default from the style profile); "none" = posts only / open. */
  walls?: WallStyle | "none";
  /** Ground storey only: a lower course of another style (stone footing under timber); "none" = no footing. */
  footing?: WallStyle | "none";
  /** Floor of this storey (default from the style profile / theme). */
  floor?: Material;
  windows?: "none" | "sparse" | "regular" | "dense";
  /** Cells this storey steps in on every side from the one below (0..2; default 0). Stepping out is reserved. */
  inset?: number;
  /** Wall height of this storey (tiles; default the building's / volume's storeyHeight). */
  height?: number;
  /** What covers the ring a set-in leaves: "skirt" (a ring of roof slope), "plain" ledge, "crenellated" ledge. */
  seam?: "skirt" | "plain" | "crenellated";
}

/** One box of a building's massing. */
export interface Volume {
  /** Short local id (unique within the building), e.g. "main", "tower". */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stand on this volume's roof (its cells must lie on that volume's top). */
  on?: string;
  storeys?: number | Storey[];
  storeyHeight?: number;
  corners?: "square" | "chamfer";
  roof?: Roof | "none";
  /** Ridge of a pitched roof (default along the longer side). */
  ridge?: "ew" | "ns";
}

/** A raised base. Its top is the building's ground floor; its sides are built from the face material's cliff roles. */
export interface Plinth {
  /** Tiles above the ground (0.5..6). */
  height: number;
  /** Cells of base around the footprint (1..4, default 1). */
  margin?: number;
  /** Faces the base reaches out from (default all four); a stoop on a terrace reaches out on the street face only. */
  sides?: Side[];
  /** Floor material of the base top; its cliff/fill roles build the sides (default from the style). */
  face?: Material;
  /** Rim on the base edge: a wall style, or "none" (default from the style). */
  rim?: WallStyle | "none";
  /** Way up to each door: "steps" (default) or "none". */
  approach?: "steps" | "none";
}

export interface Roof {
  /** The first (or only) layer's strategy. */
  type: RoofType;
  /**
   * Further layers stacked on this one, bottom to top: a skirt or stepped layer leaves a flat top the next layer
   * stands on (e.g. [{type:"skirt"}, {type:"spire"}] for a tower). The first layer is this Roof itself.
   */
  layers?: RoofLayer[];
  /** skirt / stepped: courses (rings) of the layer (default 1). spire: flared bands (default 1). */
  courses?: number;
  /** shed: the low side (default S). */
  low?: Side;
  /** Ridge direction for pitched roofs (default: along each wing's longer side). */
  ridge?: "ew" | "ns";
  /** Roof kit (palette roles roof.<style>.*), e.g. "slate", "thatch", "shingle"; default from the style profile. */
  style?: string;
  /** Attic deck on the top storey's walls (the pitched roof sits on it). Default from the style profile. */
  deck?: boolean;
  /** 0..0.6: fraction of roof pieces built broken (ruins). Default 0: an intact, continuous roof. */
  broken?: number;
  /** Flat roofs: parapet wall style (default from the style profile); "none" = no parapet. */
  parapet?: WallStyle | "none";
}

/** One stacked roof layer (see Roof.layers). */
export interface RoofLayer {
  type: RoofType;
  style?: string;
  ridge?: "ew" | "ns";
  courses?: number;
  low?: Side;
  parapet?: WallStyle | "none";
}

export interface StructureOpening {
  kind: OpeningKind;
  /** Outside face of the building. */
  side: Side;
  /** 0..1 along that face's longest straight run (default 0.5). */
  position?: number;
  /** 0 = ground storey (default). */
  storey?: number;
  width?: 1 | 2 | 3;
}

export interface Attachment {
  type: AttachmentType;
  side: Side;
  /** 0..1 along that face (default 0.5). */
  position?: number;
  /** Cells along the face (1..8, default 3). */
  width?: number;
  /** Cells out from the face (1..3, default 2). */
  depth?: number;
  floor?: Material;
  /** Porch roof: "flat" (default) or "none". */
  roof?: "flat" | "none";
}

/** A yard: floor, a fence or wall around it, and gates. Dressing of other areas stays out of it. */
export interface Enclosure {
  id: ElementId;
  kind: "enclosure";
  name?: string;
  key?: string;
  theme?: ThemeId;
  /** Yard cells: rect or orthogonal polygon. */
  shape: Shape;
  /** Fence / wall style (default "fence"); "none" = an open yard. */
  wall?: WallStyle | "none";
  gates?: Array<{ side: Side; position?: number; width?: 1 | 2 | 3 }>;
  /** Yard floor (default: keep the ground). */
  floor?: Material;
  notes?: string;
}

/**
 * RESERVED — placement of an imported slab ("stamp") stored in the project file's `stamps` table.
 * The stamp's assets are opaque: never reverse-compiled into plan primitives.
 */
export interface StampRef {
  id: ElementId;
  /** Key into ProjectFile.stamps. */
  stampId: string;
  /** Cell of the stamp footprint's top-left (after rotation). */
  at: Vec2;
  rot: Rotation;
  /** Vertical offset of the stamp's base relative to the level elevation (tiles). */
  lift?: Height;
  name: string;
  description?: string;
  /** Cells (stamp-local, before rotation) the user marked as connection points (entrances). */
  connections?: Array<{ at: Vec2; side: Side; label?: string }>;
  notes?: string;
}

/** Vertical connection between two levels. */
export interface LevelLink {
  id: ElementId;
  kind: LinkKind;
  /** Lower end. For stairs/ramp: first cell of the run on the lower level. */
  from: { level: LevelId; at: Vec2 };
  /**
   * Upper end. `at` may be omitted for stairs/ramp/ladder/spiral_stairs/trapdoor/pit_drop and is then computed
   * (§2.6). If given it must equal the computed cell or validation fails with the expected value in the hint.
   */
  to: { level: LevelId; at?: Vec2 };
  /** Direction of ascent along the run (stairs/ramp). Default "N". */
  dir?: Side;
  width?: 1 | 2;
  label?: string;
  notes?: string;
}

export interface Label {
  id: ElementId;
  text: string;            // ≤ 60 chars; 2D only, never compiled
  at: Vec2;
  size?: "s" | "m" | "l";
}

export interface MapPlan {
  schema: typeof PLAN_SCHEMA;
  generator: GeneratorVersion;
  id: string;              // uuid v4, assigned by app on creation
  title: string;           // ≤ 80
  summary?: string;        // ≤ 1000
  kind: MapKind;
  /** Root seed; element seeds default to hash(rootSeed, elementId) (§2.7). */
  seed: Seed;
  theme: ThemeId;          // map default theme
  levels: Level[];         // 1..8
  /** Level where the party enters (UI orders tabs from here; elevationIndex 0). Default: lowest |elevation|. */
  entryLevel?: LevelId;
  links: LevelLink[];      // ≤ 64
  notes?: string;          // ≤ 4000
}

// ───────────────────────────── validation results ─────────────────────────────

export type Severity = "error" | "warning" | "info";

/** Stable machine-readable codes; messages are for humans/model. Extend only by appending. */
export type PlanIssueCode =
  | "schema"                  // structural/type error (from Zod)
  | "id_format" | "id_duplicate" | "ref_unknown"
  | "bounds_exceeded"         // element outside level bounds / size limits
  | "limit_exceeded"          // count limits
  | "height_step"             // not a multiple of 0.25
  | "level_order"             // duplicate elevation
  | "shape_invalid"           // degenerate polygon, non axis-aligned path, mask too big…
  | "opening_no_boundary"     // `between` areas don't share an edge / `at` edge not on a wall
  | "opening_overlap"
  | "link_mismatch"           // link endpoints not consistent (expected cell in hint)
  | "link_blocked"            // link cells not open / collide
  | "feature_blocked"         // feature footprint on non-open cell or crosses a wall
  | "feature_overlap"
  | "area_empty"              // shape rasterizes to 0 cells (or fully overridden)
  | "area_disconnected"       // area cells not 4-connected
  | "unreachable"             // area not reachable from any other area/outside (warning)
  | "theme_unknown"
  | "custom_unresolved"
  | "key_duplicate"
  | "stamp_unsupported"       // reserved field used by a v1 build
  // playability (walkability on the resolved grid; also emitted by the compiler verify stage)
  | "opening_blocked"         // a door/archway has no walkable approach cell on a side it serves
  | "opening_dead_end"        // a door opens into rock / air / off the map (not marked as an exit)
  | "reachable_secret_only"   // an area is reachable only through a secret door (info)
  | "link_approach_blocked"   // stairs/ladder have no free cell at the foot or on the landing
  | "link_run_blocked"        // a stair/ramp run crosses a wall or doorway
  | "passage_blocked"         // furniture plugs a corridor
  | "feature_not_at_wall"     // shelf/wardrobe-type feature not touching any wall
  | "seat_detached"           // chair/stool/bench near a table but not touching it
  | "area_sealed"             // an area has no opening, passage or link at all
  | "route_dead_end"          // a route corridor never opens into its destination
  | "no_effect"               // an element changes nothing (terrain op on rock, zone floorHeight…); warning with the fix
  | "bridge_unanchored"       // a bridge does not reach walkable floor at both ends
  | "stairs_invalid"          // a stairs op is not on one row/column, or rises more than 1 tile per cell
  | "water_level"             // dry floor lies below the level's water surface (TaleSpire's water plane would flood it)
  | "structure_invalid"       // a building or enclosure that cannot be built as written (overlap, no face, door onto nothing…)
  | "line_unanchored"         // an overhead line has no wall or free post cell at one end (dropped), or is not straight
  | "opening_no_floor_below"  // a floor_opening with solid rock, void or no floor under it on the level below (generator 3)
  | "feature_moved";          // a feature was moved to where it belongs (a vehicle on a pavement or across a road → the kerb lane); info

export interface PlanIssue {
  severity: Severity;
  code: PlanIssueCode;
  message: string;
  /** JSON-pointer-ish path into the plan, e.g. "/levels/0/areas/3/shape/w". */
  path?: string;
  elementId?: ElementId;
  levelId?: LevelId;
  cell?: Vec2;
  /** Concrete corrective suggestion for the model, e.g. "to.at should be [12,4]". */
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;             // no "error" issues
  issues: PlanIssue[];
}

/**
 * TaleSpire build facts the resolver needs (docs/talespire-slab-format.md, docs/talespire-assets.md §5).
 * level.elevation is the BOTTOM of the level's floor tiles; walkable floor top = elevation + floorThickness.
 * Stairs/ramps: run length (cells) = ceil(rise / stairRisePerCell); rise = Δ elevation between the two levels.
 */
export const BUILD_CONSTANTS = {
  floorThickness: 0.5,
  storeyHeight: 2.5,       // recommended elevation step between stacked levels
  wallHeight: 2,           // default Level.wallHeight
  stairRisePerCell: 1,
  verticalSnap: 0.25,
} as const;

/** Hard limits (also enforced by Zod). */
export const PLAN_LIMITS = {
  levels: 8,
  levelSide: 160,
  areasPerLevel: 200,
  openingsPerLevel: 400,
  wallRunsPerLevel: 200,
  featuresPerLevel: 2000,
  terrainOpsPerLevel: 64,
  labelsPerLevel: 200,
  structuresPerLevel: 32,
  links: 64,
  polygonPoints: 64,
  maskSide: 64,
  generatedFeaturesPerLevel: 6000,
  planJsonBytes: 512 * 1024,
  minHeight: -4,
  maxHeight: 8,
} as const;

// ───────────────────────────── design brief (UX §5.1; lives in the project, not in the plan) ─────────────────────────────

export type BriefSource = "ai" | "user";
export interface BriefField<T> { value: T; source: BriefSource }

/** All fields optional; the UI shows a readiness line once mapType is set. User values always win over AI updates. */
export interface DesignBrief {
  mapType?: BriefField<string>;                     // "Dungeon", "Tower", "Wilderness/Forest", free text…
  system?: BriefField<"daggerheart" | "dnd5e" | "other">;
  party?: BriefField<{ tier?: number; level?: number; size?: number }>;
  footprint?: BriefField<{ preset: "small" | "medium" | "large" | "custom"; widthSq: number; heightSq: number }>;
  levels?: BriefField<{ count: number; names: string[] }>;
  tone?: BriefField<string>;                        // ≤ 80 chars
  mustInclude?: BriefField<string[]>;
  avoid?: BriefField<string[]>;
  theme?: BriefField<ThemeId>;                      // preferred palette theme (UX open question §15.4)
}
