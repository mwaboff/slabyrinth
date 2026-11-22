/**
 * Runtime catalog build with fingerprinting (talespire-assets.md §8.7, §9; architecture §6.6):
 *   1. list GUID pack folders; stat `index` and `index.json`;
 *   2. reuse the cached sha256 when (size, mtimeMs) are unchanged, hash otherwise;
 *   3. re-parse only packs whose file hashes changed (or that are new);
 *   4. per pack: binary index → last good cached assets (stale) → index.json (stale) → nothing;
 *   5. return the new catalog plus a change report against the cached one.
 * Never throws for bad content; failures become warnings. Everything is read-only.
 */
import type {
  AssetCatalog,
  CatalogAsset,
  CatalogChangeReport,
  CatalogSourceId,
  InstallFingerprint,
  Palette,
} from "../contracts/compiler";
import { sha256Hex } from "../slab/sha256";
import { binaryIndexSource } from "./binaryIndex";
import { diffCatalogs } from "./diff";
import { joinPath, listPackDirs, type ReadonlyFs } from "./discovery";
import { indexJsonSource } from "./indexJson";

export const CATALOG_SCHEMA = "slabyrinth/asset-catalog@1" as const;
/** Bump when extraction logic changes: forces every cache to rebuild. */
export const EXTRACTOR_VERSION = 1;

export interface FileStat {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface FingerprintPlan {
  /** Files whose cached sha256 can be reused (size and mtime unchanged). */
  reuse: InstallFingerprint["files"];
  /** Files that must be hashed (new, or size/mtime changed). */
  hash: FileStat[];
  /** Files present in the cache but gone now. */
  removed: string[];
}

/** Step 2 of change detection: decide which files need hashing. */
export function planFingerprint(
  cached: InstallFingerprint | null,
  current: readonly FileStat[],
  installPath: string,
): FingerprintPlan {
  const prev = new Map(
    (cached && samePath(cached.installPath, installPath) ? cached.files : []).map((f) => [f.relPath, f]),
  );
  const reuse: InstallFingerprint["files"] = [];
  const hash: FileStat[] = [];
  for (const f of current) {
    const p = prev.get(f.relPath);
    if (p && p.size === f.size && p.mtimeMs === f.mtimeMs && p.sha256) reuse.push({ ...p });
    else hash.push(f);
  }
  const now = new Set(current.map((f) => f.relPath));
  const removed = [...prev.keys()].filter((k) => !now.has(k));
  return { reuse, hash, removed };
}

/** Relative paths whose content changed (hash differs, new, or removed) between two fingerprints. */
export function changedFiles(prev: InstallFingerprint | null, next: InstallFingerprint): string[] {
  const p = new Map((prev?.files ?? []).map((f) => [f.relPath, f.sha256]));
  const out = new Set<string>();
  for (const f of next.files) if (p.get(f.relPath) !== f.sha256) out.add(f.relPath);
  const n = new Set(next.files.map((f) => f.relPath));
  for (const k of p.keys()) if (!n.has(k)) out.add(k);
  return [...out].sort();
}

function samePath(a: string, b: string): boolean {
  const n = (s: string): string =>
    s
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  return n(a) === n(b);
}

export interface PackBuildInfo {
  packId: string;
  name: string;
  source: CatalogSourceId | "cache" | "none";
  /** True when the binary index could not be used (cache or index.json in use; new assets may be missing). */
  stale: boolean;
  warnings: string[];
  reparsed: boolean;
}

export interface BuildCatalogResult {
  catalog: AssetCatalog;
  /** False when the fingerprint matched the cache and the cached catalog was returned unchanged. */
  changed: boolean;
  packs: PackBuildInfo[];
  report: CatalogChangeReport;
  warnings: string[];
}

export interface BuildCatalogOptions {
  cached?: AssetCatalog | null;
  /** Palettes, to fill CatalogChangeReport.affectedPaletteRoles. */
  palettes?: Record<string, Palette>;
  /** ISO timestamp for generatedAt (injected for deterministic tests). */
  now?: string;
  /** Force a re-parse even when fingerprints match. */
  force?: boolean;
}

type PackDir = Awaited<ReturnType<typeof listPackDirs>>[number];

/** Reads a file of the install once: the bytes read while hashing are kept for parsing. */
type InstallReader = (rel: string) => Promise<Uint8Array>;

/** Builds (or reuses) the catalog for an install. `fs` is the injected read-only port. */
export async function buildCatalogFromInstall(
  fs: ReadonlyFs,
  installPath: string,
  opts: BuildCatalogOptions = {},
): Promise<BuildCatalogResult> {
  const warnings: string[] = [];
  const cached = usableCache(opts.cached, warnings);
  const dirs = await listPackDirs(fs, installPath);
  if (dirs.length === 0) warnings.push(`no asset packs found under ${joinPath(installPath, "Taleweaver")}`);
  const { fingerprint, read } = await fingerprintInstall(fs, installPath, dirs, cached, warnings);
  const changed = changedFiles(
    cached && samePath(cached.fingerprint.installPath, installPath) ? cached.fingerprint : null,
    fingerprint,
  );
  if (cached && changed.length === 0 && !opts.force)
    return unchangedResult(cached, fingerprint, opts, warnings);
  const packs: PackBuildInfo[] = [];
  const assets: CatalogAsset[] = [];
  const catalogPacks: AssetCatalog["packs"] = [];
  for (const d of dirs) {
    const prevPack = cached?.packs.find((p) => p.packId === d.packId);
    const packChanged =
      opts.force || !prevPack || changed.some((c) => c.startsWith(`Taleweaver/${d.dirName}/`));
    const pw: string[] = [];
    const got = await readPack(d, cached, packChanged, read, pw);
    if (!got) {
      packs.push({
        packId: d.packId,
        name: prevPack?.name ?? d.dirName,
        source: "none",
        stale: true,
        warnings: pw,
        reparsed: true,
      });
      warnings.push(...pw.map((w) => `${d.dirName}: ${w}`));
      continue;
    }
    assets.push(...got.assets);
    const src: CatalogSourceId = got.source === "cache" ? (prevPack?.source ?? "binary-index") : got.source;
    catalogPacks.push({
      packId: d.packId,
      name: got.packName,
      source: src,
      tiles: got.assets.filter((a) => a.kind === "tile").length,
      props: got.assets.filter((a) => a.kind === "prop").length,
    });
    packs.push({
      packId: d.packId,
      name: got.packName,
      source: got.source,
      stale: got.stale,
      warnings: pw,
      reparsed: packChanged,
    });
    warnings.push(...pw.map((w) => `${got.packName || d.dirName}: ${w}`));
  }
  const catalog: AssetCatalog = {
    schema: CATALOG_SCHEMA,
    extractorVersion: EXTRACTOR_VERSION,
    generatedAt: opts.now ?? new Date().toISOString(),
    fingerprint,
    packs: catalogPacks,
    assets,
  };
  return { catalog, changed: true, packs, report: diffCatalogs(cached, catalog, opts.palettes), warnings };
}

/** The cached catalog when this extractor wrote it, else null (with a warning when there was one). */
function usableCache(cached: AssetCatalog | null | undefined, warnings: string[]): AssetCatalog | null {
  const ok =
    cached && (cached.schema as string) === CATALOG_SCHEMA && cached.extractorVersion === EXTRACTOR_VERSION
      ? cached
      : null;
  if (cached && !ok) warnings.push("cached catalog has an unknown schema or extractor version; rebuilding");
  return ok;
}

/**
 * Steps 1-2: stat each pack's index files, reuse the cached hash when size and mtime are unchanged, hash the rest.
 * Returns the fingerprint and a reader that serves the bytes read while hashing.
 */
async function fingerprintInstall(
  fs: ReadonlyFs,
  installPath: string,
  dirs: readonly PackDir[],
  cached: AssetCatalog | null,
  warnings: string[],
): Promise<{ fingerprint: InstallFingerprint; read: InstallReader }> {
  const stats: FileStat[] = [];
  for (const d of dirs) {
    for (const rel of [d.binaryIndex, d.indexJson]) {
      if (!rel) continue;
      const st = await fs.stat(joinPath(installPath, rel));
      if (st) stats.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  const plan = planFingerprint(cached?.fingerprint ?? null, stats, installPath);
  const bytesCache = new Map<string, Uint8Array>();
  const files: InstallFingerprint["files"] = [...plan.reuse];
  for (const f of plan.hash) {
    try {
      const b = await fs.readFile(joinPath(installPath, f.relPath));
      bytesCache.set(f.relPath, b);
      files.push({ ...f, sha256: sha256Hex(b) });
    } catch (e) {
      warnings.push(`cannot read ${f.relPath}: ${(e as Error).message}`);
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const read: InstallReader = async (rel) => {
    const hit = bytesCache.get(rel);
    if (hit) return hit;
    const b = await fs.readFile(joinPath(installPath, rel));
    bytesCache.set(rel, b);
    return b;
  };
  return { fingerprint: { installPath, files }, read };
}

/** Same content (e.g. an update that only touched mtimes): keep the cache, refresh the stored stats. */
function unchangedResult(
  cached: AssetCatalog,
  fingerprint: InstallFingerprint,
  opts: BuildCatalogOptions,
  warnings: string[],
): BuildCatalogResult {
  const catalog: AssetCatalog = { ...cached, fingerprint };
  return {
    catalog,
    changed: false,
    packs: cached.packs.map((p) => ({
      packId: p.packId,
      name: p.name,
      source: p.source,
      stale: false,
      warnings: [],
      reparsed: false,
    })),
    report: diffCatalogs(cached, catalog, opts.palettes),
    warnings,
  };
}

interface PackRead {
  packName: string;
  assets: CatalogAsset[];
  source: CatalogSourceId | "cache";
  stale: boolean;
}

/**
 * Step 4, one pack: the cached assets when it did not change, else binary index → last good cached assets (stale) →
 * index.json (stale) → null. Warnings go to `pw`.
 */
async function readPack(
  d: PackDir,
  cached: AssetCatalog | null,
  packChanged: boolean,
  read: InstallReader,
  pw: string[],
): Promise<PackRead | null> {
  const prevPack = cached?.packs.find((p) => p.packId === d.packId);
  const prevAssets = cached?.assets.filter((a) => a.packId === d.packId) ?? [];
  if (!packChanged && prevPack)
    return { packName: prevPack.name, assets: prevAssets, source: prevPack.source, stale: false };
  const where = { packId: d.packId, dirName: d.dirName };
  if (d.binaryIndex) {
    try {
      const r = binaryIndexSource.read(await read(d.binaryIndex), where);
      pw.push(...r.warnings);
      return { ...r, source: "binary-index", stale: false };
    } catch (e) {
      pw.push(`binary index unreadable: ${(e as Error).message}`);
    }
  } else pw.push("binary index missing");
  if (prevPack && prevAssets.length) {
    pw.push(
      "TaleSpire updated its asset index format; using the last good catalog for this pack (new assets may be missing)",
    );
    return { packName: prevPack.name, assets: prevAssets, source: "cache", stale: true };
  }
  if (d.indexJson) {
    try {
      const r = indexJsonSource.read(await read(d.indexJson), where);
      pw.push(
        ...r.warnings,
        "using index.json, which game updates do not refresh (new assets may be missing)",
      );
      return { ...r, source: "index-json", stale: true };
    } catch (e) {
      pw.push(`index.json unreadable: ${(e as Error).message}`);
    }
  }
  return null;
}

/** Builds a catalog from already-read pack files (CLI, tests). */
export function buildCatalogFromFiles(
  packFiles: Array<{ packId: string; dirName?: string; binaryIndex?: Uint8Array; indexJson?: Uint8Array }>,
  opts: { installPath?: string; now?: string } = {},
): { catalog: AssetCatalog; warnings: string[] } {
  const warnings: string[] = [];
  const assets: CatalogAsset[] = [];
  const packs: AssetCatalog["packs"] = [];
  for (const p of packFiles) {
    const meta = { packId: p.packId, dirName: p.dirName ?? p.packId };
    let r: { packName: string; assets: CatalogAsset[]; warnings: string[] } | null = null;
    let source: CatalogSourceId = "binary-index";
    if (p.binaryIndex) {
      try {
        r = binaryIndexSource.read(p.binaryIndex, meta);
      } catch (e) {
        warnings.push(`${p.packId}: binary index unreadable: ${(e as Error).message}`);
      }
    }
    if (!r && p.indexJson) {
      try {
        r = indexJsonSource.read(p.indexJson, meta);
        source = "index-json";
      } catch (e) {
        warnings.push(`${p.packId}: index.json unreadable: ${(e as Error).message}`);
      }
    }
    if (!r) continue;
    warnings.push(...r.warnings.map((w) => `${p.packId}: ${w}`));
    assets.push(...r.assets);
    packs.push({
      packId: p.packId,
      name: r.packName,
      source,
      tiles: r.assets.filter((a) => a.kind === "tile").length,
      props: r.assets.filter((a) => a.kind === "prop").length,
    });
  }
  return {
    catalog: {
      schema: CATALOG_SCHEMA,
      extractorVersion: EXTRACTOR_VERSION,
      generatedAt: opts.now ?? new Date().toISOString(),
      fingerprint: { installPath: opts.installPath ?? "", files: [] },
      packs,
      assets,
    },
    warnings,
  };
}
