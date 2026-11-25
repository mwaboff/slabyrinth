/**
 * The mesh source over a TaleSpire install (design §2.4): for any asset id the install's pack indexes list, its
 * parts' prefabs are read from the game's bundles and assembled; the result is kept in a mesh cache keyed by a source
 * key (the extractor version, the asset's part list and each bundle file's size and modified time), so a game update
 * re-reads only the pieces whose bundles changed. A piece that cannot be read is a box with its reason.
 *
 * Pure: the host gives the install's files (core's ReadonlyFs, read-only) and the cache (`MeshCache`). Cold reading is
 * slow (LZMA unpacks a whole bundle, textures included, to reach its meshes: seconds per bundle), so bundles are read
 * one at a time and each is released before the next.
 */
import { h64hex, joinPath, type ReadonlyFs } from "@slabyrinth/core";
import type { FallbackReason, MeshData, MeshLookup, MeshSource } from "../types/index";
import { UnsupportedFormat } from "../unity/errors";
import { LoadedBundle, applyAll, findPrefabRoot, prefabGeometry, trs } from "../unity/prefab";
import { MESH_FILE_VERSION, decodeMeshFile, encodeMeshFile, quantised } from "./meshFile";
import { readPackIndex, type PackAsset, type PackIndex } from "./packIndex";

/** Bumped when extraction changes what a mesh holds: every cached mesh is then read again. */
export const EXTRACTOR_VERSION = 1;

/** Where meshes are cached between runs (CLI: .cache/meshes; app: userData/meshes). Paths are relative, "/"-separated. */
export interface MeshCache {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** Reads the named prefabs out of one bundle file: a mesh each, or why not. Throws when the bundle is unreadable. */
export type BundleExtractor = (
  bundle: Uint8Array,
  assetNames: readonly string[],
) => Map<string, MeshData | Error>;

/** The Unity readers (unity/): the default extractor. */
export const unityExtractor: BundleExtractor = (bytes, names) => {
  const lb = new LoadedBundle(bytes);
  const out = new Map<string, MeshData | Error>();
  for (const name of names) {
    try {
      const root = findPrefabRoot(lb, name);
      out.set(name, root === undefined ? new Error(`no prefab ${name}`) : prefabGeometry(lb, root));
    } catch (e) {
      out.set(name, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
};

export interface InstallSourceOptions {
  fs: ReadonlyFs;
  installPath: string;
  cache: MeshCache | null;
  extract?: BundleExtractor;
  /** After each bundle read cold: how many of how many. */
  onProgress?: (done: number, total: number, bundleId: string) => void;
}

export interface InstallStats {
  /** Pieces answered from the cache. */
  cacheHits: number;
  /** Pieces read from the game's bundles this run. */
  extracted: number;
  bundlesRead: number;
  /** Pieces that fell back to boxes. */
  failed: number;
}

export interface InstallMeshSource extends MeshSource {
  readonly stats: InstallStats;
  /** The install's pack indexes (read once). */
  index(): Promise<PackIndex>;
}

export function installMeshSource(o: InstallSourceOptions): InstallMeshSource {
  const extract = o.extract ?? unityExtractor;
  const stats: InstallStats = { cacheHits: 0, extracted: 0, bundlesRead: 0, failed: 0 };
  let indexP: Promise<PackIndex> | null = null;
  const index = (): Promise<PackIndex> => (indexP ??= readPackIndex(o.fs, o.installPath));
  const bundlePath = (a: PackAsset, bundleId: string): string => joinPath(a.packPath, "Assets", bundleId);

  async function load(uuids: readonly string[]): Promise<ReadonlyMap<string, MeshLookup>> {
    const idx = await index();
    const out = new Map<string, MeshLookup>();
    const box = (uuid: string, reason: FallbackReason, detail?: string): void => {
      stats.failed++;
      out.set(uuid, detail === undefined ? { kind: "box", reason } : { kind: "box", reason, detail });
    };
    const statCache = new Map<string, { size: number; mtimeMs: number } | null>();
    const bundleStat = async (path: string): Promise<{ size: number; mtimeMs: number } | null> => {
      if (!statCache.has(path)) {
        const s = await o.fs.stat(path);
        statCache.set(path, s && !s.isDirectory ? { size: s.size, mtimeMs: s.mtimeMs } : null);
      }
      return statCache.get(path) ?? null;
    };
    // 1. index, bundles present, source key, cache
    const todo: Array<{ uuid: string; asset: PackAsset; key: string; path: string }> = [];
    for (const uuid of uuids) {
      const asset = idx.assets.get(uuid.toLowerCase());
      if (!asset) {
        box(uuid, "not-in-index");
        continue;
      }
      if (asset.parts.length === 0) {
        box(uuid, "no-parts");
        continue;
      }
      const files: Array<[string, number, number]> = [];
      let missing: string | null = null;
      for (const id of [...new Set(asset.parts.map((p) => p.bundleId))].sort()) {
        const s = await bundleStat(bundlePath(asset, id));
        if (!s) missing = id;
        else files.push([id, s.size, s.mtimeMs]);
      }
      if (missing !== null) {
        box(uuid, "bundle-missing", missing);
        continue;
      }
      const key = h64hex(
        JSON.stringify({ x: EXTRACTOR_VERSION, f: MESH_FILE_VERSION, parts: asset.parts, files }),
      );
      const path = `v${EXTRACTOR_VERSION}/${asset.packId}/${uuid.toLowerCase()}.mesh`;
      const cached = o.cache ? await o.cache.read(path) : null;
      const mesh = cached ? decodeMeshFile(cached, key) : null;
      if (mesh) {
        stats.cacheHits++;
        out.set(uuid, { kind: "mesh", mesh, geom: asset.geom });
      } else todo.push({ uuid, asset, key, path });
    }
    if (todo.length === 0) return out;

    // 2. read each needed bundle once, one at a time, keeping only the prefabs asked of it
    const wanted = new Map<string, { path: string; names: Set<string> }>();
    for (const t of todo)
      for (const p of t.asset.parts) {
        const path = bundlePath(t.asset, p.bundleId);
        let w = wanted.get(path);
        if (!w) wanted.set(path, (w = { path, names: new Set() }));
        w.names.add(p.assetName);
      }
    const prefabs = new Map<string, MeshData | { reason: FallbackReason; detail: string }>();
    const paths = [...wanted.keys()].sort();
    let done = 0;
    for (const path of paths) {
      const w = wanted.get(path);
      if (!w) continue;
      const bundleId = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
      try {
        const got = extract(await o.fs.readFile(path), [...w.names].sort());
        stats.bundlesRead++;
        for (const name of w.names) {
          const g = got.get(name);
          prefabs.set(
            `${path}\n${name}`,
            g === undefined || g instanceof Error
              ? {
                  reason: g instanceof UnsupportedFormat ? "unsupported-format" : "decode-failed",
                  detail: g?.message ?? `no prefab ${name}`,
                }
              : g,
          );
        }
      } catch (e) {
        const reason: FallbackReason =
          e instanceof UnsupportedFormat ? "unsupported-format" : "decode-failed";
        const detail = `${bundleId}: ${e instanceof Error ? e.message : String(e)}`;
        for (const name of w.names) prefabs.set(`${path}\n${name}`, { reason, detail });
      }
      o.onProgress?.(++done, paths.length, bundleId);
    }

    // 3. assemble each piece from its parts (prefab × the index's part transform), cache it
    for (const t of todo) {
      const positions: number[] = [];
      const indices: number[] = [];
      let failure: { reason: FallbackReason; detail: string } | null = null;
      for (const p of t.asset.parts) {
        const g = prefabs.get(`${bundlePath(t.asset, p.bundleId)}\n${p.assetName}`);
        if (!g || !("positions" in g)) {
          failure = g ?? { reason: "decode-failed", detail: `${p.bundleId}/${p.assetName}` };
          break;
        }
        const base = positions.length / 3;
        const m = trs(
          [p.position.x, p.position.y, p.position.z],
          [p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w],
          [p.scale.x, p.scale.y, p.scale.z],
        );
        applyAll(m, g.positions, positions);
        for (const i of g.indices) indices.push(i + base);
      }
      if (failure) {
        box(t.uuid, failure.reason, failure.detail);
        continue;
      }
      const mesh: MeshData = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
      if (o.cache) await o.cache.write(t.path, encodeMeshFile(mesh, t.key));
      stats.extracted++;
      out.set(t.uuid, { kind: "mesh", mesh: quantised(mesh), geom: t.asset.geom });
    }
    return out;
  }

  return { label: `TaleSpire at ${o.installPath}`, stats, index, load };
}
