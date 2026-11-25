import type { AssetCatalog, MapPlan } from "@slabyrinth/core";
import type { ShotName } from "@slabyrinth/scene3d";
import type { View3dChunk, View3dMesh } from "../../shared/ipc";
import type { PackedHeader } from "../../shared/view3dWire";
import type { SceneMeshes } from "../services/meshes/meshService";

/** What the scene worker needs to lay out a plan's scene (the build's inputs, as the compile worker gets them). */
export interface SceneJob {
  sceneId: string;
  plan: MapPlan;
  /** The plan version before it (for the "changed" view), or null. */
  previous: MapPlan | null;
  userPalettes: Array<{ source: string; data: unknown }>;
  orientationOverride: unknown;
  /** The scanned catalog (names, sizes and facts for colours); null = the bundled palettes alone. */
  catalog: AssetCatalog | null;
  meshes: SceneMeshes;
  /** Most bytes of decoded game shapes the scene may hold; beyond it pieces are boxes ("budget"). */
  meshBudgetBytes: number;
}

/** Messages between View3dService (main thread) and scene.worker. */
export type SceneWorkerRequest =
  | { type: "build"; id: number; job: SceneJob }
  | { type: "chunks"; id: number; sceneId: string; ids: string[]; capBytes: number }
  | { type: "meshes"; id: number; sceneId: string; keys: string[]; capBytes: number }
  | { type: "pictures"; id: number; sceneId: string; shots?: ShotName[]; max?: number }
  | { type: "shot"; id: number; sceneId: string; shot: ShotName; width: number; height: number }
  | { type: "release"; id: number; sceneId: string };

export interface BuiltScene {
  header: PackedHeader;
  /** Asset ids whose shapes are not in the cache yet (read in the background, then the scene is laid out again). */
  pending: string[];
  /** Every asset id of the scene. */
  uuids: string[];
  /** Set when the mesh budget cut detail. */
  limited: string | null;
  ms: number;
}

export type SceneWorkerResponse =
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "built"; id: number; scene: BuiltScene }
  | { type: "chunks"; id: number; chunks: View3dChunk[]; more: string[] }
  | { type: "meshes"; id: number; meshes: View3dMesh[]; more: string[] }
  | { type: "pictures"; id: number; png: Uint8Array; captions: string[]; suggestions: string; views: number }
  | { type: "shot"; id: number; png: Uint8Array; caption: string }
  | { type: "released"; id: number }
  | { type: "error"; id: number; message: string; code?: "not_found" };
