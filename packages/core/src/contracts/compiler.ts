/**
 * Slabyrinth — palette format, compiler stages, slab codec seam, export bundle.
 * NORMATIVE CONTRACT. Copy verbatim into packages/core/src/contracts/compiler.ts.
 *
 * Pipeline (docs/architecture.md §4):
 *   MapPlan ──validate──► resolvePlan ──► ResolvedPlan ──realize(palettes)──► PlacementSet
 *           ──chunk(limits, codec)──► Chunk[] ──encode(codec)──► SlabChunk[] ──► ExportBundle
 *
 * Format facts (slab binary layout, limits, rotation encoding, asset pivots) are owned by the
 * format research (docs/talespire-slab-format.md, data/talespire-assets.json). This file only
 * defines the seams; values marked RESEARCH come from there.
 */
import type {
  ElementId, FeatureType, Height, LevelId, LinkKind, Material, OpeningKind, Side, ThemeId, WallStyle,
} from "./plan";

// ───────────────────────────── asset catalog (generated from the install) ─────────────────────────────

/**
 * One record of the derived asset catalog. Same shape as the research artefact data/talespire-assets.json
 * (tools/research/Extract-AssetCatalog.ps1), but generated AT RUNTIME by core `buildCatalog(sources)` from the
 * user's install (<TaleSpire>/Taleweaver/<packGuid>/index [binary, primary] or index.json [fallback]) and cached
 * only in userData/catalog/. Never bundled, never committed (gitignored). OPTIONAL for compiling (see AssetAvailability).
 */
export interface CatalogAsset {
  uuid: string;                  // lower-case canonical GUID (BoardObject.Id)
  name: string;                  // NOT unique
  kind: "tile" | "prop";
  pack: string;
  packId: string;
  folder: string;                // kit, e.g. "Dungeon Cellar"
  groupTag: string;              // coarse form: floor, wall, roof, corner, stairs… (may be "")
  tags: string[];
  deprecated: boolean;           // never emit
  interactable: boolean;
  /** Unrotated size in tiles (x east-west, y up, z north-south) = 2 × ColliderBoundsBound.m_Extent. */
  size: { x: number; y: number; z: number };
  footprintCells: { x: number; z: number };
  boundsCenter: { x: number; y: number; z: number };
  boundsMin: { x: number; y: number; z: number };
  /** Tiles: stored position = min corner after rotation. Props: stored position = origin (≈ collider centre). */
  originAt: "minCorner" | "center" | "other";
  sizeTag?: string;
  meshParts?: number;
}

/**
 * Cached catalog (userData/catalog/catalog.json). Versioned; a cache with an unknown schema or generator
 * version is discarded and rebuilt. Assets are RUNTIME DATA: nothing about assets requires an app release.
 */
export interface AssetCatalog {
  schema: "slabyrinth/asset-catalog@1";
  /** Bumped when the extraction logic changes (forces a rebuild of every cache). */
  extractorVersion: number;
  generatedAt: string;
  fingerprint: InstallFingerprint;
  packs: Array<{ packId: string; name: string; source: CatalogSourceId; tiles: number; props: number }>;
  assets: CatalogAsset[];
}

/** Detects that the install changed (TaleSpire updates often; index.json may be stale while the binary index is fresh). */
export interface InstallFingerprint {
  installPath: string;
  files: Array<{ relPath: string; size: number; mtimeMs: number; sha256: string }>;   // every Taleweaver/<pack>/index and index.json
}

export type CatalogSourceId = "binary-index" | "index-json";

/**
 * Pluggable reader of one official content pack. Primary: the binary `index` (format being documented by the
 * research; magic CE D1 CE D1, v5). Fallback: `index.json` when the binary parser fails or is unsupported for the
 * found version. Pure functions over bytes, in core (no fs) so they are unit-testable with fixtures.
 */
export interface CatalogSource {
  id: CatalogSourceId;
  /** Quick check on the file header/version. */
  canRead(fileName: string, head: Uint8Array): boolean;
  read(bytes: Uint8Array, pack: { packId: string; dirName: string }): { packName: string; assets: CatalogAsset[]; warnings: string[] };
}

/** Result of a refresh (startup auto-check or "Refresh asset library"), shown to the user. */
export interface CatalogChangeReport {
  previousGeneratedAt: string | null;
  sourceUsed: Record<string, CatalogSourceId>;   // packId → source
  added: number;
  removed: Array<{ uuid: string; name: string }>;
  newlyDeprecated: Array<{ uuid: string; name: string }>;
  geometryChanged: Array<{ uuid: string; name: string }>;
  /** Palette roles affected by removed/deprecated/changed assets (they fall back; see diagnostics). */
  affectedPaletteRoles: Array<{ paletteId: string; role: RoleName; uuid: string; resolution: "alternate" | "fallback_role" | "dropped" }>;
}

// ───────────────────────────── orientation calibration (data-driven, ONE place) ─────────────────────────────

/**
 * Every convention the format research could not verify offline lives here, loaded from
 * data/orientation.json (bundled) and overridable by userData/orientation.json. Correcting a convention after
 * pasting data/calibration-slab.txt in game is a data edit, never a code change. Golden tests pin the default file.
 */
export interface OrientationCalibration {
  schema: "slabyrinth/orientation@1";
  /** CONFIRMED in game: +x = East, +z = North ⇒ true: world z = (H − 1 − row), x = col, no mirroring. */
  flipZ: boolean;
  /** CONFIRMED: increasing rot is CLOCKWISE seen from above (north-up). +1 = clockwise. */
  rotSense: 1 | -1;
  /**
   * CONFIRMED: edge pieces are stored at the min corner of their ROTATED footprint, so rotation never chooses the half
   * of the cell: rot 0/12 → runs east-west in the low-z (south) half; rot 6/18 → runs north-south in the low-x (west)
   * half. North/east edges are produced by +0.5 on z/x of the stored position. Values below are the defaults:
   *   S: {rotSteps:[0,12], offset:{x:0,z:0}}   N: {rotSteps:[0,12], offset:{x:0,z:0.5}}
   *   W: {rotSteps:[6,18], offset:{x:0,z:0}}   E: {rotSteps:[6,18], offset:{x:0.5,z:0}}
   * Which of the two rotation choices is used is decided by the role's `facing` data (doors: handle end) — walls look the
   * same on both faces (confirmed), so either is fine for them.
   */
  edgePlacement: Record<"N" | "E" | "S" | "W", { rotSteps: [number, number]; offset: { x: number; z: number } }>;
  /** Fallback rot-0 facing for roles whose palette entry has no `facing` data (props' "front" is still unverified). */
  defaultFacing: Record<string, PaletteFacing>;   // keys: role prefix ("feature", "link.stairs") or "*"
  /**
   * Features that stand with their back against an adjacent wall (beds, bookshelves, thrones…): when one sits along a
   * wall the compiler turns it to face away from that wall. Feature type names; absent = none.
   */
  wallFacingFeatures?: string[];
  /**
   * Which end the door handle should be at, per edge orientation (doors whose palette facing has a handleEnd).
   * eastWestEdge: doors on N/S edges (default "W"); northSouthEdge: doors on E/W edges (default "N").
   */
  doorHandlePreference?: { eastWestEdge?: Side; northSouthEdge?: Side };
  /** Paste anchor assumption, for paste-guide copy only (markers make chunking independent of it). */
  pasteAnchor: "min-corner" | "center" | "unknown";
  /** Who verified what, when (shown in Settings ▸ TaleSpire). */
  verified: Array<{ item: string; by: string; date: string }>;
}

/**
 * Per-asset orientation at rot 0, in compass terms on a north-up map (data-driven; assets differ).
 * Verified examples: "Dungeon Stairs" {ascendsToward:"W"}; "Door - Dungeon" {handleEnd:"W"} (runs E-W in the south
 * half at rot 0; rot 12 puts the handle at the east end).
 * The compiler computes rot = rotationToTurn(from rot-0 direction to wanted direction) using rotSense, in 15° steps.
 */
export interface PaletteFacing {
  /** Direction a person faces when looking at the asset's front (props, statues, thrones). Unverified ⇒ "S". */
  front?: "N" | "E" | "S" | "W";
  /** Stairs / ramps: direction of ascent at rot 0. */
  ascendsToward?: "N" | "E" | "S" | "W";
  /** Doors: which end the handle is at, at rot 0. */
  handleEnd?: "N" | "E" | "S" | "W";
  /** Wall-mounted props: side of the asset that touches the wall at rot 0. */
  mountsOn?: "N" | "E" | "S" | "W";
}

// ───────────────────────────── palettes (user-editable data) ─────────────────────────────

/**
 * Role naming (semantic → assets):
 *   floor.<Material>            floor tile(s) for a cell surface
 *   fill.<Material|"default">   filler block stacked under raised cells / foundations
 *   wall.<WallStyle>            straight wall segment for ONE edge (length 1)
 *   wall_post.<WallStyle>       optional corner/end post at vertices
 *   opening.<OpeningKind>       door/window asset that REPLACES the wall segment(s)
 *   link.<LinkKind>             stairs/ladder/… for one width × run
 *   feature.<FeatureType>       furniture / dressing / vegetation
 *   ledge.<Material|"default">  optional edge trim where heights differ
 *   marker.alignment            alignment marker prop (§4.6)
 */
export type RoleName = string;

export type RotationRule =
  | "fixed"        // always variant.rot
  | "facing"       // follow feature rot / edge orientation (+ variant.rot correction)
  | "random90"     // seeded 0/90/180/270 (floors: breaks repetition)
  | "random15"     // seeded multiple of 15° (organic props)
  | "inherit";     // use resolved feature rotFine

export interface PaletteVariant {
  /** Preferred asset uuid. */
  asset: string;
  /**
   * Ordered fallback uuids tried when `asset` is missing or deprecated in the current catalog (game updates).
   * First available wins; if none, the variant is skipped with an "asset_unknown" warning — never a hard failure.
   */
  alternates?: string[];
  /** Geometry for each alternate uuid (same shape as geom); an alternate without geometry is never used. */
  alternateGeom?: Record<string, PaletteVariant["geom"]>;
  /**
   * REQUIRED geometry (size, originAt, boundsCenter, lengthAxis) — the compiler reads geometry ONLY from here.
   * Copied from the catalog when the palette was made. A scanned catalog may report a mismatch (info diagnostic),
   * it never changes placement. Alternates carry their own geometry in `alternateGeom`.
   */
  geom: {
    size: { x: number; y: number; z: number };
    originAt: "minCorner" | "center" | "other";
    boundsCenter: { x: number; y: number; z: number };
    lengthAxis?: "x" | "z" | "square";
  };
  /** Display name at palette-creation time (diagnostics when the uuid is gone). */
  name?: string;
  /** Relative pick weight (default 1). Picks are seeded per placement (§4.3). */
  weight?: number;
  /**
   * Variant key matched against Feature.variant / scatter variants (e.g. "round", "broken").
   * Separate from `name`, which is the asset's display name and is for diagnostics only.
   */
  variant?: string;
  /** Footprint in cells this asset covers at rot 0 (w east-west, h north-south). Default role.footprint. */
  footprint?: readonly [w: number, h: number];
  /** Correction rotation in degrees (multiple of 15) added before encoding, to fix model orientation. */
  rot?: number;
  /** Correction offset in tiles applied after rotation (x east, y up, z north). */
  offset?: { x?: number; y?: number; z?: number };
  /** Uniform stacking: number of copies stacked vertically to reach `height` (walls). */
  stack?: { unitHeight: Height };
  /** rot-0 orientation of this asset (overrides role.facing and OrientationCalibration.defaultFacing). */
  facing?: PaletteFacing;
}

export interface PaletteRole {
  variants: PaletteVariant[];    // ≥ 1, or empty for an alias role that only sets `fallback`
  footprint?: readonly [w: number, h: number];   // default [1,1]
  rotation?: RotationRule;       // default: floors random90, walls facing, features facing
  /**
   * Edge-mounted roles (wall/opening): where the asset sits relative to the edge. Research: TaleSpire wall
   * tiles are 0.5 deep and occupy the half of a cell next to one edge (NOT centred on the grid line).
   *  "half-cell": 0.5-deep strip inside the HOST cell chosen by the resolver (EdgeGrid.host) — default
   *  "full-cell": block wall filling the whole host cell (cave wall blocks; warns if host cell is open)
   *  "edge-center": centred on the edge line (only for assets authored that way)
   */
  mount?: "half-cell" | "full-cell" | "edge-center";
  /** Unrotated axis the piece runs along ("x" or "z"); from the catalog (lengthAxis). Walls/openings only. */
  lengthAxis?: "x" | "z" | "square";
  /** Natural height of one asset in tiles (walls, fill). */
  height?: Height;
  /** Floors: try larger variants first (2×2) where the covered cells match. Walls: use length-2 pieces along straight runs. Default true. */
  greedyTiling?: boolean;
  /** Fallback role name tried when this role has no usable variant. */
  fallback?: RoleName;
  /** rot-0 orientation shared by the role's variants unless a variant overrides it. */
  facing?: PaletteFacing;
}

export interface Palette {
  schema: "slabyrinth/palette@1";
  id: ThemeId;                   // theme id this palette implements
  name: string;
  description?: string;
  /** Inherit roles from another palette id (single inheritance, no cycles). */
  extends?: ThemeId;
  /** Theme defaults used by the resolver (rendering + compile). */
  defaults: {
    floor: Material;
    wallStyle: WallStyle;
    caveFloor?: Material;
  };
  roles: Record<RoleName, PaletteRole>;
  source?: { generatedBy?: string; generatedAt?: string; editedByUser?: boolean };
}

/**
 * User override layer (userData/palettes/<id>.json). Bundled defaults ship in the app (core/data/palettes) and are
 * never edited in place; a user file with `overrides: true` deep-merges per ROLE onto the bundled palette of the
 * same id (role replaced wholesale; `null` deletes a role). A user file without `overrides` is a whole new theme.
 */
export interface PaletteOverride {
  schema: "slabyrinth/palette@1";
  id: ThemeId;
  overrides: true;
  name?: string;
  defaults?: Partial<Palette["defaults"]>;
  roles: Record<RoleName, PaletteRole | null>;
}

/**
 * DEPENDENCY DIRECTION (normative):
 *   compiler ──depends on──► palettes (complete: uuid + name + geometry + rotation rule per variant)
 *   compiler ──optionally consults──► AssetAvailability (derived from the scanned catalog, if any)
 *   The compiler NEVER needs the full catalog. Without an install the app builds from bundled palettes alone
 *   (startup warning "using built-in asset set"). With a catalog, availability only decides whether to skip a
 *   variant whose uuid is missing/deprecated in the user's game (then alternates → fallback role → dropped+warning).
 * The full catalog is an enrichment source for: availability, names for unknown uuids (decoded/imported slabs),
 * "custom" feature hint search, and the future palette editor.
 */
export interface AssetAvailability {
  /** "present" | "deprecated" | "missing"; null = no catalog loaded (treat everything as present). */
  status(uuid: string): "present" | "deprecated" | "missing" | null;
  /** Optional name lookup for diagnostics / stamps. */
  name(uuid: string): string | null;
  /** Keyword search for Feature type "custom" (hint); empty without catalog. */
  search(hint: string, kind?: "tile" | "prop"): Array<{ uuid: string; name: string; geom: PaletteVariant["geom"] }>;
}

/** All palettes visible to the app: bundled defaults (core/data/palettes) layered with user overrides (userData/palettes). */
export interface PaletteCatalog {
  palettes: Record<ThemeId, Palette>;
  /** Built from the cached catalog when available; a null-object implementation otherwise. */
  availability: AssetAvailability;
}

// ───────────────────────────── stage: realize (placement) ─────────────────────────────

export type PlacementRole = "floor" | "fill" | "wall" | "wall_post" | "opening" | "link" | "feature" | "ledge" | "marker";

/** One asset instance in WORLD space (TaleSpire axes): x east, y up, z north; units = tiles. */
export interface Placement {
  asset: string;                 // uuid
  x: number; y: number; z: number;
  /** Degrees, multiple of 15, 0..345. Converted to the codec's rotation index by the codec. */
  rot: number;
  role: PlacementRole;
  levelId: LevelId;
  /** Plan element / cell that produced it (for diagnostics & chunk affinity). */
  source: { elementId?: ElementId | string; cell?: readonly [number, number] };
}

export interface PlacementSet {
  planId: string;
  planVersion: number;
  /** Per level, in deterministic order (role order then y,x). */
  levels: { levelId: LevelId; placements: Placement[] }[];
  /** World-space AABB of everything, tiles. */
  bounds: Box3;
  diagnostics: CompileDiagnostic[];
  stats: { byRole: Record<PlacementRole, number>; total: number; distinctAssets: number };
}

export interface Box3 { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

// ───────────────────────────── slab codec seam (implemented by WP3 from the research) ─────────────────────────────

export interface SlabAsset {
  uuid: string;
  /** Scaled integer coords as stored in the slab (RESEARCH: 100 = 1 tile; y is vertical; 18-bit unsigned). */
  sx: number; sy: number; sz: number;
  /** Codec rotation index (RESEARCH: 0..23, 15° steps). */
  rot: number;
}

export interface SlabCodec {
  readonly formatVersion: number;          // RESEARCH: 2
  /** Hard limits (RESEARCH). */
  readonly limits: {
    maxCompressedBytes: number;            // e.g. 30720 per research draft
    maxAssetsPerLayout: number;            // u16
    maxLayouts: number;                    // u16
    maxCoord: number;                      // 262143 (18 bits)
  };
  /** World tiles → scaled ints (rounding rule per research). */
  toScaled(t: number): number;
  degreesToRot(deg: number): number;
  rotToDegrees(rot: number): number;
  /** Assets → raw (uncompressed) bytes; positions are normalized by the caller (min corner = 0). */
  encodeRaw(assets: readonly SlabAsset[]): Uint8Array;
  /** Full pipeline: raw → gzip → base64 (no fences). Deterministic: fixed gzip header/mtime, fflate level 9. */
  encode(assets: readonly SlabAsset[]): { slab: string; rawBytes: number; compressedBytes: number };
  /**
   * PUBLIC, tested API (not test-only): decodes v2 and legacy v1 (v1 converted to v2 semantics: centre → min corner
   * using catalog bounds when available). Accepts optional backtick fences and surrounding whitespace.
   * Unknown UUIDs are preserved verbatim. Used by the CLI "decode", test vectors, and future stamps (§9.2).
   */
  decode(slab: string): DecodedSlab;
}

export interface DecodedSlab {
  version: 1 | 2;
  assets: SlabAsset[];
  /** Raw bytes after the parsed sections (v2: normally the 0x0000 trailer). */
  trailing: Uint8Array;
  compressedBytes: number;
  rawBytes: number;
}

// ───────────────────────────── RESERVED: imported slab stamps (docs/architecture.md §9.2) ─────────────────────────────

/** Stored in ProjectFile.stamps[stampId]. Opaque asset list; never reverse-compiled. */
export interface StampAsset {
  stampId: string;               // sha256 of the normalized decoded payload
  name: string;
  description?: string;
  source?: string;               // free text / URL the user gave
  /** Original slab string as pasted (lossless round trip). */
  slab: string;
  /** Decoded, normalized to min corner 0 — cached for rendering/compile. */
  assets: SlabAsset[];
  /** Derived summary for the model and the 2D silhouette (recomputed on catalog change). */
  summary?: {
    sizeCells: readonly [w: number, h: number];
    heightTiles: number;
    assetCount: number;
    inventory: Array<{ name: string; uuid: string; count: number; known: boolean }>;
    /** Coarse occupancy rows ('#' occupied, '.' empty), 1 char per cell, top row = north. */
    occupancy: string[];
  };
}

// ───────────────────────────── stage: chunk + encode ─────────────────────────────

export interface ChunkOptions {
  /** Target compressed size as a fraction of the codec limit (headroom), default 0.8 (≈ 24.5 KB of 30,720 bytes). */
  fill?: number;
  /** Initial tile size for spatial splitting (cells), default 32. */
  tileCells?: number;
  /**
   * Corner markers (§4.6): "multi-chunk" (default, UX §8.6.2: always when the level/map has > 1 chunk),
   * "always", or "none".
   */
  alignment?: "multi-chunk" | "always" | "none";
  /** Restrict to levels. */
  levels?: LevelId[];
  /**
   * How levels are laid out in TaleSpire (UX open question §15.1):
   *  "stacked": real elevations (default) · "side_by_side": all levels at elevation 0, offset east by width + gap.
   */
  levelLayout?: "stacked" | "side_by_side";
  sideBySideGap?: number;          // cells, default 10
  /**
   * "fewest" (default, decisions.md "Export: fewest slabs possible"): the whole build — every level — is ONE slab
   * whenever it fits; otherwise whole levels are packed in order into as few chunks as fit, and only a level that does
   * not fit on its own is cut into regions. "per-level": every level gets its own chunk(s).
   */
  grouping?: "fewest" | "per-level";
}

export interface SlabChunk {
  id: string;                    // "<levelIds joined by +>-<n>" e.g. "l1-03", "l1+l2-01"
  /** Lowest level the chunk contains (= levelIds[0]). */
  levelId: LevelId;
  /** Every level the chunk contains, lowest first (a single-slab build holds all levels). */
  levelIds: LevelId[];
  index: number;                 // 1-based within its group of levels (levelIds), in paste order
  countInLevel: number;          // chunks in that group
  slab: string;                  // base64 gzip (no backticks; UI may add fences on copy if research says so)
  compressedBytes: number;
  base64Length: number;
  assetCount: number;
  /** World-space box of the chunk's own content (tiles), excluding markers. */
  bounds: Box3;
  /** Cell rect (plan coords) this chunk covers. */
  cellRect: { x: number; y: number; w: number; h: number };
  /** Human paste instruction, e.g. "Paste so the marker pillar sits on the marker from chunk l1-01". */
  pasteNote: string;
  hasAlignmentMarkers: boolean;
  /** Human label: "West", "Centre"…, plus ruler columns "A–N" (UX §9.2). */
  label: string;
  columns: string;
  /** Offset of this chunk's content min corner from chunk 1 of the same group of levels, in tiles (paste guide). */
  offsetFromFirst: { x: number; y: number; z: number };
  /** SHA-256 hex of the raw (uncompressed) payload — "Changed/Unchanged" badges across rebuilds. */
  contentHash: string;
}

export interface ExportBundle {
  planId: string;
  planVersion: number;
  resolvedHash: string;
  createdAt: string;
  chunks: SlabChunk[];           // paste order: lowest level first, then index
  diagnostics: CompileDiagnostic[];
  stats: {
    totalAssets: number;
    totalChunks: number;
    perLevel: { levelId: LevelId; assets: number; chunks: number }[];
    droppedPlacements: number;
  };
  /** Global paste instructions (markdown) shown in the export view. */
  instructions: string;
  /** "install" if a scanned catalog was available for availability checks, else "builtin" (UX §8.6.1). */
  assetSource: "install" | "builtin";
  /** Assets the palette wanted but the user's game lacks, and what was used instead (UX "substitutes were used"). */
  substitutions: Array<{ role: RoleName; wanted: { uuid: string; name?: string }; used: { uuid: string; name?: string } | null; count: number }>;
  /** Per level paste placement (UX §16 builds[].levels[].placement). */
  levelPlacement: Array<{ levelId: LevelId; pasteOrder: number; kind: "ground" | "storeys-up" | "side-by-side"; storeys?: number; offsetSq?: number }>;
}

// ───────────────────────────── diagnostics ─────────────────────────────

export type CompileDiagnosticCode =
  | "plan_invalid"               // validation errors — compile refused
  | "role_missing"               // no palette role (after fallback chain) → placements dropped
  | "asset_unknown"              // uuid not in catalog
  | "asset_substituted"          // alternate / fallback role used (aggregated into ExportBundle.substitutions)
  | "asset_deprecated"
  | "variant_unknown"            // requested variant not found → default used
  | "custom_unresolved"          // custom feature hint matched nothing
  | "thick_wall_conflict"        // mount:"inner" wall with open cells on both sides
  | "footprint_mismatch"         // asset footprint differs from feature size
  | "coord_overflow"             // map exceeds codec coordinate range
  | "chunk_oversize"             // a single cell's placements exceed the limit (cannot split)
  | "chunk_split"                // info: chunk was split adaptively
  | "theme_fallback"             // unknown theme → default palette used
  // ── verify stage: checks the REALIZED tile set (real asset footprints/heights) against the resolved grid ──
  | "verify_cell_obstructed"     // warning: a realized solid intrudes into a cell the 2D map shows as open floor
  | "verify_door_blocked"        // error: no clear standing room in front of a door on a side it serves
  | "verify_door_no_floor"       // error: a side a door serves has no floor
  | "verify_door_missing"        // error: an opening that needs a door/arch piece has none
  | "verify_door_misplaced"      // error: the door piece is not in its edge's host half-cell
  | "verify_door_buried"         // error: a wall piece overlaps the door piece
  | "verify_door_leads_nowhere"  // warning: one side of the door is rock/void (decorative door)
  | "verify_area_unreachable"    // error: reachable in the plan, but not once real assets are placed
  | "verify_stairs_no_arrival"   // error: the top of the run does not meet the upper floor
  | "verify_stairs_approach_blocked" // error: the cell before the first step is not usable
  | "verify_stairs_arrival_blocked"  // error: the arrival cell is missing floor or walled off
  | "verify_stairwell_closed"    // error: the upper level has floor/solids over the run
  | "verify_link_short"          // error: a ladder/spiral-stair stack or trapdoor hatch does not reach the upper floor top
  | "verify_props_overlap"       // warning (info for organic props): props' bounding boxes overlap
  | "verify_prop_in_wall"        // warning: a prop penetrates a wall piece too deep to nudge
  | "verify_prop_nudged"         // info (repair): a prop was moved out of a wall piece
  | "verify_prop_floating"       // warning: a prop's base is well above its support
  | "verify_prop_sunk"           // warning: a prop's base is buried in the floor
  | "verify_prop_no_floor"       // warning: nothing under a prop
  | "verify_mount_no_wall"       // warning: a wall-mounted prop has no wall piece behind it
  | "verify_prop_outside"        // warning: a prop sits outside the level bounds
  | "verify_floor_missing"       // error: a floor cell of the plan has no floor tile
  | "verify_wall_gap"            // error: a wall edge is not covered by wall pieces up to its height
  | "verify_duplicate_removed"   // info (repair): identical placements at the same position/rotation dropped
  | "verify_bad_coordinate"      // error: a placement with a non-finite coordinate or an invalid rotation (dropped)
  | "verify_pokes_into_level_above"; // warning: a placement rises through the floor of the level above

export interface CompileDiagnostic {
  severity: "error" | "warning" | "info";
  code: CompileDiagnosticCode;
  stage: "validate" | "resolve" | "realize" | "verify" | "chunk" | "encode";
  /** Plain language for the user. */
  message: string;
  levelId?: LevelId;
  elementId?: string;
  cell?: readonly [number, number];
  role?: RoleName;
  /** Aggregated count when the same diagnostic repeats (e.g. 340 trees dropped). */
  count?: number;
  /** Plan-level corrective suggestion the agent can act on (verify stage), e.g. "move opening door_e to …". */
  hint?: string;
  /** All plan elements involved (elementId is the first). */
  elementIds?: string[];
  /** Display names of the assets involved (e.g. the blocker). */
  assets?: string[];
  /** Edge location: `cell` plus the side of that cell the edge lies on. */
  side?: Side;
  /** Set when the verify stage repaired the build automatically: what was changed. */
  repaired?: string;
}

// ───────────────────────────── stage signatures ─────────────────────────────

export type Realize = (
  resolved: import("./resolved").ResolvedPlan,
  palettes: PaletteCatalog,
  opts?: { levels?: LevelId[]; seed?: number; orientation?: OrientationCalibration },
) => PlacementSet;

export type ChunkAndEncode = (set: PlacementSet, codec: SlabCodec, opts?: ChunkOptions) => ExportBundle;

/** Convenience: validate → resolve → realize → chunk → encode. Refuses (diagnostic plan_invalid) on validation errors. */
export type CompilePlan = (
  plan: import("./plan").MapPlan,
  palettes: PaletteCatalog,
  codec: SlabCodec,
  opts?: ChunkOptions,
) => ExportBundle;

/** Cheap estimate for the agent's `compile_preview` tool and the UI badge (no gzip). */
export interface CompileEstimate {
  /** estimatedChunks per level = chunks that level would need on its own. */
  perLevel: { levelId: LevelId; assets: number; estimatedChunks: number }[];
  totalAssets: number;
  /** Chunks for the whole build under the default "fewest" grouping (1 when everything fits in one slab); NOT the sum of perLevel. */
  estimatedChunks: number;
  diagnostics: CompileDiagnostic[];   // role_missing etc., aggregated
}

/** Mapping tables the realizer uses (exported for tests). */
export interface RoleKeys {
  floor(m: Material): RoleName;
  wall(s: WallStyle): RoleName;
  opening(k: OpeningKind): RoleName;
  link(k: LinkKind): RoleName;
  feature(t: FeatureType): RoleName;
  edgeSideRotation(side: Side): number;   // N=0, E=90, S=180, W=270 before palette correction
}
