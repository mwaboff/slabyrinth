/**
 * A SceneSource over scene3d `Scene`s held in memory, packed as main packs them for IPC (a header without per-piece
 * data, chunks of 32 × 32 tiles per level, meshes by key, replies capped in bytes with the rest in `more`), so tests and
 * the e2e harness exercise the same pull protocol as the app. Every answer is asynchronous. A build may have a boxes
 * scene first and a detailed one later: the source then reports "detail" progress and the next open returns the
 * detailed scene, as main does when it has read the game's shapes.
 */
import { COLOUR_CLASSES, meshBox, type Box3, type ColourClass, type Scene } from "@slabyrinth/scene3d";
import {
  SceneSourceError,
  type InstanceChunk,
  type MeshGeometry,
  type SceneHeader,
  type SceneProgress,
  type SceneSource,
  type WireBox,
} from "./sceneSource";

export const WIRE_CHUNK_TILES = 32;
const CLASS_ORDER = Object.keys(COLOUR_CLASSES) as ColourClass[];

const wireBox = (b: Box3): WireBox => ({
  min: [b.min.x, b.min.y, b.min.z],
  max: [b.max.x, b.max.y, b.max.z],
});
const finite = (b: Box3): boolean => Number.isFinite(b.min.x) && b.max.x >= b.min.x;

export interface PackedScene {
  header: SceneHeader;
  chunks: ReadonlyMap<string, InstanceChunk>;
  meshes: ReadonlyMap<string, MeshGeometry>;
}

/** Packs a scene into the wire shapes. */
export function packScene(scene: Scene, sceneId: string, buildId: string, pendingDetail = 0): PackedScene {
  const keys = [...scene.meshes.keys()].sort();
  const meshIndex = new Map(keys.map((k, i) => [k, i]));
  const meshes = new Map<string, MeshGeometry>();
  const meshRows = keys.map((key) => {
    const m = scene.meshes.get(key);
    const positions = m?.positions ?? new Float32Array(0);
    const indices = m
      ? positions.length / 3 <= 0xffff
        ? Uint16Array.from(m.indices)
        : m.indices
      : new Uint16Array(0);
    meshes.set(key, { key, positions, indices });
    const b = m ? meshBox(m) : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    return {
      key,
      triangles: indices.length / 3,
      bytes: positions.byteLength + indices.byteLength,
      box: key.startsWith("box:"),
      bounds: wireBox(b),
    };
  });
  const groups = new Map<string, { level: number; idx: number[]; box: Box3 }>();
  scene.instances.forEach((inst, i) => {
    const id = `L${inst.levelIndex}:${Math.floor(inst.at.x / WIRE_CHUNK_TILES)}:${Math.floor(inst.at.z / WIRE_CHUNK_TILES)}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        level: inst.levelIndex,
        idx: [],
        box: {
          min: { x: Infinity, y: Infinity, z: Infinity },
          max: { x: -Infinity, y: -Infinity, z: -Infinity },
        },
      };
      groups.set(id, g);
    }
    g.idx.push(i);
    const a = inst.aabb;
    g.box.min.x = Math.min(g.box.min.x, a.min.x);
    g.box.min.y = Math.min(g.box.min.y, a.min.y);
    g.box.min.z = Math.min(g.box.min.z, a.min.z);
    g.box.max.x = Math.max(g.box.max.x, a.max.x);
    g.box.max.y = Math.max(g.box.max.y, a.max.y);
    g.box.max.z = Math.max(g.box.max.z, a.max.z);
  });
  const chunks = new Map<string, InstanceChunk>();
  const chunkRows: SceneHeader["chunks"] = [];
  let triangles = 0;
  let boxes = 0;
  for (const [id, g] of [...groups].sort((a, b) => a[1].level - b[1].level || (a[0] < b[0] ? -1 : 1))) {
    const n = g.idx.length;
    const c: InstanceChunk = {
      id,
      count: n,
      mesh: new Uint32Array(n),
      transform: new Float32Array(n * 4),
      colour: new Uint8Array(n * 3),
      colourClass: new Uint8Array(n),
      level: new Uint8Array(n),
      layer: new Uint8Array(n),
      layers: [],
      name: new Uint32Array(n),
      names: [],
      element: new Int32Array(n),
      elements: [],
    };
    const intern = (list: string[], s: string): number => {
      const k = list.indexOf(s);
      if (k >= 0) return k;
      list.push(s);
      return list.length - 1;
    };
    g.idx.forEach((ii, k) => {
      const inst = scene.instances[ii];
      if (!inst) return;
      const mi = meshIndex.get(inst.meshKey) ?? 0;
      c.mesh[k] = mi;
      c.transform[k * 4] = inst.at.x;
      c.transform[k * 4 + 1] = inst.at.y;
      c.transform[k * 4 + 2] = inst.at.z;
      c.transform[k * 4 + 3] = inst.rotDeg;
      c.colour[k * 3] = inst.colour[0];
      c.colour[k * 3 + 1] = inst.colour[1];
      c.colour[k * 3 + 2] = inst.colour[2];
      c.colourClass[k] = Math.max(0, CLASS_ORDER.indexOf(inst.colourClass));
      c.level[k] = inst.levelIndex;
      c.layer[k] = intern(c.layers, inst.layer);
      c.name[k] = intern(c.names, inst.name);
      c.element[k] = inst.elementId === null ? -1 : intern(c.elements, inst.elementId);
      triangles += meshRows[mi]?.triangles ?? 12;
      if (inst.stand === "box") boxes++;
    });
    chunks.set(id, c);
    chunkRows.push({
      id,
      levelIndex: g.level,
      bounds: wireBox(g.box),
      instances: n,
      bytes: n * 33,
    });
  }
  const header: SceneHeader = {
    sceneId,
    version: 1,
    buildId,
    levels: scene.levels.map((l) => ({
      id: l.id,
      name: l.name,
      index: l.index,
      bounds: finite(l.bounds) ? wireBox(l.bounds) : null,
    })),
    bounds: finite(scene.bounds) ? wireBox(scene.bounds) : null,
    classes: CLASS_ORDER.map((id) => ({
      id,
      label: COLOUR_CLASSES[id].label,
      rgb: [...COLOUR_CLASSES[id].rgb],
    })),
    meshes: meshRows,
    chunks: chunkRows,
    counts: { instances: scene.instances.length, boxes, triangles },
    boxes: {
      pieces: boxes,
      kinds: scene.fallbacks.length,
      reasons: [],
      note: boxes > 0 ? `${boxes} pieces shown as boxes.` : "",
    },
    pendingDetail,
    limited: null,
  };
  return { header, chunks, meshes };
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

const chunkBytes = (c: InstanceChunk): number => c.count * 33 + 64;

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
    open(buildId) {
      return later(() => {
        const b = builds.get(buildId);
        if (!b) throw new SceneSourceError("not-found", `No scene for build ${buildId}.`);
        const sceneId = `mem-${++serial}`;
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
        const out: InstanceChunk[] = [];
        const more: string[] = [];
        let bytes = 0;
        for (const id of chunkIds) {
          const c = s.chunks.get(id);
          if (!c) continue;
          if (out.length > 0 && bytes + chunkBytes(c) > max) {
            more.push(id);
            continue;
          }
          bytes += chunkBytes(c);
          out.push(c);
        }
        return { chunks: out, more };
      });
    },
    meshes(sceneId, keys) {
      return later(() => {
        const s = scene(sceneId);
        const out: MeshGeometry[] = [];
        const more: string[] = [];
        let bytes = 0;
        for (const key of keys) {
          const m = s.meshes.get(key);
          if (!m) continue;
          const b = m.positions.byteLength + m.indices.byteLength;
          if (out.length > 0 && bytes + b > max) {
            more.push(key);
            continue;
          }
          bytes += b;
          out.push(m);
        }
        return { meshes: out, more };
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
