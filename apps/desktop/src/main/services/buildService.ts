import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ChunkOptions, CompileEstimate, ExportBundle, LevelId, MapPlan } from "@slabyrinth/core";
import type { BuildRecord } from "../../shared/project";
import type { Logger } from "../logger";
import { availabilityFromCatalog, type CompileInput } from "../ports/compile";
import { writeFileAtomic } from "../util/atomicWrite";
import { AppFailure } from "../util/errors";
import type { CompileService } from "./compileService";
import type { Dialogs } from "./dialogs";
import type { PaletteService } from "./paletteService";
import { sanitizeFileName, type ProjectService } from "./projectService";
import type { SettingsStore } from "./settingsStore";
import type { CatalogService } from "./talespire/catalogService";

/**
 * Build orchestration (compile:run / compile:estimate / build:*): assembles compile inputs
 * (palettes, orientation, asset availability from the scanned catalog), runs the worker, records a
 * BuildRecord in the project (slab strings are never stored; they are recompiled on demand since
 * the compile is deterministic) and keeps recent bundles in memory for "Save as .txt".
 */
export const SLAB_LIMIT_BYTES = 30_720;

export interface BuildServiceDeps {
  projects: ProjectService;
  compiler: CompileService;
  palettes: PaletteService;
  catalog: CatalogService;
  settings: SettingsStore;
  dialogs: Dialogs;
  logger: Logger;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class BuildService {
  private readonly bundles = new Map<string, ExportBundle>();

  constructor(private readonly deps: BuildServiceDeps) {}

  private input(plan: MapPlan, options: ChunkOptions): CompileInput {
    const { palettes, userPalettes, orientation, orientationOverride } = this.deps.palettes.compileInputs();
    return {
      plan,
      options,
      palettes,
      userPalettes,
      orientation,
      orientationOverride,
      availability: availabilityFromCatalog(this.deps.catalog.current()),
    };
  }

  defaultOptions(): ChunkOptions {
    const ts = this.deps.settings.get().talespire;
    // One slab whenever the build fits; markers only when it is split (or the user always wants them).
    return { levelLayout: ts.levelLayout, alignment: ts.alignmentMarkers ? "always" : "multi-chunk" };
  }

  async estimate(plan: MapPlan, levels?: LevelId[], signal?: AbortSignal): Promise<CompileEstimate> {
    return this.deps.compiler.estimate(this.input(plan, this.defaultOptions()), levels, signal);
  }

  async estimateOpen(levels?: LevelId[]): Promise<CompileEstimate> {
    const plan = this.deps.projects.getPlan();
    if (!plan) throw new AppFailure("validation", "There's no plan to build yet.");
    return this.estimate(plan, levels);
  }

  async run(req: {
    version?: number | undefined;
    options?: ChunkOptions | undefined;
  }): Promise<ExportBundle & { buildId: string }> {
    const project = this.deps.projects.getProject();
    if (!project) throw new AppFailure("no_project", "No map is open.");
    const version = req.version ?? project.history.approvedVersion ?? project.history.head;
    const plan = this.deps.projects.getPlan(version);
    if (!plan) throw new AppFailure("validation", "Approve a plan to build it for TaleSpire.");
    const options: ChunkOptions = { ...this.defaultOptions(), ...(req.options ?? {}) };
    const bundle = await this.deps.compiler.run(this.input(plan, options));
    bundle.planVersion = version;
    const record = this.toRecord(bundle, options, project.builds[project.builds.length - 1]);
    this.deps.projects.addBuild(record);
    this.bundles.set(record.id, bundle);
    if (this.bundles.size > 5) this.bundles.delete(this.bundles.keys().next().value as string);
    this.deps.logger.info("build finished", { version, chunks: bundle.chunks.length });
    return { ...bundle, buildId: record.id };
  }

  cancel(): void {
    this.deps.compiler.cancel();
  }

  /**
   * BuildRecord from a bundle. Chunks are NOT assumed to belong to one level: the default build is a
   * single slab holding every level, and a split build may have chunks spanning several levels
   * (docs/decisions.md "Export: fewest slabs possible"). Each chunk is recorded exactly once, under
   * its host level (the first of its `levelIds` that the bundle places), keeps `levelIds`, and
   * globalStep follows the bundle's paste order.
   */
  private toRecord(
    bundle: ExportBundle,
    options: ChunkOptions,
    previous: BuildRecord | undefined,
  ): BuildRecord {
    const fp = this.deps.palettes.fingerprints();
    const catalog = this.deps.catalog.current();
    const regionKey = (id: string, r: { x0: number; y0: number; x1: number; y1: number }): string =>
      `${id}:${String(r.x0)},${String(r.y0)},${String(r.x1)},${String(r.y1)}`;
    const prevChunks = new Map<string, string>();
    for (const l of previous?.levels ?? [])
      for (const c of l.chunks) prevChunks.set(regionKey(c.id, c.region), c.contentHash);

    const levels: BuildRecord["levels"] = [...bundle.levelPlacement]
      .sort((a, b) => a.pasteOrder - b.pasteOrder)
      .map((lp) => {
        const placement: BuildRecord["levels"][number]["placement"] = { kind: lp.kind };
        if (lp.storeys !== undefined) placement.storeys = lp.storeys;
        if (lp.offsetSq !== undefined) placement.offsetSq = lp.offsetSq;
        return { levelId: lp.levelId, pasteOrder: lp.pasteOrder, placement, chunks: [] };
      });
    const hostFor = (c: ExportBundle["chunks"][number]): BuildRecord["levels"][number] => {
      const ids = c.levelIds;
      for (const id of [...ids, c.levelId]) {
        const found = levels.find((l) => l.levelId === id);
        if (found) return found;
      }
      const added: BuildRecord["levels"][number] = {
        levelId: ids[0] ?? c.levelId,
        pasteOrder: levels.length + 1,
        placement: { kind: "ground" },
        chunks: [],
      };
      levels.push(added);
      return added;
    };
    bundle.chunks.forEach((c, i) => {
      const region = {
        x0: c.cellRect.x,
        y0: c.cellRect.y,
        x1: c.cellRect.x + c.cellRect.w,
        y1: c.cellRect.y + c.cellRect.h,
      };
      const prev = prevChunks.get(regionKey(c.id, region));
      const chunk: BuildRecord["levels"][number]["chunks"][number] = {
        id: c.id,
        levelIds: [...c.levelIds],
        index: c.index,
        globalStep: i + 1,
        label: c.label,
        region,
        sizeBytes: c.compressedBytes,
        limitBytes: SLAB_LIMIT_BYTES,
        contentHash: c.contentHash,
        offset: c.offsetFromFirst,
        pasted: false,
      };
      if (prev !== undefined) chunk.changedSinceBuild = prev !== c.contentHash;
      hostFor(c).chunks.push(chunk);
    });
    const missing = new Map<string, number>();
    for (const d of bundle.diagnostics) {
      if (d.code === "role_missing" && d.role !== undefined)
        missing.set(d.role, (missing.get(d.role) ?? 0) + (d.count ?? 1));
    }
    return {
      id: randomUUID(),
      versionNumber: bundle.planVersion,
      createdAt: bundle.createdAt,
      catalogVersion: catalog?.generatedAt ?? "builtin",
      assetSource: bundle.assetSource,
      settings: {
        stacking: options.levelLayout ?? "stacked",
        gapSq: options.sideBySideGap ?? 10,
        markers: options.alignment ?? "multi-chunk",
        grouping: options.grouping ?? "fewest",
        ...(options.fill !== undefined ? { fill: options.fill } : {}),
        ...(options.levels !== undefined ? { levels: [...options.levels] } : {}),
        ...(options.tileCells !== undefined ? { tileCells: options.tileCells } : {}),
        copyFormat: "plain",
        orientationHash: sha(fp.orientation),
        paletteHash: sha(fp.palettes),
      },
      levels,
      substitutions: bundle.substitutions.map((s) => ({
        role: s.role,
        wanted: s.wanted.name ?? s.wanted.uuid,
        used: s.used === null ? null : (s.used.name ?? s.used.uuid),
        count: s.count,
      })),
      unmatchedAssets: [...missing.entries()].map(([role, count]) => ({ role, count })),
      diagnosticsSummary: {
        errors: bundle.diagnostics.filter((d) => d.severity === "error").length,
        warnings: bundle.diagnostics.filter((d) => d.severity === "warning").length,
      },
    };
  }

  /** A build's bundle; recompiles the build's version when the bundle is no longer in memory. */
  private async bundleOf(buildId: string): Promise<ExportBundle> {
    let bundle = this.bundles.get(buildId);
    if (!bundle) {
      const record = this.deps.projects.findBuild(buildId);
      const plan = this.deps.projects.getPlan(record.versionNumber);
      if (!plan) throw new AppFailure("not_found", "That build's plan version no longer exists.");
      bundle = await this.deps.compiler.run(this.input(plan, BuildService.optionsOf(record)));
      this.bundles.set(buildId, bundle);
    }
    return bundle;
  }

  /**
   * A recompile with the recorded options reproduces the recorded chunk unless the build inputs changed since
   * (palettes, orientation or the asset library): never hand out a different slab under the old chunk's name.
   */
  private checkUnchanged(buildId: string, chunk: ExportBundle["chunks"][number]): void {
    const record = this.deps.projects.getProject()?.builds.find((b) => b.id === buildId);
    const recorded = record?.levels.flatMap((l) => l.chunks).find((c) => c.id === chunk.id);
    if (recorded && recorded.contentHash !== chunk.contentHash)
      throw new AppFailure(
        "validation",
        "The palettes or asset library changed since this build. Build again to copy it.",
      );
  }

  /** Slab text of a chunk. */
  async chunkSlab(buildId: string, chunkId: string): Promise<string> {
    const bundle = await this.bundleOf(buildId);
    const chunk = bundle.chunks.find((c) => c.id === chunkId);
    if (!chunk) throw new AppFailure("not_found", "That chunk isn't part of this build.");
    this.checkUnchanged(buildId, chunk);
    return chunk.slab;
  }

  /** Every chunk of a build in paste order, with its slab and asset count (the TaleSpire add-on's chunk set). */
  async chunksForSend(buildId: string): Promise<{
    record: BuildRecord;
    chunks: Array<{ id: string; label: string; slab: string; assetCount: number }>;
  }> {
    const record = this.deps.projects.findBuild(buildId);
    const bundle = await this.bundleOf(buildId);
    for (const c of bundle.chunks) this.checkUnchanged(buildId, c);
    return {
      record,
      chunks: bundle.chunks.map((c) => ({
        id: c.id,
        label: c.label,
        slab: c.slab,
        assetCount: c.assetCount,
      })),
    };
  }

  /** The ChunkOptions a build was made with (older records: the compiler defaults for what they lack). */
  static optionsOf(record: BuildRecord): ChunkOptions {
    const s = record.settings;
    const o: ChunkOptions = {
      levelLayout: s.stacking,
      alignment: s.markers,
      sideBySideGap: s.gapSq,
      grouping: s.grouping ?? "fewest",
    };
    if (s.fill !== undefined) o.fill = s.fill;
    if (s.levels !== undefined) o.levels = [...s.levels];
    if (s.tileCells !== undefined) o.tileCells = s.tileCells;
    return o;
  }

  async saveChunk(buildId: string, chunkId: string): Promise<{ path: string } | null> {
    const slab = await this.chunkSlab(buildId, chunkId);
    const project = this.deps.projects.getProject();
    const target = await this.deps.dialogs.saveFile({
      title: "Save slab as text",
      defaultPath: path.join(
        this.deps.settings.get().projects.folder,
        `${sanitizeFileName(`${project?.name ?? "map"} ${chunkId}`)}.txt`,
      ),
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (target === null) return null;
    await writeFileAtomic(target, `${slab}\n`);
    return { path: target };
  }
}
