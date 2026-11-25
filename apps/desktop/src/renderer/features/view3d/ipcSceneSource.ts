/**
 * The SceneSource over the main process: a one-to-one mapping onto the `view3d:*` channels (docs/contracts/ipc.ts on
 * branch view3d-host: view3d:open, view3d:chunks, view3d:meshes, view3d:cancel, view3d:close, event view3d:progress),
 * whose shapes ./sceneSource.ts mirrors field for field.
 *
 * TODO(view3d-host): when the channels are on this branch, pass `window.slabyrinth` (through the renderer's bridge
 * client) as `bridge` and replace `View3dBridge` with the contract's `IpcRequests` / `IpcEvents` types. Errors arrive
 * as the bridge's `Result` failures; their codes map to SceneSourceError codes below.
 */
import {
  SceneSourceError,
  type InstanceChunk,
  type MeshGeometry,
  type SceneHeader,
  type SceneProgress,
  type SceneSource,
  type SceneSourceErrorCode,
} from "./sceneSource";

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** The slice of the preload API the source uses (the contract's channels, typed by sceneSource.ts). */
export interface View3dBridge {
  invoke(channel: "view3d:open", req: { buildId: string }): Promise<Result<SceneHeader>>;
  invoke(
    channel: "view3d:chunks",
    req: { sceneId: string; chunkIds: string[] },
  ): Promise<Result<{ chunks: InstanceChunk[]; more: string[] }>>;
  invoke(
    channel: "view3d:meshes",
    req: { sceneId: string; keys: string[] },
  ): Promise<Result<{ meshes: MeshGeometry[]; more: string[] }>>;
  invoke(channel: "view3d:cancel", req: { sceneId?: string }): Promise<Result<undefined>>;
  invoke(channel: "view3d:close", req: { sceneId: string }): Promise<Result<undefined>>;
  on(channel: "view3d:progress", listener: (p: SceneProgress) => void): () => void;
}

const CODES: Readonly<Record<string, SceneSourceErrorCode>> = {
  not_found: "not-found",
  cancelled: "cancelled",
  too_big: "too-big",
};

async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new SceneSourceError(CODES[r.error.code] ?? "failed", r.error.message);
}

export function ipcSceneSource(bridge: View3dBridge): SceneSource {
  return {
    label: "main process",
    open: (buildId) => unwrap(bridge.invoke("view3d:open", { buildId })),
    chunks: (sceneId, chunkIds) => unwrap(bridge.invoke("view3d:chunks", { sceneId, chunkIds })),
    meshes: (sceneId, keys) => unwrap(bridge.invoke("view3d:meshes", { sceneId, keys })),
    cancel: (sceneId) => {
      bridge.invoke("view3d:cancel", sceneId === undefined ? {} : { sceneId }).catch((e: unknown) => {
        console.warn("view3d:cancel failed", e);
      });
    },
    close: (sceneId) => {
      bridge.invoke("view3d:close", { sceneId }).catch((e: unknown) => {
        console.warn("view3d:close failed", e);
      });
    },
    onProgress: (fn) => bridge.on("view3d:progress", fn),
  };
}
