/**
 * The port the 3D viewer reads a scene through: the `view3d:*` channels' own shapes (docs/contracts/ipc.ts
 * View3dHeader, View3dChunk, View3dMesh, event view3d:progress), so `ipcSceneSource` is a thin mapping onto the bridge
 * and `memorySceneSource` serves the same thing from a scene3d `Scene` for tests and the e2e harness.
 *
 * The header carries no per-piece data: levels, the colour key, the mesh table (each mesh's own-frame bounds, so a box
 * can stand in until the geometry arrives) and the chunk table (32 × 32 tiles per level, with bounds and sizes), which
 * is what the viewer culls and budgets on before fetching any chunk. Chunks and meshes are pulled on demand, at most
 * a reply's worth at a time (the rest comes back in `more`).
 *
 * World axes are TaleSpire's (x east, y up, z north), units are tiles, turns are degrees clockwise seen from above:
 * an instance's mesh is turned about y, then moved to x, y, z (scene3d's rule).
 */
import type { IpcEvents, View3dBox, View3dChunk, View3dHeader, View3dMesh } from "../../../shared/ipc";

/** An axis-aligned box in tiles. */
export type WireBox = View3dBox;
/** What the renderer needs to draw a scene (levels, colour key, mesh and chunk tables, counts, boxes, detail). */
export type SceneHeader = View3dHeader;
/** One chunk's instances (index i of every per-instance array is the same piece). */
export type InstanceChunk = View3dChunk;
export type MeshGeometry = View3dMesh;
/** "layout": the scene is being built; "detail": game shapes are being read (open again when done === total). */
export type SceneProgress = IpcEvents["view3d:progress"];

/** What to show: a plan version (absent: the head) or a build (its plan version), as `view3d:open` takes it. */
export interface SceneTarget {
  version?: number;
  buildId?: string;
}

/** A stable key of a target (for effects and logs). */
export const targetKey = (t: SceneTarget): string =>
  t.buildId !== undefined ? `build:${t.buildId}` : t.version !== undefined ? `v${String(t.version)}` : "head";

/** failed: anything else, with the source's own plain sentence as the message. */
export type SceneSourceErrorCode = "not-found" | "cancelled" | "no-plan" | "failed";

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
  /** Lays out the scene of a plan version or build and returns its header (`view3d:open`). */
  open(target: SceneTarget): Promise<SceneHeader>;
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
