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
  AreaId, AreaKind, ElementId, FeatureType, Height, LevelId, LinkKind, Material, OpeningKind,
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
} as const;

/** Edge kinds. */
export const EDGE = { NONE: 0, WALL: 1, OPENING: 2, LEDGE: 3 } as const;
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
   * LEDGE edges: height difference between the two cells. 0 otherwise.
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
