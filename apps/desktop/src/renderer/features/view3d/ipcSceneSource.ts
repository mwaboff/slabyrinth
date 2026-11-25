/**
 * The SceneSource over the main process: a one-to-one mapping onto the `view3d:*` channels (view3d:open,
 * view3d:chunks, view3d:meshes, view3d:cancel, view3d:close, event view3d:progress) through the renderer's bridge
 * (`window.slabyrinth`, or the fake bridge behind the same interface). Failures arrive as the bridge's `Result`
 * errors; their codes become SceneSourceError codes. Swapping the boxes scene for the detailed one when "detail"
 * progress completes is the engine's (it opens the same target again); the source only forwards.
 */
import type { AppError, Result, SlabyrinthApi } from "../../../shared/ipc";
import { bridge } from "../../bridge/client";
import { SceneSourceError, type SceneSource, type SceneSourceErrorCode } from "./sceneSource";

/** The slice of the preload API the source uses. */
export type View3dBridge = Pick<SlabyrinthApi, "invoke" | "on">;

const CODES: Partial<Record<AppError["code"], SceneSourceErrorCode>> = {
  not_found: "not-found",
  cancelled: "cancelled",
  validation: "no-plan",
};

/** Other failures keep main's own plain sentence ("This map is too big to show in 3D on this PC…"). */
async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new SceneSourceError(CODES[r.error.code] ?? "failed", r.error.message);
}

/** The source over `api` (default: the installed bridge, read when first used). */
export function ipcSceneSource(api?: View3dBridge): SceneSource {
  const b = (): View3dBridge => api ?? bridge();
  const quietly = (what: string, p: Promise<Result<void>>): void => {
    p.then(
      (r) => {
        if (!r.ok) console.warn(`${what} failed: ${r.error.message}`);
      },
      (e: unknown) => {
        console.warn(`${what} failed`, e);
      },
    );
  };
  return {
    label: "main process",
    open: (target) =>
      unwrap(
        b().invoke(
          "view3d:open",
          target.buildId !== undefined
            ? { buildId: target.buildId }
            : target.version !== undefined
              ? { version: target.version }
              : {},
        ),
      ),
    chunks: (sceneId, chunkIds) => unwrap(b().invoke("view3d:chunks", { sceneId, chunkIds })),
    meshes: (sceneId, keys) => unwrap(b().invoke("view3d:meshes", { sceneId, keys })),
    cancel: (sceneId) => {
      quietly("view3d:cancel", b().invoke("view3d:cancel", sceneId === undefined ? {} : { sceneId }));
    },
    close: (sceneId) => {
      quietly("view3d:close", b().invoke("view3d:close", { sceneId }));
    },
    onProgress: (fn) => b().on("view3d:progress", fn),
  };
}
