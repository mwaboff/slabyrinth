/**
 * The 3D piece cache: keyed as scene3d keys it (a changed bundle re-reads only its own pieces), held to its size cap
 * with the least recently used dropped first, and `clear` deletes only a folder that is plainly ours. Temp dirs and a
 * synthetic install only.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../logger";
import { createMeshHandler } from "../../workers/meshHandler";
import type { MeshWorkerRequest, MeshWorkerResponse } from "../../workers/meshProtocol";
import { inProcessPort, syntheticInstall, SYNTH_INSTALL, tempDir } from "../testing/view3dRig";
import { DiskMeshCache, MARKER, cacheStats, clearMeshCache } from "./diskCache";
import { MeshService } from "./meshService";

const uuid = (i: number): string => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await tempDir("slab-meshes-");
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

function service(
  cacheDir: string,
  uuids: string[],
  o: { enabled?: boolean; install?: boolean; limit?: number } = {},
) {
  const synth = syntheticInstall(uuids);
  const events: unknown[] = [];
  const handler = createMeshHandler({ fs: synth.fs, extract: synth.extract });
  const svc = new MeshService({
    cacheDir,
    ...(o.limit !== undefined ? { limitBytes: o.limit } : {}),
    installPath: () => Promise.resolve(o.install === false ? null : SYNTH_INSTALL),
    enabled: () => o.enabled !== false,
    spawn: () => inProcessPort<MeshWorkerRequest, MeshWorkerResponse>(handler),
    emit: (c, p) => events.push({ c, p }),
    logger: memoryLogger(),
  });
  return { svc, synth, events };
}

describe("piece cache", () => {
  it("reads each piece once, then only the pieces of a bundle that changed", async () => {
    const d = await dir();
    const ids = Array.from({ length: 120 }, (_, i) => uuid(i));
    const { svc, synth } = service(d, ids);
    await svc.warm(ids);
    expect(synth.reads.filter((r) => r.includes("/Assets/")).length).toBe(3);
    expect((await cacheStats(d)).files).toBe(120);
    synth.reads.length = 0;
    await svc.warm(ids);
    expect(synth.reads.filter((r) => r.includes("/Assets/"))).toEqual([]);
    synth.bump(1); // a game update changed bundle b1 (pieces 50..99)
    await svc.warm(ids);
    expect(synth.reads.filter((r) => r.includes("/Assets/"))).toEqual([
      `${SYNTH_INSTALL}/Taleweaver/00000000-0000-4000-8000-00000000aaaa/Assets/b1`,
    ]);
    const info = await svc.info();
    expect(info).toMatchObject({ state: "ready", read: 120, extracting: false });
    expect(info.message).toMatch(/120 pieces read/);
  });

  it("drops the least recently used pieces past its size cap", async () => {
    const d = await dir();
    const cache = new DiskMeshCache(d, 1000);
    const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);
    await cache.write("v1/p/a.mesh", bytes(300));
    await cache.write("v1/p/b.mesh", bytes(300));
    await cache.write("v1/p/c.mesh", bytes(300));
    expect(await cache.read("v1/p/a.mesh")).not.toBeNull(); // a is now the most recent
    await cache.write("v1/p/d.mesh", bytes(300)); // over 1000: b goes (least recently used)
    expect(await cache.read("v1/p/b.mesh")).toBeNull();
    for (const k of ["a", "c", "d"]) expect(await cache.read(`v1/p/${k}.mesh`)).not.toBeNull();
    expect(cache.bytes).toBe(900);
    // a fresh cache over the same folder orders by the files' times
    const again = new DiskMeshCache(d, 700);
    await again.write("v1/p/e.mesh", bytes(300));
    expect((await cacheStats(d)).files).toBe(2);
    expect(await again.read("v1/p/e.mesh")).not.toBeNull();
  });

  it("refuses paths outside its folder", async () => {
    const d = await dir();
    const cache = new DiskMeshCache(d, 10_000);
    await cache.write("../escape.mesh", new Uint8Array(4));
    await cache.write("v1/../../x.mesh", new Uint8Array(4));
    await cache.write("C:/x.mesh", new Uint8Array(4));
    expect(await fsp.readdir(path.dirname(d))).not.toContain("escape.mesh");
    expect(await cache.read("../escape.mesh")).toBeNull();
    expect((await cacheStats(d)).files).toBe(0);
  });

  it("clear deletes only its own marked folder of mesh files", async () => {
    const d = await dir();
    const cache = path.join(d, "meshes");
    const c = new DiskMeshCache(cache, 10_000);
    await c.write("v1/pack/a.mesh", new Uint8Array(8));
    expect(await clearMeshCache(cache)).toEqual({ ok: true, removed: 1 });
    await expect(fsp.stat(cache)).rejects.toThrow();
    expect(await clearMeshCache(cache)).toEqual({ ok: true, removed: 0 });

    // a stranger's file inside: nothing is deleted
    await c.write("v1/pack/a.mesh", new Uint8Array(8));
    await fsp.writeFile(path.join(cache, "v1", "notes.txt"), "mine");
    const r = await clearMeshCache(cache);
    expect(r.ok).toBe(false);
    expect(await fsp.readFile(path.join(cache, "v1", "notes.txt"), "utf8")).toBe("mine");
    expect((await cacheStats(cache)).files).toBe(1);
    await fsp.unlink(path.join(cache, "v1", "notes.txt"));

    // no marker: not plainly ours
    await fsp.unlink(path.join(cache, MARKER));
    expect((await clearMeshCache(cache)).ok).toBe(false);
  });

  it("clear refuses a link or junction, inside or as the folder itself", async () => {
    const d = await dir();
    const outside = path.join(d, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "keep.mesh"), "keep");
    const cache = path.join(d, "meshes");
    const c = new DiskMeshCache(cache, 10_000);
    await c.write("v1/pack/a.mesh", new Uint8Array(8));
    await fsp.symlink(outside, path.join(cache, "v1", "linked"), "junction");
    expect((await clearMeshCache(cache)).ok).toBe(false);
    expect(await fsp.readFile(path.join(outside, "keep.mesh"), "utf8")).toBe("keep");
    const asLink = path.join(d, "linkdir");
    await fsp.symlink(outside, asLink, "junction");
    expect((await clearMeshCache(asLink)).ok).toBe(false);
    expect(await fsp.readFile(path.join(outside, "keep.mesh"), "utf8")).toBe("keep");
  });

  it("with 3D off or no install nothing is read, and the status says so", async () => {
    const d = await dir();
    const ids = [uuid(1)];
    const off = service(d, ids, { enabled: false });
    expect(await off.svc.sceneMeshes()).toEqual({ mode: "boxes", reason: "boxes-requested" });
    await off.svc.warm(ids);
    expect(off.synth.reads).toEqual([]);
    const offInfo = await off.svc.info();
    expect(offInfo.state).toBe("off");
    expect(offInfo.message).toMatch(/turned off/);
    const none = service(d, ids, { install: false });
    expect(await none.svc.sceneMeshes()).toEqual({ mode: "boxes", reason: "no-install" });
    const noneInfo = await none.svc.info();
    expect(noneInfo.state).toBe("no_install");
    expect(noneInfo.message).toMatch(/isn't installed/);
  });

  it("rebuild clears and reads the last view's pieces again; status events say what is happening", async () => {
    const d = await dir();
    const ids = Array.from({ length: 10 }, (_, i) => uuid(i));
    const { svc, events } = service(d, ids);
    svc.noteScene(10, ids);
    await svc.rebuild();
    await svc.warm([]); // nothing more; wait for the queue
    await new Promise((r) => setTimeout(r, 50));
    expect((await cacheStats(d)).files).toBe(10);
    expect(events.some((e) => (e as { p: { extracting: boolean } }).p.extracting)).toBe(true);
  });
});
