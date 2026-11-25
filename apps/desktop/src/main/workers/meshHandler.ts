import type { ReadonlyFs } from "@slabyrinth/core";
import { installMeshSource, type BundleExtractor } from "@slabyrinth/scene3d";
import { DiskMeshCache } from "../services/meshes/diskCache";
import { nodeReadonlyFs } from "../services/talespire/steamLocator";
import type { MeshWorkerRequest, MeshWorkerResponse } from "./meshProtocol";

/**
 * Worker-side reader of pieces' shapes (pure of worker plumbing: mesh.worker wires it to parentPort; tests call it
 * directly with a synthetic install). Reads the install read-only, one bundle at a time (scene3d releases each before
 * the next), and writes the decoded shapes to the app's own cache folder.
 */
export function createMeshHandler(
  o: { fs?: ReadonlyFs; extract?: BundleExtractor } = {},
): (msg: MeshWorkerRequest, post: (r: MeshWorkerResponse) => void) => Promise<void> {
  return async (msg, post) => {
    try {
      const cache = new DiskMeshCache(msg.cacheDir, msg.limitBytes);
      const source = installMeshSource({
        fs: o.fs ?? nodeReadonlyFs,
        installPath: msg.installPath,
        cache,
        ...(o.extract ? { extract: o.extract } : {}),
        onProgress: (done, total) => {
          post({ type: "progress", id: msg.id, done, total });
        },
      });
      const got = await source.load(msg.uuids);
      let read = 0;
      for (const v of got.values()) if (v.kind === "mesh") read++;
      post({ type: "read", id: msg.id, read, failed: got.size - read, bytes: cache.bytes });
    } catch (err) {
      post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  };
}
