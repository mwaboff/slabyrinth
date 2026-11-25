/**
 * The port the 3D viewer reads a scene through. Its shapes are structurally the IPC channels' (`view3d:open`,
 * `view3d:chunks`, `view3d:meshes`, `view3d:close`, event `view3d:progress`; docs/contracts/ipc.ts View3dHeader,
 * View3dChunk, View3dMesh), so `ipcSceneSource` is a thin mapping and `memorySceneSource` serves the same thing from a
 * scene3d `Scene` for tests and the e2e harness.
 *
 * The header carries no per-piece data: levels, the colour key, the mesh table (each mesh's own-frame bounds, so a box
 * can stand in until the geometry arrives) and the chunk table (32 × 32 tiles per level, with bounds and sizes), which
 * is what the viewer culls and budgets on before fetching any chunk. Chunks and meshes are pulled on demand, at most
 * a reply's worth at a time (the rest comes back in `more`).
 *
 * World axes are TaleSpire's (x east, y up, z north), units are tiles, turns are degrees clockwise seen from above:
 * an instance's mesh is turned about y, then moved to x, y, z (scene3d's rule).
 */

/** An axis-aligned box in tiles. */
export interface WireBox {
  min: [x: number, y: number, z: number];
  max: [x: number, y: number, z: number];
}

export interface SceneHeader {
  sceneId: string;
  version: number;
  buildId: string | null;
  /** Lowest level first; bounds null for a level with no pieces. */
  levels: Array<{ id: string; name: string; index: number; bounds: WireBox | null }>;
  /** null for an empty scene. */
  bounds: WireBox | null;
  /** The colour key in a fixed order (chunk colourClass indexes it); ids are scene3d ColourClass names. */
  classes: Array<{ id: string; label: string; rgb: [r: number, g: number, b: number] }>;
  /** The mesh table (chunk `mesh` indexes it). box: a stand-in of the piece's real size; bounds: its own frame. */
  meshes: Array<{ key: string; triangles: number; bytes: number; box: boolean; bounds: WireBox }>;
  /** Chunks of 32 × 32 tiles per level. */
  chunks: Array<{ id: string; levelIndex: number; bounds: WireBox; instances: number; bytes: number }>;
  counts: { instances: number; boxes: number; triangles: number };
  boxes: { pieces: number; kinds: number; reasons: Array<{ reason: string; pieces: number }>; note: string };
  /** Pieces waiting for their game shape: when progress "detail" completes, open again for the detailed scene. */
  pendingDetail: number;
  limited: string | null;
}

/** One chunk's instances (index i of every per-instance array is the same piece). */
export interface InstanceChunk {
  id: string;
  count: number;
  /** Index into SceneHeader.meshes. */
  mesh: Uint32Array;
  /** x, y, z, turnDeg per instance (4n). */
  transform: Float32Array;
  /** r, g, b (3n). */
  colour: Uint8Array;
  /** Index into SceneHeader.classes. */
  colourClass: Uint8Array;
  /** Index into SceneHeader.levels. */
  level: Uint8Array;
  /** Index into `layers` ("site", "storey:<n>", "roof"). */
  layer: Uint8Array;
  layers: string[];
  /** Index into `names`. */
  name: Uint32Array;
  names: string[];
  /** Index into `elements`, or -1. */
  element: Int32Array;
  elements: string[];
}

export interface MeshGeometry {
  key: string;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface SceneProgress {
  sceneId: string;
  /** "layout": the scene is being built; "detail": game shapes are being read (open again when done === total). */
  stage: "layout" | "detail";
  done: number;
  total: number;
}

export type SceneSourceErrorCode = "not-found" | "cancelled" | "too-big" | "failed";

/** The one error a source raises. */
export class SceneSourceError extends Error {
  readonly code: SceneSourceErrorCode;
  constructor(code: SceneSourceErrorCode, message: string) {
    super(message);
    this.name = "SceneSourceError";
    this.code = code;
  }
}

export interface SceneSource {
  /** Plain words for logs ("in memory", "main process"). */
  readonly label: string;
  /** Lays out the scene of a build and returns its header (`view3d:open`). */
  open(buildId: string): Promise<SceneHeader>;
  /** Instance data of chunks (`view3d:chunks`); ids that did not fit the reply are in `more`. */
  chunks(sceneId: string, chunkIds: string[]): Promise<{ chunks: InstanceChunk[]; more: string[] }>;
  /** Geometry of meshes by key (`view3d:meshes`). */
  meshes(sceneId: string, keys: string[]): Promise<{ meshes: MeshGeometry[]; more: string[] }>;
  /** Stops laying out (`view3d:cancel`). */
  cancel(sceneId?: string): void;
  /** Releases a scene (`view3d:close`). */
  close(sceneId: string): void;
  /** Progress events (`view3d:progress`); returns the unsubscribe. */
  onProgress(fn: (p: SceneProgress) => void): () => void;
}
