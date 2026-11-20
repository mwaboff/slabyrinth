/**
 * Slabyrinth — resolved geometry and 2D display list.
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/contracts/resolved.ts.
 *
 * resolvePlan(plan) is the SINGLE source of geometric truth. The 2D renderer and the slab compiler
 * both consume ResolvedPlan; neither re-interprets MapPlan shapes. This is what makes the 2D map a
 * faithful preview of the build.
 *
 * All arrays are plain (structured-clone and JSON friendly). Typed arrays are allowed in memory
 * (Uint8Array/Int16Array have the same indexing) — implementations choose; IPC transfers typed arrays.
 */
import type {
  AreaId, AreaKind, BridgeSpan, ElementId, FeatureType, Height, LevelId, LinkKind, Material, OpeningKind,
  PlanIssue, Rotation, Side, ThemeId, Vec2, WallStyle,
} from "./plan";

/** Cell occupancy. */
export const CELL = { VOID: 0, SOLID: 1, OPEN: 2 } as const;
export type CellState = (typeof CELL)[keyof typeof CELL];

/** Cell flag bits. */
export const CELL_FLAG = {
  NO_FLOOR: 1 << 0,     // open but floorless (chasm/hole/stairwell from below)
  STAIRWELL: 1 << 1,    // hole cut for a link arriving from below
  WATER: 1 << 2,        // material is water_* (walkability/avoid)
  PATH: 1 << 3,         // painted by a terrain "path" op
  LINK: 1 << 4,         // occupied by a link footprint
  FEATURE: 1 << 5,      // occupied by a blocking feature footprint
  BRIDGE: 1 << 6,       // bridge deck (open air beneath; ResolvedLevel.bridges has the floor below). With NO_FLOOR: a broken deck cell
  STEPS: 1 << 7,        // the lower cell of a STAIR edge: holds the stair asset (no features)
} as const;

/** Edge kinds. */
/** STAIR: a height step that is walkable whatever its height (a flight of steps); the stair asset stands in the lower cell. */
export const EDGE = { NONE: 0, WALL: 1, OPENING: 2, LEDGE: 3, STAIR: 4 } as const;
export type EdgeKind = (typeof EDGE)[keyof typeof EDGE];

/**
 * Edge indexing for a level with bounds w×h (local coords lx = x - bounds.x, ly = y - bounds.y):
 *  - hEdges: horizontal edges, (w) × (h+1); hEdges[ly*w + lx] is the NORTH edge of local cell (lx,ly);
 *            ly == h is the south border.
 *  - vEdges: vertical edges, (w+1) × (h); vEdges[ly*(w+1) + lx] is the WEST edge of local cell (lx,ly);
 *            lx == w is the east border.
 */
export interface EdgeGrid {
  kind: number[];        // EdgeKind per edge
  /** Index into ResolvedLevel.wallStyles (WALL), .openings (OPENING); 0xFFFF otherwise. */
  ref: number[];
  /**
   * WALL edges: wall height above the FLOOR TOP (tiles), i.e. above elevation + floor thickness (0.5) + cell height.
   * LEDGE and STAIR edges: height difference between the two cells. 0 otherwise.
   */
  height: number[];
  /**
   * Which adjacent cell physically hosts the 0.5-deep wall/door strip (research: TaleSpire edge pieces occupy the
   * half-cell next to the edge, not the grid line). 0 = first cell (north for h, west for v), 1 = second.
   * Rule (§2.4), first match wins: (1) exactly one side is non-open → that side; (2) exactly one side has no area
   * (e.g. outdoor base ground) → that side; (3) the side whose area has MORE cells (a 1-wide corridor never hosts
   * a wall shared with a room); (4) tie → the second cell. Explicit WallRuns host on the second cell.
   * The 2D renderer draws walls on this half, so the preview shows the real usable floor.
   */
  host: number[];
}

export interface ResolvedArea {
  id: AreaId;
  kind: AreaKind;
  name?: string;
  key?: string;
  theme: ThemeId;          // effective theme (area ?? level ?? plan)
  cellCount: number;
  bbox: { x: number; y: number; w: number; h: number };
  /** Cell used for labels/routing (§2.5: the open cell nearest the bbox center, ties → smallest y then x). */
  anchor: Vec2;
  /** Outline polygons in VERTEX coords (outer rings clockwise, holes counter-clockwise), for rendering and export. */
  outline: Vec2[][];
  notes?: string;
  /** Area.labelAt: cell where the key badge is drawn (absent = the renderer picks a free cell near `anchor`). */
  labelAt?: Vec2;
}

export interface ResolvedOpening {
  id: ElementId;          // plan id, or "<routeAreaId>~a"/"~b" for route auto-openings
  kind: OpeningKind;
  orientation: "h" | "v"; // h = lies on a horizontal edge (between N/S cells)
  /** Global vertex coord of the edge run start; run extends +x (h) or +y (v) by width. */
  start: Vec2;
  width: number;
  /** Areas on either side (null = non-area). For h: [north, south]; for v: [west, east]. */
  sides: [AreaId | null, AreaId | null];
  wallStyle: WallStyle;
  theme: ThemeId;
  label?: string;
  /** GM-only (secret doors are always gmOnly): hidden in the player view and player PNG export. Absent = false. */
  gmOnly?: boolean;
}

export interface ResolvedFeature {
  /** Plan feature id, or "<opId>#<n>" for generated features (n = 0-based generation order). */
  id: string;
  type: FeatureType;
  generatedBy?: ElementId;  // scatter/dress op id
  /** Global cell of footprint top-left AFTER rotation. */
  at: Vec2;
  /** Footprint after rotation. */
  size: readonly [w: number, h: number];
  rot: Rotation;
  /** Fine rotation for organic scatter (degrees, multiple of 15), compiler uses this; 2D draws with it. */
  rotFine: number;
  wall?: Side;
  /**
   * ABSOLUTE height of the feature base in tiles: level elevation + floor thickness (0.5) + cell floor height + lift.
   * The compiler places the asset at exactly this y.
   */
  baseHeight: Height;
  variant?: string;
  hint?: string;
  area?: AreaId;            // containing area (anchor cell)
  theme: ThemeId;
  label?: string;
  blocking: boolean;        // from feature catalog (rug=false, table=true…)
  /** GM-only (traps, hidden features): hidden in the player view and player PNG export. Absent = false. */
  gmOnly?: boolean;
}

export interface ResolvedLink {
  id: ElementId;
  kind: LinkKind;
  fromLevel: LevelId;
  toLevel: LevelId;
  /** Cells occupied on the lower level (run/footprint). */
  lowerCells: Vec2[];
  /** Cells cut (STAIRWELL) on the upper level. */
  upperCells: Vec2[];
  /** Arrival cell on upper level. */
  arrival: Vec2;
  dir: Side;
  rise: Height;             // elevation difference
  label?: string;
  theme: ThemeId;
}

/**
 * A natural cliff run (generator 2): the chain of cell edges where natural ground rises a tile or more, in order,
 * for the build and for dressing (a rock band laid along it). Heights are QUARTER tiles relative to the elevation.
 */
export interface ResolvedCliffRun {
  /**
   * Edges in order along the run (the upper ground on the right when walking it). `at` = the upper cell, `side` =
   * the side of `at` the drop is on (the outward direction), `low` / `high` = floor heights below and above.
   */
  edges: Array<{ at: Vec2; side: Side; low: number; high: number }>;
  /** True when the run closes on itself (a plateau or pit all round). */
  closed: boolean;
  /** Smallest and largest rise along the run (high − low), quarter tiles. */
  minRise: number;
  maxRise: number;
  /** Floor material of the upper ground (the first edge's). */
  material: Material | null;
  /** Indices into `edges` where a route crosses the run (a flight of stairs, a ramp). */
  crossings: number[];
}

/**
 * A road: a path op with `sidewalk` or `crossings` (generator 2). Cells are global cell coordinates, row-major.
 * For the build (tile orientation along the axis, crossing markings) and dressing (street furniture along the kerb
 * lines, nothing in the carriageway or on crossings).
 */
export interface ResolvedRoad {
  /** The path op's id. */
  id: ElementId;
  /** Centre line through the road's straight legs (cell centres): tiles and markings align to it. */
  axis: Vec2[];
  /** Carriageway width, cells (constant). */
  width: number;
  /** Carriageway cells (also CELL_FLAG.PATH). Where roads meet, a shared cell is listed by the first road. */
  carriageway: Vec2[];
  /** Pavement cells (empty without a sidewalk). They stop at building lots and at carriageways. */
  pavement: Vec2[];
  pavementMaterial: Material | null;
  /** Pavement height above the carriageway beside it, QUARTER tiles. */
  pavementRaise: number;
  /** Straight runs of pavement cells along the kerb, ends inclusive; `side` = the side of those cells facing the road. */
  kerbLines: Array<{ from: Vec2; to: Vec2; side: Side }>;
  /**
   * Pavement corners: "outer" = the carriageway on two adjacent sides (a block corner at a junction), "inner" = the
   * carriageway only diagonally (the pavement turns into a side street). `sides` = the two sides toward the road.
   */
  corners: Array<{ at: Vec2; kind: "outer" | "inner"; sides: [Side, Side] }>;
  /** Crossings: carriageway cells kept clear for a crossing marking; `axis` = the road's direction there. */
  crossings: Array<{ cells: Vec2[]; axis: "h" | "v" }>;
}

/**
 * A bridge deck (an area of kind "bridge" or a chasm op's bridge). Its cells carry CELL_FLAG.BRIDGE and the DECK height
 * (cells.height), so walking and the 2D map see the deck; what lies under the deck is recorded here for the build.
 */
export interface ResolvedBridge {
  /** Area id, or "<chasmOpId>~b<n>" for a chasm op's bridge. */
  id: string;
  /** Deck cells, intact and broken, row-major order. */
  cells: Vec2[];
  /** Deck cells that have fallen away (also CELL_FLAG.NO_FLOOR). */
  broken: Vec2[];
  /** Deck floor height at its ENDS relative to elevation, in QUARTER tiles (an arched deck rises above it toward the middle). */
  deck: number;
  /** Per cell (same order as `cells`): height of the ground beneath the deck in QUARTER tiles (relative to elevation). */
  under: number[];
  /** Per cell: material of the floor beneath the deck; null = no floor there (bottomless). */
  underMaterial: Array<Material | null>;
  /** Railing wall style on the edges facing the drop, null = none. */
  railing: WallStyle | null;
  /** How it is built ("arch", "flat", "plank", "natural"). Absent = "flat" (deck heights are in cells.height). */
  span?: BridgeSpan;
  /** Cells (subset of `cells`) that stand on a pier reaching down to the ground beneath. */
  piers?: Vec2[];
  label?: string;
}

export interface ResolvedLevel {
  id: LevelId;
  name: string;
  elevation: Height;
  bounds: { x: number; y: number; w: number; h: number };
  /** Row-major w*h arrays (index = ly*w + lx). */
  cells: {
    state: number[];        // CellState
    /** Index into `areaIds` + 1; 0 = no area. */
    area: number[];
    /** Index into `materials` (+1); 0 = none (SOLID/VOID or NO_FLOOR). */
    material: number[];
    /** Floor height relative to elevation, in QUARTER tiles (int). */
    height: number[];
    flags: number[];
    /** Index into `themes` — effective theme per cell. */
    theme: number[];
  };
  areaIds: AreaId[];
  materials: Material[];
  themes: ThemeId[];
  wallStyles: WallStyle[];
  hEdges: EdgeGrid;
  vEdges: EdgeGrid;
  areas: ResolvedArea[];
  openings: ResolvedOpening[];
  features: ResolvedFeature[];
  labels: { id: ElementId; text: string; at: Vec2; size: "s" | "m" | "l" }[];
  /** Bridge decks on this level; absent when there are none. */
  bridges?: ResolvedBridge[];
  /**
   * Outcrops (rock masses): cells and peak height (tiles) for dressing that builds them from large rock props.
   * The compiler builds their cells as solid rock columns (no floor tile on top).
   */
  outcrops?: Array<{ id: ElementId; cells: Vec2[]; peak: Height }>;
  /** Kerb pieces: an edge of a path cell (`at`, `side`) next to non-path floor; `material` = the path's. */
  kerbs?: Array<{ at: Vec2; side: Side; material: Material }>;
  /** Roads (path ops in road form, generator 2): carriageway, pavements, kerb lines, corners and crossings. */
  roads?: ResolvedRoad[];
  /** Natural cliff runs (generator 2): rises of a tile or more on natural ground, in order along each run. */
  cliffs?: ResolvedCliffRun[];
  /** Rock ramps (stairs ops with style "ramp", generator 2): cells kept clear of dressing, ends low and high. */
  ramps?: Array<{ id: ElementId; cells: Vec2[]; from: Vec2; to: Vec2 }>;
  /**
   * Intended water surface (ABSOLUTE tiles) when the level has water: TaleSpire's board-wide water plane, which a
   * slab does not carry. Every water cell's bed lies below it; dry walkable floor should lie above it.
   */
  waterLevel?: Height;
  /** Generator 2: depth of the solid foundation under the level edge (tiles), from Level.foundation or its default. */
  foundation?: Height;
  /** Buildings and enclosures on this level (generator 2); absent when there are none. */
  structures?: ResolvedStructure[];
  /**
   * Cells that generated dressing (scatter, dress) must leave free: wall host rings of buildings, door approaches,
   * chimney and porch cells. Local cell indices (ly*w + lx), ascending. Absent when empty. Explicit features may
   * still stand there.
   */
  reserved?: number[];
}

/**
 * A resolved building or enclosure. The ground storey of a building is also an ordinary area (id = structure id)
 * with walls and openings in the level's edge grid, so walkability, playability, 2D and hit-testing treat it like any
 * building area; this record carries what only the build and the roof overlay need.
 */
export interface ResolvedStructure {
  id: ElementId;
  kind: "building" | "enclosure";
  /** Style profile actually used. */
  style: string;
  theme: ThemeId;
  /** Footprint cells (global), row-major order. Enclosure: yard cells. */
  cells: Vec2[];
  /** Rectangles the pitched roof is built over (global cells, footprint only, not the wall ring). */
  wings: Array<{ x: number; y: number; w: number; h: number; ridge: "ew" | "ns" }>;
  /** Base height of the ground floor (relative to the level, tiles) and of each storey. */
  storeys: Array<{
    /** Floor top, absolute tiles. */
    floorTop: Height;
    /** Lower course (ground storey only) and main wall course. */
    footing: { style: WallStyle; height: Height } | null;
    walls: WallStyle | null;
    /** Wall height above floorTop including the footing (tiles). */
    wallHeight: Height;
    floor: Material;
  }>;
  /** Openings of this structure: ids into ResolvedLevel.openings (ground storey) and upper-storey openings. */
  openingIds: string[];
  upperOpenings: Array<{ storey: number; kind: OpeningKind; at: Vec2; side: Side; width: number; volume?: string }>;
  /** The main ground volume's roof (first layer); every volume's full roof is in `volumes`. */
  roof: {
    type: BuiltRoofType;
    /** As written in the plan (differs from `type` when a strategy is not built yet). */
    requested: string;
    style: string;
    deck: boolean;
    broken: number;
    parapet: WallStyle | null;
  };
  chimneys: Array<{ at: Vec2; side: Side }>;
  porches: Array<{ cells: Vec2[]; side: Side; floor: Material; roof: boolean }>;
  /** Enclosures: fence style and gate edges ("at" cell inside the yard, side). */
  fence?: { style: WallStyle | null; gates: Array<{ at: Vec2; side: Side }> };
  /** Wall lights beside doors: the door cell (inside) and the face. */
  lights: Array<{ at: Vec2; side: Side }>;
  /** Phase 2: the building's volumes (massing), each with its storeys and stacked roof layers. */
  volumes?: ResolvedVolume[];
  /** Raised base: its cells (footprint plus margin), height above the ground and face material. */
  plinth?: { height: Height; face: Material; rim: WallStyle | null; cells: Vec2[] };
  /** Roof furniture drawn from the style: dormers, clutter density on flat roofs, a mast, finials. */
  furniture?: { dormers: boolean; clutter: number; mast: boolean; finial: boolean; hut?: boolean };
  /** Light anchors drawn from the style: lit windows (fraction lit), their colour, door lights, entrance strips. */
  lighting?: { windows: "none" | "warm" | "glow"; colour: string; lit: number; doors: boolean; strips: boolean };
  /** The design drawn from the style (variety axes) when the plan left the building to its style. */
  design?: {
    use: string; archetype: string; storeys: number; groundHeight: number; upperHeight: number; material: WallStyle;
    baseMaterial: WallStyle; roof: string; parapet: string; rooftop: string[]; windows: string; base: string; top: string;
    details: string[]; serviceDoor: boolean; footing: string; size: string; roofSurface: string; parapetLower: string;
    crown: string;
    character: string[];
    /** Wall treatment (a belonging set of base, walls and crown) and the roof kit of every pitched roof. */
    treatment?: string;
    roofKit?: string;
  };
  /** State the building was built in (Building.condition, or the style's default). */
  condition?: "intact" | "weathered" | "ruined";
  /**
   * Rubble, growth and story props of a weathered or ruined building, inside its walls and at its foot (roles
   * ruin_rubble.default, ruin_growth.default, ruin_prop.default; a theme without the role gets nothing).
   */
  debris?: Array<{ at: Vec2; kind: "rubble" | "growth" | "prop" }>;
  /**
   * Weathered or ruined: the surviving top of every wall column (the outer face of footprint cell `at` on `side`),
   * absolute tiles, beside its intact top; upper floor cells that have fallen in; the standing corner the ruin falls
   * away from; the share of masonry lost. The compiler builds every wall up to its column top.
   */
  ruin?: {
    columns: Array<{ at: Vec2; side: Side; top: Height; full: Height }>;
    holes: Array<{ volume: string; storey: number; cells: Vec2[] }>;
    anchor: Vec2;
    loss: number;
    /** Weathered: roof cells whose upper slope pieces are missing (a patch; the eave pieces round it stay). */
    roofHoles?: Vec2[];
  };
  /** The street face and whether its ground storey is a shopfront (sign band over wide glazing). */
  frontage?: { side: Side; shopfront: boolean };
  /** Variety seed actually used (build-time choices hash it). */
  seed?: number;
}

/** Roof strategies the build has (others are reported and built flat). */
export type BuiltRoofType = "gable" | "hip" | "shed" | "flat" | "none" | "skirt" | "stepped" | "spire";

/** One box of a building's massing, resolved. */
export interface ResolvedVolume {
  id: string;
  /** Volume whose roof this one stands on; null = on the ground. */
  on: string | null;
  corners: "square" | "chamfer";
  /** Rectangles pitched roofs are built over (the volume, or the wings of a phase-1 building). */
  rects: Array<{ x: number; y: number; w: number; h: number; ridge: "ew" | "ns" }>;
  storeys: Array<{
    /** Floor top and wall top, absolute tiles. */
    floorTop: Height;
    wallTop: Height;
    /** Cells of this storey (after set-ins and chamfers) and their bounding rect. */
    cells: Vec2[];
    rect: { x: number; y: number; w: number; h: number };
    footing: { style: WallStyle; height: Height } | null;
    walls: WallStyle | null;
    floor: Material;
    /** What covers the ring this storey's set-in leaves on the storey below; null = no set-in. */
    seam: "skirt" | "plain" | "crenellated" | null;
  }>;
  roof: {
    layers: Array<{
      type: BuiltRoofType;
      requested: string;
      style: string;
      courses: number;
      low: Side;
      parapet: WallStyle | null;
      ridge: "ew" | "ns";
    }>;
    deck: boolean;
    broken: number;
    /** A ruin keeps only the gable wall on this end of its roof (slopes fallen in). */
    gableOnly?: Side;
  };
}

export interface ResolvedPlan {
  planId: string;
  planVersion: number;
  generator: number;
  levels: ResolvedLevel[];   // sorted by elevation ascending
  links: ResolvedLink[];
  /** Resolution diagnostics (warnings such as overlapping features dropped by scatter). */
  issues: PlanIssue[];
  /** Stable content hash (FNV-1a 64 hex of canonical JSON) — cache key for renderer/compiler. */
  hash: string;
}

/** Pure + deterministic: same plan ⇒ byte-identical ResolvedPlan (canonical JSON). */
export type ResolvePlan = (plan: import("./plan").MapPlan, opts?: { levels?: LevelId[] }) => ResolvedPlan;

// ───────────────────────────── 2D display list ─────────────────────────────

/**
 * Renderer-agnostic display list produced by core `buildDisplayList(resolvedLevel, options)`.
 * Coordinates are in CELL units (1 = one cell); the view applies its own pixel transform.
 * Geometry is plain number arrays (no SVG strings, no colours) — drawn by `drawDisplayList` (Canvas 2D).
 */
export type DisplayLayer =
  | "ground" | "floor" | "water" | "height_shade" | "ledge" | "grid" | "wall"
  | "opening" | "link" | "feature" | "label" | "area_outline" | "selection";

export interface DisplayItem {
  layer: DisplayLayer;
  /** Semantic style token resolved by the view's theme CSS, e.g. "mat-grass", "wall-stone", "door-secret". */
  style: string;
  /**
   * Exactly one of geom / symbol / text. geom = polylines in cell units, each a flat [x0,y0,x1,y1,…] array;
   * closed=true rings are filled (even-odd) and/or stroked per style token.
   */
  geom?: { rings: number[][]; closed: boolean };
  symbol?: { id: string; x: number; y: number; w: number; h: number; rot: number };   // symbol id = "feat-<type>", "link-<kind>", "door-<kind>"
  text?: { value: string; x: number; y: number; size: "s" | "m" | "l"; anchor: "middle" | "start" };
  /** Element this item belongs to (for hover/selection highlighting). */
  ref?: string;
}

export interface DisplayList {
  levelId: LevelId;
  viewBox: { x: number; y: number; w: number; h: number };   // cell units, = level bounds
  items: DisplayItem[];   // already in paint order
}

export interface DisplayOptions {
  grid: boolean;
  roomNumbers: boolean;
  roomNames: boolean;
  furniture: boolean;
  /** false = player view: hides gmOnly features/openings, draws secret doors as plain wall, hides traps. */
  gmLayer: boolean;
  legend: boolean;
  ghostLevel?: ResolvedLevel;
}

/** Plan-wide context a single level's display list / hit test needs (ResolvedLevel has no link list). */
export interface DisplayContext {
  /** ResolvedPlan.links; those touching the level are drawn / hit-tested. */
  links?: readonly ResolvedLink[];
  /** Short level names for link badges, e.g. { l1: "L1", l2: "L2" }. */
  levelLabels?: Record<LevelId, string>;
}

export type BuildDisplayList = (level: ResolvedLevel, opts: DisplayOptions, ctx?: DisplayContext) => DisplayList;

/**
 * Map colours are NOT in the display list: DisplayItem.style is a semantic token resolved through a MapTheme at
 * draw time. Bundled themes: "parchment-dark" (default, matches the dark app theme), "parchment-light", "print" (PNG Print style), "ink-on-white" (v1.1).
 */
export interface MapTheme {
  id: string;
  /** token → CSS colour; required tokens listed in docs/architecture.md §5.3. */
  colors: Record<string, string>;
  lineScale: number;        // multiplies stroke widths
  fontFamily: string;       // bundled font (no remote fonts)
}

/**
 * THE single drawing routine (packages/render-canvas): used by the interactive map view (on-screen canvas,
 * with viewport culling) and by PNG export (OffscreenCanvas at arbitrary scale). Accepts any 2D context
 * implementing the CanvasRenderingContext2D subset (so a node-canvas/skia backend can be added for the CLI later).
 */
export type DrawDisplayList = (
  ctx: Canvas2DLike,
  list: DisplayList,
  theme: MapTheme,
  view: { scale: number; offsetX: number; offsetY: number; viewport?: { x: number; y: number; w: number; h: number } },
) => void;

/** Structural subset of CanvasRenderingContext2D (keeps core free of DOM lib types). */
export interface Canvas2DLike {
  save(): void; restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void; rotate(rad: number): void; scale(x: number, y: number): void;
  beginPath(): void; closePath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void; rect(x: number, y: number, w: number, h: number): void;
  fill(): void; stroke(): void; clip(): void; fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void; measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; globalAlpha: number;
  textAlign: string; textBaseline: string; lineJoin: string; lineCap: string;
}

export interface PngExportOptions {
  levels: LevelId[] | "all";
  /** Pixels per square (UX default 70; 24 = 100% zoom). Clamped so each side ≤ 16384 px. */
  pxPerCell: number;
  /** Which version to export (default head). */
  version?: number;
  display: DisplayOptions;
  /** "print" (light, high contrast — UX Print style), "parchment-dark", "parchment-light", "ink-on-white". */
  mapThemeId: string;
  /** Include the room key as a side panel in the image. */
  keyPanel: boolean;
  background: "theme" | "transparent";
}

// ───────────────────────────── hit testing ─────────────────────────────

export type HitTarget =
  | { kind: "feature"; id: string; area?: AreaId }
  | { kind: "opening"; id: ElementId }
  | { kind: "link"; id: ElementId }
  | { kind: "area"; id: AreaId }
  | { kind: "cell"; cell: Vec2 };     // open/solid cell outside any area

/**
 * Pure: priority feature > opening (within 0.2 cell of its edge) > link > area > cell.
 * `point` is in cell units (fractional), global coordinates.
 */
export type HitTest = (level: ResolvedLevel, point: readonly [number, number], ctx?: DisplayContext) => HitTarget | null;

/** Selection context passed from the UI to the chat (§3.5). */
export interface MapSelection {
  levelId: LevelId;
  areaIds: AreaId[];
  featureIds: string[];
  openingIds: ElementId[];
  linkIds: ElementId[];
  /** Rubber-band rectangle in cell coords, if any. */
  rect?: { x: number; y: number; w: number; h: number };
}
