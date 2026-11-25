/**
 * The install mesh source over a fake read-only file system holding a synthetic pack (index.json + bundles built in
 * test code): any listed asset resolves, the cache answers on the next run, a changed bundle re-reads only its own
 * pieces, and every piece that cannot be read is a box with its reason.
 */
import type { ReadonlyFs } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import {
  decodeCacheFile,
  decodeMeshFile,
  encodeFailureFile,
  encodeMeshFile,
  quantised,
  installMeshSource,
  meshBox,
  type MeshCache,
  type MeshData,
  type MeshLookup,
} from "../src/index";
import { cratePrefab, serializedFile, unityFsBundle } from "./synthetic/unity";

const INSTALL = "/ts";
const PACK = "/ts/Taleweaver/d71427a1-5535-4fa7-82d7-4ca1e75edbfd";
const CRATE = "aaaaaaaa-0000-4000-8000-000000000001";
const BARREL = "aaaaaaaa-0000-4000-8000-000000000002";
const PAIR = "aaaaaaaa-0000-4000-8000-000000000003";
const BROKEN = "aaaaaaaa-0000-4000-8000-000000000004";
const OLD = "aaaaaaaa-0000-4000-8000-000000000005";
const LOST = "aaaaaaaa-0000-4000-8000-000000000006";
const NOWHERE = "aaaaaaaa-0000-4000-8000-0000000000ff";

const part = (bundle: string, asset: string, x = 0) => ({
  LoaderData: { BundleId: bundle, AssetName: asset },
  Position: { x, y: 0, z: 0 },
  Rotation: { x: 0, y: 0, z: 0, w: 1 },
  Scale: { x: 1, y: 1, z: 1 },
});
const prop = (id: string, parts: unknown[]) => ({
  Id: id,
  Name: id.slice(-1),
  Assets: parts,
  ColliderBoundsBound: { m_Center: { x: 0.5, y: 0.5, z: 0.5 }, m_Extent: { x: 0.5, y: 0.5, z: 0.5 } },
});

function fakeInstall(): {
  fs: ReadonlyFs;
  files: Map<string, { bytes: Uint8Array; mtimeMs: number }>;
  reads: string[];
} {
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const reads: string[] = [];
  const put = (path: string, bytes: Uint8Array): void => {
    files.set(path, { bytes, mtimeMs: 1000 });
  };
  const bundle = (sf: Uint8Array): Uint8Array => unityFsBundle([{ path: "CAB-1", data: sf }]);
  put(
    `${PACK}/Assets/props_a`,
    bundle(serializedFile([...cratePrefab("crate", [0, 0, 0]), ...cratePrefab("barrel", [5, 0, 0], 2n)])),
  );
  put(`${PACK}/Assets/props_b`, bundle(serializedFile(cratePrefab("lid", [0, 0, 0]))));
  put(`${PACK}/Assets/props_old`, bundle(serializedFile(cratePrefab("old", [0, 0, 0]), 21)));
  const index = {
    Name: "Fixture",
    Tiles: [],
    Props: [
      prop(CRATE, [part("props_a", "crate")]),
      prop(BARREL, [part("props_a", "barrel")]),
      prop(PAIR, [part("props_a", "crate"), part("props_b", "lid", 10)]),
      prop(BROKEN, [part("props_a", "no_such_prefab")]),
      prop(OLD, [part("props_old", "old")]),
      prop(LOST, [part("props_gone", "x")]),
    ],
  };
  put(`${PACK}/index.json`, new TextEncoder().encode(JSON.stringify(index)));
  const fs: ReadonlyFs = {
    stat(path) {
      const p = path.replace(/\\/g, "/");
      const f = files.get(p);
      if (f) return Promise.resolve({ size: f.bytes.length, mtimeMs: f.mtimeMs, isDirectory: false });
      const dir = [...files.keys()].some((k) => k.startsWith(p + "/"));
      return Promise.resolve(dir ? { size: 0, mtimeMs: 0, isDirectory: true } : null);
    },
    readFile(path) {
      const p = path.replace(/\\/g, "/");
      reads.push(p);
      const f = files.get(p);
      return f ? Promise.resolve(f.bytes) : Promise.reject(new Error(`ENOENT ${p}`));
    },
    async readText(path) {
      return new TextDecoder().decode(await this.readFile(path));
    },
    listDir(path) {
      const p = path.replace(/\\/g, "/") + "/";
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(p)) names.add(k.slice(p.length).split("/")[0] ?? "");
      return Promise.resolve([...names]);
    },
  };
  return { fs, files, reads };
}

function memoryCache(): MeshCache & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    read: (p) => Promise.resolve(store.get(p) ?? null),
    write: (p, b) => {
      store.set(p, b);
      return Promise.resolve();
    },
  };
}

const meshOf = (r: MeshLookup | undefined): MeshData => {
  if (r?.kind !== "mesh") throw new Error(`no mesh: ${JSON.stringify(r)}`);
  return r.mesh;
};
const ALL = [CRATE, BARREL, PAIR, BROKEN, OLD, LOST, NOWHERE];

describe("mesh cache file", () => {
  it("round-trips a mesh within its 16-bit precision and refuses another source key", () => {
    const mesh: MeshData = {
      positions: Float32Array.from([0, 0, 0, 1.5, 2, -3, 0.25, 0.125, 7]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const file = encodeMeshFile(mesh, "abc123");
    const back = decodeMeshFile(file, "abc123");
    expect(back?.indices).toEqual(mesh.indices);
    back?.positions.forEach((v, i) => {
      expect(v).toBeCloseTo(mesh.positions[i] ?? NaN, 3);
    });
    expect(decodeMeshFile(file, "abc124")).toBeNull();
    expect(quantised(mesh)).toEqual(back);
  });

  it("holds a failure record under a source key, which a mesh reader sees as a miss", () => {
    const file = encodeFailureFile({ reason: "decode-failed", detail: "x".repeat(10_000) }, "k1");
    expect(decodeCacheFile(file, "k1")).toMatchObject({ kind: "failed", reason: "decode-failed" });
    expect(decodeCacheFile(file, "k2")).toBeNull();
    expect(decodeMeshFile(file, "k1")).toBeNull();
    expect(file.length).toBeLessThan(2200);
    // a truncated record (or mesh file) is a miss, read again: never a crash, never geometry
    const mesh = encodeMeshFile(
      { positions: Float32Array.from([0, 0, 0]), indices: new Uint32Array(0) },
      "k1",
    );
    for (const f of [file, mesh])
      for (let n = 0; n < f.length; n++) expect(decodeCacheFile(f.subarray(0, n), "k1")).toBeNull();
  });
});

describe("install mesh source", () => {
  it("reads any listed asset from its bundles, and says why the others are boxes", async () => {
    const { fs } = fakeInstall();
    const src = installMeshSource({ fs, installPath: INSTALL, cache: memoryCache() });
    const got = await src.load(ALL);
    expect(meshBox(meshOf(got.get(CRATE)))).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 2 } });
    expect(meshBox(meshOf(got.get(BARREL))).min.x).toBeCloseTo(5);
    // two parts: the crate, and the lid moved 10 east by its part transform
    expect(meshOf(got.get(PAIR)).indices.length).toBe(144);
    expect(meshBox(meshOf(got.get(PAIR))).max.x).toBeCloseTo(12);
    expect(got.get(CRATE)).toMatchObject({ geom: { originAt: "center", size: { x: 1, y: 1, z: 1 } } });
    expect(got.get(BROKEN)).toMatchObject({ kind: "box", reason: "decode-failed" });
    expect(got.get(OLD)).toMatchObject({ kind: "box", reason: "unsupported-format" });
    expect(got.get(LOST)).toMatchObject({ kind: "box", reason: "bundle-missing", detail: "props_gone" });
    expect(got.get(NOWHERE)).toEqual({ kind: "box", reason: "not-in-index" });
    expect(src.stats).toMatchObject({ extracted: 3, bundlesRead: 2, failed: 4, cacheHits: 0 });
  });

  it("answers from the cache next time, with the same meshes, reading no bundle", async () => {
    const { fs, reads } = fakeInstall();
    const cache = memoryCache();
    const cold = await installMeshSource({ fs, installPath: INSTALL, cache }).load([CRATE, PAIR]);
    reads.length = 0;
    const warmSrc = installMeshSource({ fs, installPath: INSTALL, cache });
    const warm = await warmSrc.load([CRATE, PAIR]);
    expect(reads.filter((r) => r.includes("/Assets/"))).toEqual([]);
    expect(warmSrc.stats).toMatchObject({ cacheHits: 2, extracted: 0 });
    expect(meshOf(warm.get(PAIR))).toEqual(meshOf(cold.get(PAIR)));
  });

  it("records a piece that cannot be read, so it is a box with its reason without reading its bundle again", async () => {
    const { fs, files, reads } = fakeInstall();
    const cache = memoryCache();
    await installMeshSource({ fs, installPath: INSTALL, cache }).load([BROKEN, OLD]);
    reads.length = 0;
    // a cache-only source (the app's scene worker) reported these "not-read-yet" for ever before, re-laying out
    const cacheOnly = installMeshSource({ fs, installPath: INSTALL, cache, coldRead: false });
    const got = await cacheOnly.load([BROKEN, OLD]);
    expect(got.get(BROKEN)).toMatchObject({
      kind: "box",
      reason: "decode-failed",
      detail: "no prefab no_such_prefab",
    });
    expect(got.get(OLD)).toMatchObject({ kind: "box", reason: "unsupported-format" });
    // and a reading source does not open the bundles again
    const again = installMeshSource({ fs, installPath: INSTALL, cache });
    await again.load([BROKEN, OLD]);
    expect(reads.filter((r) => r.includes("/Assets/"))).toEqual([]);
    expect(again.stats).toMatchObject({ bundlesRead: 0, cacheHits: 2, failed: 2 });
    // a game update that changes the bundle retries it, and nothing else
    const old = files.get(`${PACK}/Assets/props_old`);
    if (old) old.mtimeMs = 3000;
    const updated = installMeshSource({ fs, installPath: INSTALL, cache });
    await updated.load([BROKEN, OLD]);
    expect(reads.filter((r) => r.includes("/Assets/"))).toEqual([`${PACK}/Assets/props_old`]);
  });

  it("does not record a bundle it could not open this time (it is read again next time)", async () => {
    const { fs } = fakeInstall();
    const cache = memoryCache();
    const failing: ReadonlyFs = {
      ...fs,
      readFile: (p) => (p.includes("/Assets/") ? Promise.reject(new Error("EBUSY")) : fs.readFile(p)),
    };
    const got = await installMeshSource({ fs: failing, installPath: INSTALL, cache }).load([CRATE]);
    expect(got.get(CRATE)).toMatchObject({ kind: "box", reason: "decode-failed" });
    expect(cache.store.size).toBe(0);
    const later = await installMeshSource({ fs, installPath: INSTALL, cache }).load([CRATE]);
    expect(later.get(CRATE)?.kind).toBe("mesh");
  });

  it("re-reads only the pieces whose bundle changed after a game update", async () => {
    const { fs, files, reads } = fakeInstall();
    const cache = memoryCache();
    await installMeshSource({ fs, installPath: INSTALL, cache }).load([CRATE, BARREL, PAIR]);
    const b = files.get(`${PACK}/Assets/props_b`);
    if (b) b.mtimeMs = 2000;
    reads.length = 0;
    const src = installMeshSource({ fs, installPath: INSTALL, cache });
    await src.load([CRATE, BARREL, PAIR]);
    // PAIR uses props_b: it alone is extracted again (both its bundles are read for it)
    expect(src.stats).toMatchObject({ cacheHits: 2, extracted: 1 });
    expect(reads.filter((r) => r.includes("/Assets/")).sort()).toEqual([
      `${PACK}/Assets/props_a`,
      `${PACK}/Assets/props_b`,
    ]);
  });
});
