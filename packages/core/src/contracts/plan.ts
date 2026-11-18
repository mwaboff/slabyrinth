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
/** Version of the deterministic generators (blob, cave, noise, scatter, dress, routing). */
export const GENERATOR_VERSION = 1 as const;

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
] as const;
export type Material = (typeof MATERIALS)[number];

export const WALL_STYLES = [
  "wall",        // theme default wall
  "stone", "brick", "wood", "cave_rock", "plaster",
  "palisade", "fence", "hedge", "low_wall", "railing", "iron_bars", "ruined",
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
  "custom",
] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const DRESS_PRESETS = [
  "tavern", "library", "barracks", "bedroom", "kitchen", "storeroom", "throne_room",
  "shrine", "crypt", "prison", "forge", "laboratory", "treasury", "ruin", "camp",
] as const;
export type DressPreset = (typeof DRESS_PRESETS)[number];

export type AreaKind =
  | "room"        // built interior: floor + walls (default walls "auto")
  | "corridor"    // built interior passage (default walls "auto")
  | "cave"        // natural interior: rock floor, cave_rock walls (default walls "auto")
  | "building"    // footprint of a structure in an outdoor/town map (default walls "auto")
  | "courtyard"   // built exterior floor, no walls of its own (default walls "perimeter")
  | "zone";       // semantic only: never changes cells' material/walls; used for key/notes/hit-test

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
  /** Omitted: theme default for room/corridor/cave/building/courtyard; "keep underlying" for zone. "none" = hole/chasm (open, no floor). */
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
}

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
  | { id: ElementId; op: "height"; shape: Shape; /** add to current height */ delta?: Height; /** or set absolute (relative to level) */ set?: Height; /** soften edges into 0.25 steps over n cells */ smooth?: number; layer?: TerrainLayer }
  /** Patchy material mix: seeded value noise; cells with noise < coverage get `material`. scale = feature size in cells (2..32). */
  | { id: ElementId; op: "noise"; shape: Shape; material: Material; coverage: number; scale?: number; seed?: Seed; layer?: TerrainLayer }
  /** Road/river/trail along a polyline of cell centers (any direction; rasterized with given width). jitter 0..1 meanders deterministically. */
  | { id: ElementId; op: "path"; points: Vec2[]; width: number; material: Material; jitter?: number; seed?: Seed; layer?: TerrainLayer }
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
  | { id: ElementId; op: "dress"; area: AreaId; preset: DressPreset; density?: number; seed?: Seed };

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
  generator: typeof GENERATOR_VERSION;
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
  | "route_dead_end";         // a route corridor never opens into its destination

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
