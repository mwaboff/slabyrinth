/**
 * A SceneSource over scene3d `Scene`s held in memory, packed exactly as main packs them for IPC (shared/view3dWire.ts:
 * a header without per-piece data, chunks of 32 × 32 tiles per level, meshes by key, replies capped in bytes with the
 * rest in `more`), so tests and the e2e harness exercise the same pull protocol as the app. Every answer is
 * asynchronous. A build may have a boxes scene first and a detailed one later: the source then reports "detail"
 * progress and the next open returns the detailed scene, as main does when it has read the game's shapes.
 */
import type { Scene } from "@slabyrinth/scene3d";
import { packScene as packWire, takeWithin } from "../../../shared/view3dWire";
import {
  SceneSourceError,
  type InstanceChunk,
  type MeshGeometry,
  type SceneHeader,
  type SceneProgress,
  type SceneSource,
} from "./sceneSource";

export interface PackedScene {
  header: SceneHeader;
  chunks: ReadonlyMap<string, InstanceChunk>;
  meshes: ReadonlyMap<string, MeshGeometry>;
}

/** Packs a scene into the wire shapes, with the ids main would add. */
export function packScene(scene: Scene, sceneId: string, buildId: string, pendingDetail = 0): PackedScene {
  const p = packWire(scene);
  return {
    header: { ...p.header, sceneId, version: 1, buildId, pendingDetail, limited: null },
    chunks: p.chunks,
    meshes: p.meshes,
  };
}

export interface MemorySourceOptions {
  /** Most bytes in one chunks or meshes reply (default 8 MB, as IPC). */
  maxReplyBytes?: number;
  /** Delay of every answer, ms (default 0: next task). */
  delayMs?: number;
  /** When a build has a detailed scene: ms after the first open before "detail" completes (default 50). */
  detailAfterMs?: number;
}

/** A build's scene: one scene, or boxes first and the detailed scene once its shapes are "read". */
export type MemoryBuild = Scene | { boxes: Scene; detail: Scene };

/** The source over `builds`, keyed by build id (a target without a build id finds nothing). */
export function memorySceneSource(
  builds: ReadonlyMap<string, MemoryBuild>,
  opts: MemorySourceOptions = {},
): SceneSource {
  const max = opts.maxReplyBytes ?? 8 * 1024 * 1024;
  const open = new Map<string, PackedScene>();
  const detailed = new Set<string>();
  const listeners = new Set<(p: SceneProgress) => void>();
  let serial = 0;
  const later = <T>(fn: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, opts.delayMs ?? 0);
    });
  const scene = (sceneId: string): PackedScene => {
    const s = open.get(sceneId);
    if (!s) throw new SceneSourceError("not-found", `No scene ${sceneId}.`);
    return s;
  };
  return {
    label: "in memory",
    open(target) {
      return later(() => {
        const buildId = target.buildId ?? "";
        const b = builds.get(buildId);
        if (!b) throw new SceneSourceError("not-found", `No scene for build ${buildId}.`);
        const sceneId = `mem-${String(++serial)}`;
        const two = !("instances" in b);
        const useDetail = !two || detailed.has(buildId);
        const s = two ? (useDetail ? b.detail : b.boxes) : b;
        const pending = useDetail ? 0 : s.instances.length;
        const packed = packScene(s, sceneId, buildId, pending);
        open.set(sceneId, packed);
        for (const fn of listeners)
          fn({ sceneId, stage: "layout", done: s.instances.length, total: s.instances.length });
        if (!useDetail)
          setTimeout(() => {
            detailed.add(buildId);
            for (const fn of listeners) fn({ sceneId, stage: "detail", done: pending, total: pending });
          }, opts.detailAfterMs ?? 50);
        return packed.header;
      });
    },
    chunks(sceneId, chunkIds) {
      return later(() => {
        const s = scene(sceneId);
        const r = takeWithin(chunkIds, (id) => s.chunks.get(id), max);
        return { chunks: r.items, more: r.more };
      });
    },
    meshes(sceneId, keys) {
      return later(() => {
        const s = scene(sceneId);
        const r = takeWithin(keys, (k) => s.meshes.get(k), max);
        return { meshes: r.items, more: r.more };
      });
    },
    cancel() {
      // nothing is laid out in the background
    },
    close(sceneId) {
      open.delete(sceneId);
    },
    onProgress(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
