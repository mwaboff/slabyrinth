import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  AssetCatalog,
  CatalogAsset,
  CatalogChangeReport,
  CatalogSourceId,
  InstallFingerprint,
  Palette,
} from "@slabyrinth/core";
import type { IpcRequests } from "../../../shared/ipc";
import type { Logger } from "../../logger";
import type { CatalogReaderPort, PackFile } from "../../ports/catalog";
import { writeFileAtomic } from "../../util/atomicWrite";
import type { EmitEvent } from "../events";

/**
 * CatalogService (architecture §6.6, talespire-assets.md §9): the asset library from the user's
 * install. Read-only on the install. Startup: fingerprint every Taleweaver/<pack>/index and
 * index.json (size + mtime; sha256 only when those changed), compare with the cached catalog
 * (userData/catalog/catalog.json), rebuild through core's catalog readers when different, diff,
 * swap the cache atomically and report. No install or no readable index is a NON-BLOCKING state:
 * "using built-in asset set" (catalog:warning), and everything else keeps working.
 */
export type CatalogState = IpcRequests["catalog:status"]["res"]["state"];
export type CatalogStatus = IpcRequests["catalog:status"]["res"];

const GUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_FILES = ["index", "index.json"] as const;

export interface CatalogServiceDeps {
  catalogFile: string;
  reader: CatalogReaderPort | null;
  /** Current install folder (settings override or the first located), null = not found. */
  resolveInstall: () => Promise<string | null>;
  palettes: () => Palette[];
  emit: EmitEvent;
  logger: Logger;
  suppressWarning: () => boolean;
  onScanned?: (at: string) => Promise<void>;
  now?: () => Date;
}

interface CacheFile {
  catalog: AssetCatalog;
  lastReport: CatalogChangeReport | null;
}

export class CatalogService {
  private state: CatalogState = "no_install";
  private catalog: AssetCatalog | null = null;
  private lastReport: CatalogChangeReport | null = null;
  private running: Promise<CatalogChangeReport> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: CatalogServiceDeps) {}

  status(): CatalogStatus {
    const usable =
      this.catalog !== null &&
      (this.state === "fresh" || this.state === "stale" || this.state === "rebuilding");
    return {
      state: this.state,
      usingBuiltInOnly: !usable,
      generatedAt: this.catalog?.generatedAt ?? null,
      assets: this.catalog?.assets.length ?? 0,
      lastReport: this.lastReport,
    };
  }

  /** The cached catalog when it matches the current install (null = built-in asset set). */
  current(): AssetCatalog | null {
    return this.status().usingBuiltInOnly ? null : this.catalog;
  }

  get errorMessage(): string | null {
    return this.lastError;
  }

  /** Startup check: cheap when nothing changed. Never throws. */
  async startup(): Promise<void> {
    await this.loadCache();
    try {
      await this.refresh(false);
    } catch (err) {
      this.deps.logger.warn("catalog startup check failed", { error: err });
    }
  }

  /** Re-fingerprint and rebuild if changed (or forced). Concurrent calls share one run. */
  refresh(force: boolean): Promise<CatalogChangeReport> {
    if (this.running) return this.running;
    const run = this.doRefresh(force).finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private emptyReport(): CatalogChangeReport {
    return {
      previousGeneratedAt: this.catalog?.generatedAt ?? null,
      sourceUsed: {},
      added: 0,
      removed: [],
      newlyDeprecated: [],
      geometryChanged: [],
      affectedPaletteRoles: [],
    };
  }

  private async doRefresh(force: boolean): Promise<CatalogChangeReport> {
    const install = await this.deps.resolveInstall();
    if (install === null) {
      this.state = "no_install";
      this.warn(
        "no_install",
        "TaleSpire wasn't found. Using Slabyrinth's built-in asset set, so the newest tiles and props aren't available. You can still create and export maps.",
      );
      return this.emptyReport();
    }
    const previous = this.catalog;
    let fingerprint: InstallFingerprint;
    try {
      fingerprint = await fingerprintInstall(install, previous?.fingerprint ?? null);
    } catch (err) {
      return this.failed("Couldn't read the TaleSpire install folder.", err);
    }
    if (fingerprint.files.length === 0) {
      return this.failed("Found TaleSpire, but it has no asset index files.", null);
    }
    const reader = this.deps.reader;
    const cacheUsable =
      previous !== null && reader !== null && previous.extractorVersion === reader.extractorVersion;
    if (!force && cacheUsable && sameFingerprint(previous.fingerprint, fingerprint)) {
      this.state = "fresh";
      return this.emptyReport();
    }
    if (reader === null) {
      return this.failed(
        "Found TaleSpire, but this build can't read its asset library yet. Using the built-in asset set for now.",
        null,
      );
    }

    this.state = "rebuilding";
    let next: AssetCatalog;
    try {
      next = await this.build(install, fingerprint, reader);
    } catch (err) {
      return this.failed(
        "Found TaleSpire, but couldn't read its asset library — a recent game update may have changed it. Using the built-in asset set for now.",
        err,
      );
    }
    const report = computeChangeReport(previous, next, this.deps.palettes());
    this.catalog = next;
    this.lastReport = report;
    this.state = "fresh";
    this.lastError = null;
    await this.saveCache();
    await this.deps.onScanned?.(next.generatedAt);
    this.deps.logger.info("asset catalog rebuilt", {
      assets: next.assets.length,
      packs: next.packs.length,
      added: report.added,
      removed: report.removed.length,
    });
    if (previous !== null || force) this.deps.emit("catalog:changed", report);
    return report;
  }

  private failed(message: string, err: unknown): CatalogChangeReport {
    this.state = "error";
    this.lastError = message;
    this.deps.logger.warn("asset catalog unavailable", { message, error: err });
    this.warn("parse_failed", message);
    return this.emptyReport();
  }

  private warn(kind: "no_install" | "parse_failed", message: string): void {
    if (this.deps.suppressWarning()) return;
    this.deps.emit("catalog:warning", { kind, message });
  }

  private async build(
    install: string,
    fingerprint: InstallFingerprint,
    reader: CatalogReaderPort,
  ): Promise<AssetCatalog> {
    const byPack = new Map<string, PackFile[]>();
    for (const f of fingerprint.files) {
      const [dir, name] = f.relPath.split("/");
      if (dir === undefined || (name !== "index" && name !== "index.json")) continue;
      const list = byPack.get(dir) ?? [];
      list.push({
        name,
        bytes: new Uint8Array(await fsp.readFile(path.join(install, "Taleweaver", dir, name))),
      });
      byPack.set(dir, list);
    }
    const packs: AssetCatalog["packs"] = [];
    const assets: CatalogAsset[] = [];
    const failures: string[] = [];
    for (const [dir, files] of [...byPack.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const r = reader.readPack({ packId: dir.toLowerCase(), dirName: dir }, files);
        packs.push({
          packId: dir.toLowerCase(),
          name: r.packName,
          source: r.source,
          tiles: r.assets.filter((a) => a.kind === "tile").length,
          props: r.assets.filter((a) => a.kind === "prop").length,
        });
        assets.push(...r.assets);
        for (const w of r.warnings)
          this.deps.logger.debug("catalog reader warning", { pack: dir, warning: w });
      } catch (err) {
        failures.push(dir);
        this.deps.logger.warn("pack unreadable", { pack: dir, error: err });
      }
    }
    if (packs.length === 0) throw new Error(`no pack readable (${failures.join(", ")})`);
    return {
      schema: "slabyrinth/asset-catalog@1",
      extractorVersion: reader.extractorVersion,
      generatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      fingerprint,
      packs,
      assets,
    };
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.deps.catalogFile, "utf8")) as Partial<CacheFile>;
      if (raw.catalog?.schema !== "slabyrinth/asset-catalog@1" || !Array.isArray(raw.catalog.assets))
        throw new Error("bad cache");
      this.catalog = raw.catalog;
      this.lastReport = raw.lastReport ?? null;
      this.state = "stale"; // until the fingerprint check confirms it
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        this.deps.logger.info("catalog cache discarded", { error: err });
      this.catalog = null;
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.catalog) return;
    await fsp.mkdir(path.dirname(this.deps.catalogFile), { recursive: true });
    const body: CacheFile = { catalog: this.catalog, lastReport: this.lastReport };
    await writeFileAtomic(this.deps.catalogFile, JSON.stringify(body));
  }

  /** Re-scan (debounced) when Steam rewrites the Taleweaver folder while the app runs. */
  async watch(): Promise<void> {
    this.unwatch();
    const install = await this.deps.resolveInstall();
    if (install === null) return;
    try {
      this.watcher = fs.watch(path.join(install, "Taleweaver"), { recursive: true }, (_e, name) => {
        if (typeof name !== "string" || !/(^|[\\/])index(\.json)?$/.test(name)) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          void this.refresh(false).catch(() => undefined);
        }, 10_000);
      });
      this.watcher.on("error", () => {
        this.unwatch();
      });
    } catch (err) {
      this.deps.logger.info("watching Taleweaver not possible", { error: err });
    }
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }
}

// ───────────────────────────── fingerprint & diff (pure-ish helpers) ─────────────────────────────

export async function fingerprintInstall(
  install: string,
  previous: InstallFingerprint | null,
): Promise<InstallFingerprint> {
  const root = path.join(install, "Taleweaver");
  const dirs = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && GUID_DIR.test(d.name))
    .map((d) => d.name)
    .sort();
  const files: InstallFingerprint["files"] = [];
  for (const dir of dirs) {
    for (const name of INDEX_FILES) {
      const full = path.join(root, dir, name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const relPath = `${dir}/${name}`;
      const prev = previous?.files.find((f) => f.relPath === relPath);
      const sha256 =
        prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs
          ? prev.sha256
          : createHash("sha256")
              .update(await fsp.readFile(full))
              .digest("hex");
      files.push({ relPath, size: st.size, mtimeMs: st.mtimeMs, sha256 });
    }
  }
  return { installPath: install, files };
}

/** Content equality: same files with the same hashes (mtime-only changes are not a change). */
export function sameFingerprint(a: InstallFingerprint, b: InstallFingerprint): boolean {
  if (a.files.length !== b.files.length) return false;
  const map = new Map(a.files.map((f) => [f.relPath, f.sha256]));
  return b.files.every((f) => map.get(f.relPath) === f.sha256);
}

const geomKey = (a: CatalogAsset): string => JSON.stringify([a.size, a.boundsCenter, a.originAt]);

export function computeChangeReport(
  prev: AssetCatalog | null,
  next: AssetCatalog,
  palettes: Palette[],
): CatalogChangeReport {
  const before = new Map((prev?.assets ?? []).map((a) => [a.uuid, a]));
  const after = new Map(next.assets.map((a) => [a.uuid, a]));
  const sourceUsed: Record<string, CatalogSourceId> = {};
  for (const p of next.packs) sourceUsed[p.packId] = p.source;
  const report: CatalogChangeReport = {
    previousGeneratedAt: prev?.generatedAt ?? null,
    sourceUsed,
    added: 0,
    removed: [],
    newlyDeprecated: [],
    geometryChanged: [],
    affectedPaletteRoles: [],
  };
  for (const [uuid, a] of after) {
    const old = before.get(uuid);
    if (!old) {
      if (prev) report.added += 1;
      continue;
    }
    if (a.deprecated && !old.deprecated) report.newlyDeprecated.push({ uuid, name: a.name });
    if (geomKey(a) !== geomKey(old)) report.geometryChanged.push({ uuid, name: a.name });
  }
  if (!prev) report.added = next.assets.length;
  for (const [uuid, a] of before) if (!after.has(uuid)) report.removed.push({ uuid, name: a.name });

  // Palette roles hit by missing/deprecated assets in the NEW catalog.
  const usable = (uuid: string): boolean => {
    const a = after.get(uuid.toLowerCase());
    return a !== undefined && !a.deprecated;
  };
  for (const palette of palettes) {
    for (const [role, def] of Object.entries(palette.roles)) {
      for (const v of def.variants) {
        if (usable(v.asset)) continue;
        const alt = (v.alternates ?? []).some((u) => usable(u) && v.alternateGeom?.[u] !== undefined);
        report.affectedPaletteRoles.push({
          paletteId: palette.id,
          role,
          uuid: v.asset,
          resolution: alt ? "alternate" : def.fallback !== undefined ? "fallback_role" : "dropped",
        });
      }
    }
  }
  return report;
}
