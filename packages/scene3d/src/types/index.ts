/**
 * The types every layer of scene3d shares: meshes and the port that supplies them, the scene, cameras and shots.
 * World axes are TaleSpire's (x east, y up, z north), units are tiles, turns are degrees clockwise seen from above.
 */
import type { Box3, PaletteVariant, PlacementRole } from "@slabyrinth/core";

export type { Box3 } from "@slabyrinth/core";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 0..255 per channel. */
export type Rgb = readonly [r: number, g: number, b: number];

/** A piece's collider geometry as the compiler and the game place it (the palette's `geom`, or the catalog's). */
export type PieceGeom = PaletteVariant["geom"];

/** Triangles in a piece's own frame (before placement): xyz triples and triangle vertex indices. */
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Why a piece is drawn as a box of its real size instead of its game mesh. */
export type FallbackReason =
  /** the run asked for boxes only */
  | "boxes-requested"
  /** no TaleSpire install was found */
  | "no-install"
  /** the install's pack indexes do not list the asset */
  | "not-in-index"
  /** the index lists the asset with no mesh parts */
  | "no-parts"
  /** a bundle file a part names is not on disk */
  | "bundle-missing"
  /** the bundle's container or serialized-file version is one the readers do not know */
  | "unsupported-format"
  /** the bundle was readable but the part's prefab or mesh was not */
  | "decode-failed";

/** What a mesh source answers for one asset: its mesh (and the collider the game places it by), or why not. */
export type MeshLookup =
  | { kind: "mesh"; mesh: MeshData; geom?: PieceGeom }
  | { kind: "box"; reason: FallbackReason; detail?: string };

/**
 * The port that supplies game meshes. The CLI reads the install from Node; the app reads it in its main process;
 * tests and runs without an install use `boxMeshSource`. Asked once per scene with every distinct asset id.
 */
export interface MeshSource {
  /** A short plain description for reports ("boxes only", "TaleSpire at C:\…"). */
  readonly label: string;
  load(uuids: readonly string[]): Promise<ReadonlyMap<string, MeshLookup>>;
}

/** One asset id drawn as a box, with why and how many instances. */
export interface Fallback {
  uuid: string;
  name: string;
  reason: FallbackReason | "no-geometry";
  detail?: string;
  count: number;
}

/** Plain colour classes (general rules over role, layer, material and catalog facts: scene/colour.ts). */
export type ColourClass =
  | "marker"
  | "roof"
  | "water"
  | "wall"
  | "opening"
  | "stairs"
  | "floor"
  | "terrain"
  | "light"
  | "plant"
  | "tall_prop"
  | "prop"
  | "unknown";

/** One placed piece. Its world transform is: turn the mesh `rotDeg` clockwise about y, then add `at`. */
export interface SceneInstance {
  uuid: string;
  name: string;
  /** Key into `Scene.meshes` (the uuid for a game mesh, `box:<uuid>` for a stand-in). */
  meshKey: string;
  rotDeg: number;
  at: Vec3;
  /** World box of the drawn mesh. */
  aabb: Box3;
  colourClass: ColourClass;
  colour: Rgb;
  levelId: string;
  /** Index into `Scene.levels` (lowest level 0). */
  levelIndex: number;
  /** Paste layer: "site", "storey:<n>" or "roof". */
  layer: string;
  role: PlacementRole | null;
  elementId: string | null;
  /** Plan cell the piece came from. */
  cell: readonly [x: number, y: number] | null;
  /** Drawn as its game mesh, or as a box of its collider. */
  stand: "mesh" | "box";
}

export interface SceneLevel {
  id: string;
  name: string;
  /** Lowest level 0, in order of elevation. */
  index: number;
  /** Box of the level's instances (empty level: its elevation as a point). */
  bounds: Box3;
}

export interface Scene {
  origin: "build" | "slab";
  instances: SceneInstance[];
  meshes: ReadonlyMap<string, MeshData>;
  levels: SceneLevel[];
  bounds: Box3;
  fallbacks: Fallback[];
  /** `MeshSource.label` of the source the scene was built with. */
  meshSource: string;
}

/** A camera: perspective (fovDeg) or orthographic (halfHeight, world units from the centre to the top edge). */
export interface Camera {
  projection: "ortho" | "persp";
  eye: Vec3;
  target: Vec3;
  /** Vertical field of view (perspective). */
  fovDeg: number;
  /** Half the visible height in tiles (orthographic). */
  halfHeight: number;
}

/** What a shot leaves out. */
export interface Cutaway {
  /** Draw only levels with index ≤ this. */
  maxLevelIndex?: number;
  /** Paste layers hidden on every level ("roof"). */
  hideLayers?: string[];
  /** Hide paste layers whose storey number is above this ("storey:2" with maxStorey 1). */
  maxStorey?: number;
}

export interface ShotSpec {
  /** File-safe id, unique in a run ("overview", "level-cellar", "front-b3"). */
  id: string;
  /** The rule that chose it ("overview", "top", "level", "front", "interior", "camera"). */
  rule: string;
  /** Plain words for the index and contact sheets. */
  caption: string;
  camera: Camera;
  cutaway: Cutaway;
  width: number;
  height: number;
  /** Element ids or level id the shot is about. */
  targets: string[];
}

export interface RenderStats {
  instancesDrawn: number;
  /** Of those, drawn as boxes (stand-ins, or too small on screen for their mesh). */
  boxesDrawn: number;
  trianglesDrawn: number;
}

/** A rendered picture with its id and depth buffers (for checks and visibility probes). */
export interface RenderedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Index into Scene.instances drawn at each pixel, -1 where empty. */
  idAt: Int32Array;
  stats: RenderStats;
}
