import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MeshCache } from "@slabyrinth/scene3d";

/**
 * The 3D piece cache on disk (userData/meshes): scene3d's mesh files (`v<extractor>/<pack>/<uuid>.mesh`, keyed by a
 * source key in each file's header, so a game update re-reads only the pieces whose bundles changed), held to a size
 * cap with the least recently used dropped first (a read touches the file's time). The folder carries a marker file;
 * `clearMeshCache` deletes only a folder that has it and holds nothing but our own files: no links or junctions, no
 * other names. Shapes are read from the user's own TaleSpire install, kept on this machine and never sent anywhere.
 */
export const MARKER = ".slabyrinth-mesh-cache";
const MESH_FILE = /^[0-9a-z-]+\.mesh$/i;
const PART = /^[0-9A-Za-z._-]+$/;

/** A cache path from scene3d is relative, "/"-separated and made of plain names: anything else is refused. */
function resolveInside(dir: string, rel: string): string | null {
  const parts = rel.split("/");
  if (parts.length === 0 || parts.some((p) => !PART.test(p) || p === "." || p === "..")) return null;
  return path.join(dir, ...parts);
}

interface Entry {
  bytes: number;
  used: number;
}

export interface CacheStats {
  files: number;
  bytes: number;
}

/** Every mesh file of the cache with its size and last use (absent folder: none). */
async function scan(dir: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = await fsp.readdir(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(p);
      else if (MESH_FILE.test(n)) out.set(p, { bytes: st.size, used: st.mtimeMs });
    }
  };
  await walk(dir);
  return out;
}

export async function cacheStats(dir: string): Promise<CacheStats> {
  const all = await scan(dir);
  let bytes = 0;
  for (const e of all.values()) bytes += e.bytes;
  return { files: all.size, bytes };
}

export class DiskMeshCache implements MeshCache {
  private index: Map<string, Entry> | null = null;
  private total = 0;
  private clock = Date.now();

  constructor(
    private readonly dir: string,
    /** Most bytes the cache may hold. */
    private readonly limitBytes: number,
    /** false: never writes (the scene worker reads only; the mesh worker writes). */
    private readonly writable = true,
  ) {}

  private async loaded(): Promise<Map<string, Entry>> {
    if (!this.index) {
      this.index = await scan(this.dir);
      this.total = 0;
      for (const e of this.index.values()) this.total += e.bytes;
    }
    return this.index;
  }

  /** A strictly later time each call, so two uses in one millisecond still order. */
  private now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  async read(rel: string): Promise<Uint8Array | null> {
    const p = resolveInside(this.dir, rel);
    if (!p) return null;
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) return null;
      const bytes = new Uint8Array(await fsp.readFile(p));
      const t = this.now();
      // the file's time is its last use (least recently used is dropped first); best effort
      await fsp.utimes(p, t / 1000, t / 1000).catch(() => undefined);
      const e = this.index?.get(p);
      if (e) e.used = t;
      return bytes;
    } catch {
      return null;
    }
  }

  async write(rel: string, bytes: Uint8Array): Promise<void> {
    if (!this.writable) return;
    const p = resolveInside(this.dir, rel);
    if (!p || bytes.byteLength > this.limitBytes) return;
    const index = await this.loaded();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(path.join(this.dir, MARKER), "Slabyrinth's 3D piece cache. Safe to delete.\n");
    const tmp = `${p}.tmp-${String(process.pid)}`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, p);
    const t = this.now();
    await fsp.utimes(p, t / 1000, t / 1000).catch(() => undefined);
    const old = index.get(p);
    if (old) this.total -= old.bytes;
    index.set(p, { bytes: bytes.byteLength, used: t });
    this.total += bytes.byteLength;
    await this.evict(p);
  }

  /** Drops the least recently used files until the cache fits (never the one just written). */
  private async evict(keep: string): Promise<void> {
    const index = await this.loaded();
    if (this.total <= this.limitBytes) return;
    const order = [...index.entries()].filter(([p]) => p !== keep).sort((a, b) => a[1].used - b[1].used);
    for (const [p, e] of order) {
      if (this.total <= this.limitBytes) break;
      await fsp.unlink(p).catch(() => undefined);
      index.delete(p);
      this.total -= e.bytes;
    }
  }

  get bytes(): number {
    return this.total;
  }
}

export type ClearResult = { ok: true; removed: number } | { ok: false; reason: string };

/**
 * Deletes the cache folder, only when it is ours: a real folder (not a link or junction) holding the marker, mesh
 * files and the folders scene3d makes, nothing else. Anything else: nothing is deleted and the reason is returned.
 */
export async function clearMeshCache(dir: string): Promise<ClearResult> {
  const top = await fsp.lstat(dir).catch(() => null);
  if (!top) return { ok: true, removed: 0 };
  if (top.isSymbolicLink() || !top.isDirectory())
    return { ok: false, reason: "The piece cache folder is a link or not a folder; nothing was deleted." };
  const files: string[] = [];
  const dirs: string[] = [];
  const seen: { foreign: string | null; marker: boolean } = { foreign: null, marker: false };
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const n of await fsp.readdir(d)) {
      const p = path.join(d, n);
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) seen.foreign ??= p;
      else if (st.isDirectory()) {
        if (!PART.test(n) || depth >= 2) seen.foreign ??= p;
        else {
          await walk(p, depth + 1);
          dirs.push(p);
        }
      } else if (depth === 0 && n === MARKER) seen.marker = true;
      else if (depth > 0 && (MESH_FILE.test(n) || /\.mesh\.tmp-\d+$/.test(n))) files.push(p);
      else seen.foreign ??= p;
    }
  };
  await walk(dir, 0);
  if (files.length > 0 && !seen.marker)
    return { ok: false, reason: "The piece cache folder isn't marked as Slabyrinth's; nothing was deleted." };
  if (seen.foreign !== null)
    return {
      ok: false,
      reason: `The piece cache folder holds something that isn't Slabyrinth's (${path.basename(seen.foreign)}); nothing was deleted.`,
    };
  for (const f of files) await fsp.unlink(f);
  for (const d of dirs) await fsp.rmdir(d);
  if (seen.marker) await fsp.unlink(path.join(dir, MARKER));
  await fsp.rmdir(dir);
  return { ok: true, removed: files.length };
}
