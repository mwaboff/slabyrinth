import { EventEmitter } from "node:events";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MapPlan, ReadonlyFs } from "@slabyrinth/core";
import { cuboid, type BundleExtractor, type MeshData } from "@slabyrinth/scene3d";
import type { WorkerPort } from "../meshes/workerPort";

/**
 * Test doubles for the 3D services: an in-process worker over a real worker handler, and a synthetic TaleSpire
 * install (a pack index listing the asked asset ids, bundle files of plain bytes, and an extractor that answers a
 * small box-shaped mesh per prefab). Nothing from the game; temp dirs only.
 */
export function inProcessPort<Req extends { id: number }, Res>(
  handle: (msg: Req, post: (r: Res) => void) => Promise<void> | void,
  o: { never?: boolean; failWith?: Error | null } = {},
): WorkerPort<Req, Res> & { terminated: boolean; posted: Req[] } {
  const ee = new EventEmitter();
  let queue = Promise.resolve();
  const w = {
    terminated: false,
    posted: [] as Req[],
    postMessage(msg: Req) {
      w.posted.push(msg);
      if (o.never === true) return;
      if (o.failWith) {
        const err = o.failWith;
        setTimeout(() => {
          if (!w.terminated) ee.emit("error", err);
        }, 0);
        return;
      }
      queue = queue.then(async () => {
        await new Promise((r) => setTimeout(r, 0));
        if (w.terminated) return;
        await handle(msg, (r) => {
          if (!w.terminated) ee.emit("message", r);
        });
      });
    },
    on(event: string, fn: (...args: never[]) => void) {
      ee.on(event, fn as (...args: unknown[]) => void);
      return w;
    },
    terminate() {
      w.terminated = true;
      return Promise.resolve(0);
    },
  };
  return w;
}

/** An out-of-memory worker error as Node raises it for `resourceLimits`. */
export const oomError = (): Error =>
  Object.assign(new Error("worker out of memory"), { code: "ERR_WORKER_OUT_OF_MEMORY" });

export const SYNTH_INSTALL = "/synthetic/TaleSpire";
const PACK = `${SYNTH_INSTALL}/Taleweaver/00000000-0000-4000-8000-00000000aaaa`;

/**
 * A synthetic install listing `uuids` (one part each, `trianglesEach` triangles), bundle `b<k>` per 50 assets.
 * `bump(k)` changes bundle k's modified time (a game update). `reads` lists bundle files opened.
 */
export function syntheticInstall(
  uuids: readonly string[],
  trianglesEach = 12,
): { fs: ReadonlyFs; extract: BundleExtractor; reads: string[]; bump: (k: number) => void } {
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const reads: string[] = [];
  const bundleOf = (i: number): string => `b${String(Math.floor(i / 50))}`;
  const props = uuids.map((id, i) => ({
    Id: id,
    Name: `piece ${String(i)}`,
    Assets: [
      {
        LoaderData: { BundleId: bundleOf(i), AssetName: `p${String(i)}` },
        Position: { x: 0, y: 0, z: 0 },
        Rotation: { x: 0, y: 0, z: 0, w: 1 },
        Scale: { x: 1, y: 1, z: 1 },
      },
    ],
    ColliderBoundsBound: { m_Center: { x: 0.5, y: 0.5, z: 0.5 }, m_Extent: { x: 0.5, y: 0.5, z: 0.5 } },
  }));
  files.set(`${PACK}/index.json`, {
    bytes: new TextEncoder().encode(JSON.stringify({ Name: "Synthetic", Tiles: [], Props: props })),
    mtimeMs: 1000,
  });
  for (let k = 0; k * 50 < uuids.length; k++)
    files.set(`${PACK}/Assets/b${String(k)}`, { bytes: new Uint8Array([k]), mtimeMs: 1000 });
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const fs: ReadonlyFs = {
    stat(p) {
      const f = files.get(norm(p));
      if (f) return Promise.resolve({ size: f.bytes.length, mtimeMs: f.mtimeMs, isDirectory: false });
      const dir = [...files.keys()].some((k) => k.startsWith(`${norm(p)}/`));
      return Promise.resolve(dir ? { size: 0, mtimeMs: 0, isDirectory: true } : null);
    },
    readFile(p) {
      const f = files.get(norm(p));
      if (!f) return Promise.reject(new Error(`ENOENT ${p}`));
      reads.push(norm(p));
      return Promise.resolve(f.bytes);
    },
    readText(p) {
      const f = files.get(norm(p));
      return f
        ? Promise.resolve(new TextDecoder().decode(f.bytes))
        : Promise.reject(new Error(`ENOENT ${p}`));
    },
    listDir(p) {
      const pre = `${norm(p)}/`;
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split("/")[0] ?? "");
      return Promise.resolve([...names].filter(Boolean).sort());
    },
  };
  const mesh = (): MeshData => {
    const boxes = Math.max(1, Math.round(trianglesEach / 12));
    const positions: number[] = [];
    const indices: number[] = [];
    for (let b = 0; b < boxes; b++) {
      const c = cuboid({ x: 0, y: b * 0.01, z: 0 }, { x: 1, y: 1 + b * 0.01, z: 1 });
      const base = positions.length / 3;
      positions.push(...c.positions);
      for (const i of c.indices) indices.push(i + base);
    }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  };
  const extract: BundleExtractor = (_bytes, names) => new Map(names.map((n) => [n, mesh()]));
  return {
    fs,
    extract,
    reads,
    bump: (k) => {
      const f = files.get(`${PACK}/Assets/b${String(k)}`);
      if (f) f.mtimeMs += 1000;
    },
  };
}

/** A plan of `n` × `n` walled rooms of 8 × 8 on one level (a large synthetic map). */
export function gridPlan(n: number): MapPlan {
  const areas = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      areas.push({
        id: `r${String(x)}_${String(y)}`,
        kind: "room" as const,
        shape: { type: "rect" as const, x: 1 + x * 10, y: 1 + y * 10, w: 8, h: 8 },
      });
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "00000000-0000-4000-8000-0000000000f3",
    title: "Grid",
    kind: "dungeon",
    seed: 3,
    theme: "stone_dungeon",
    levels: [
      {
        id: "l1",
        name: "One",
        elevation: 0,
        bounds: { x: 0, y: 0, w: n * 10 + 2, h: n * 10 + 2 },
        base: { type: "solid" },
        areas,
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  };
}

export async function tempDir(prefix: string): Promise<string> {
  const os = await import("node:os");
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}
