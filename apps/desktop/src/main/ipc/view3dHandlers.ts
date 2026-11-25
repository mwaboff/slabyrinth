import type { IpcRequests, MeshCacheInfo } from "../../shared/ipc";
import { AppFailure } from "../util/errors";
import type { Handler } from "./router";

/**
 * The 3D view's and the piece cache's IPC handlers (design render-tools §4.5). The services behind them live in
 * services/view3d (the scene worker) and services/meshes (the piece cache); these only delegate.
 */
type Req<C extends keyof IpcRequests> = IpcRequests[C]["req"];
type Res<C extends keyof IpcRequests> = IpcRequests[C]["res"];

/** What the view3d channels ask of main (services/view3d/view3dService.ts). */
export interface View3dApi {
  open(req: Req<"view3d:open">): Promise<Res<"view3d:open">>;
  chunks(req: Req<"view3d:chunks">): Promise<Res<"view3d:chunks">>;
  meshes(req: Req<"view3d:meshes">): Promise<Res<"view3d:meshes">>;
  shot(req: Req<"view3d:shot">): Promise<Res<"view3d:shot">>;
  cancel(sceneId: string | undefined): void;
  close(sceneId: string): Promise<void>;
}

/** What the meshes channels ask of main (services/meshes/meshService.ts). */
export interface MeshesApi {
  info(): Promise<MeshCacheInfo>;
  rebuild(): Promise<MeshCacheInfo>;
  clear(): Promise<MeshCacheInfo>;
}

type View3dChannel = Extract<keyof IpcRequests, `view3d:${string}` | `meshes:${string}`>;
export type View3dHandlers = { [C in View3dChannel]: Handler<C> };

export function view3dHandlers(s: { view3d: View3dApi; meshes: MeshesApi }): View3dHandlers {
  return {
    "view3d:open": (req) => s.view3d.open(req),
    "view3d:chunks": (req) => s.view3d.chunks(req),
    "view3d:meshes": (req) => s.view3d.meshes(req),
    "view3d:shot": (req) => s.view3d.shot(req),
    "view3d:cancel": (req) => {
      s.view3d.cancel(req.sceneId);
    },
    "view3d:close": (req) => s.view3d.close(req.sceneId),
    "meshes:info": () => s.meshes.info(),
    "meshes:rebuild": () => s.meshes.rebuild(),
    "meshes:clear": () => s.meshes.clear(),
  };
}

const NOT_READY = "The 3D view isn't available in this build yet.";

/** Stand-ins that answer every 3D request with a typed "unsupported" (and the cache as off). */
export function unavailableView3d(): { view3d: View3dApi; meshes: MeshesApi } {
  const refuse = (): never => {
    throw new AppFailure("unsupported", NOT_READY);
  };
  const off: MeshCacheInfo = {
    state: "off",
    read: 0,
    boxes: 0,
    extracting: false,
    bytes: 0,
    limitBytes: 0,
    message: NOT_READY,
  };
  return {
    view3d: {
      open: () => Promise.resolve().then(refuse),
      chunks: () => Promise.resolve().then(refuse),
      meshes: () => Promise.resolve().then(refuse),
      shot: () => Promise.resolve().then(refuse),
      cancel: () => undefined,
      close: () => Promise.resolve(),
    },
    meshes: {
      info: () => Promise.resolve({ ...off }),
      rebuild: () => Promise.resolve({ ...off }),
      clear: () => Promise.resolve({ ...off }),
    },
  };
}
