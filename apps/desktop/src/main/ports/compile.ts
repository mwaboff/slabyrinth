import { createHash } from "node:crypto";
import { createAvailability } from "@slabyrinth/core/catalog";
import { createCompilePlan, estimate as coreEstimate } from "@slabyrinth/core/compile";
import { loadOrientation, loadPalettes } from "@slabyrinth/core/palette";
import { isBlocking } from "@slabyrinth/core";
import { validatePlan } from "@slabyrinth/core/plan";
import { resolvePlan } from "@slabyrinth/core/resolve";
import { slabCodec } from "@slabyrinth/core/slab";
import type {
  AssetCatalog,
  CatalogAsset,
  ChunkOptions,
  CompileEstimate,
  ExportBundle,
  LevelId,
  MapPlan,
  OrientationCalibration,
  Palette,
  PaletteCatalog,
  SlabChunk,
} from "@slabyrinth/core";

/**
 * Port onto core's compiler (resolve → realize → chunk → encode). Runs inside the compile
 * worker_thread. Bundled palettes and orientation are compiled into core; user overrides
 * (userData/palettes, userData/orientation.json) are passed in as raw JSON. The fake backend is a
 * dev/test aid only (the `fakeCompile` flag in development runs).
 */
export type CompileStage = "resolve" | "realize" | "chunk" | "encode";

export interface CompileInput {
  plan: MapPlan;
  options: ChunkOptions;
  /** Effective palettes (bundled + user) as the shell sees them (fake backend, diagnostics). */
  palettes: Palette[];
  /** Raw user palette files for core's loader. */
  userPalettes: Array<{ source: string; data: unknown }>;
  orientation: unknown;
  orientationOverride: unknown;
  /** Assets of the scanned catalog; null = no catalog (built-in asset set: everything counts as present). */
  availability: CatalogAsset[] | null;
}

export interface CompileBackend {
  readonly kind: "core" | "fake";
  compile(
    input: CompileInput,
    progress: (stage: CompileStage, done: number, total: number) => void,
  ): ExportBundle;
  estimate(input: CompileInput, levels?: LevelId[]): CompileEstimate;
}

export function availabilityFromCatalog(catalog: AssetCatalog | null): CompileInput["availability"] {
  return catalog ? catalog.assets : null;
}

export function createCoreCompileBackend(): CompileBackend {
  const orientationFor = (input: CompileInput): OrientationCalibration =>
    loadOrientation(input.orientationOverride ?? undefined).orientation;
  const palettesFor = (input: CompileInput): PaletteCatalog =>
    input.availability === null
      ? loadPalettes({ user: input.userPalettes })
      : loadPalettes({
          user: input.userPalettes,
          availability: createAvailability(input.availability),
          // assets from game updates join their roles as low-weight extra variants (core palette/auto.ts)
          catalog: input.availability,
        });

  return {
    kind: "core",
    compile(input, progress) {
      progress("resolve", 0, 4);
      const compilePlan = createCompilePlan({
        resolvePlan: (plan, opts) => resolvePlan(plan, opts ?? {}),
        // Only blocking issues refuse a build; playability findings are reported, never refused
        // (decisions.md "Playability validation"). createCompilePlan passes the plan to verify,
        // which then skips build findings the plan-level checks already report.
        validatePlan: (plan) => {
          const blocking = validatePlan(plan).issues.filter(isBlocking);
          return { ok: blocking.length === 0, issues: blocking };
        },
        orientation: orientationFor(input),
      });
      const palettes = palettesFor(input);
      progress("realize", 1, 4);
      const bundle = compilePlan(input.plan, palettes, slabCodec, input.options);
      progress("encode", 4, 4);
      return bundle;
    },
    estimate(input, levels) {
      const resolved = resolvePlan(input.plan, levels === undefined ? {} : { levels });
      // The plan lets verify skip findings the plan-level playability pass already reports.
      const opts: Parameters<typeof coreEstimate>[2] = {
        orientation: orientationFor(input),
        plan: input.plan,
      };
      if (input.plan.entryLevel !== undefined) opts.entryLevelId = input.plan.entryLevel;
      if (levels !== undefined) opts.levels = levels;
      if (input.options.grouping !== undefined) opts.grouping = input.options.grouping;
      if (input.options.fill !== undefined) opts.fill = input.options.fill;
      return coreEstimate(resolved, palettesFor(input), opts);
    },
  };
}

// ───────────────────────── fake backend (tests; dev runs with the fakeCompile flag) ─────────────────────────

const levelArea = (plan: MapPlan, id: string): number => {
  const l = plan.levels.find((x) => x.id === id);
  return l ? l.bounds.w * l.bounds.h : 0;
};

/**
 * Deterministic stand-in. Its "slabs" are NOT valid TaleSpire slabs (they say so), so a dev build
 * can exercise the build/paste UI without anything pastable reaching the game.
 */
export const fakeCompileBackend: CompileBackend = {
  kind: "fake",
  estimate(input, levels) {
    const ids = levels ?? input.plan.levels.map((l) => l.id);
    const perLevel = ids.map((levelId) => {
      const assets = Math.round(levelArea(input.plan, levelId) * 0.6);
      return { levelId, assets, estimatedChunks: Math.max(1, Math.ceil(assets / 1500)) };
    });
    const totalAssets = perLevel.reduce((n, l) => n + l.assets, 0);
    return {
      perLevel,
      totalAssets,
      // Whole build, "fewest" grouping (levels share slabs), like core.
      estimatedChunks: totalAssets === 0 ? 0 : Math.max(1, Math.ceil(totalAssets / 1500)),
      diagnostics: [],
    };
  },
  compile(input, progress) {
    // Mirrors core's default (decisions.md "Export: fewest slabs possible"): ONE slab holding every
    // level; the chunk's levelId is the lowest level and it spans all of them.
    const plan = input.plan;
    const ids = input.options.levels ?? plan.levels.map((l) => l.id);
    progress("realize", 0, 1);
    const levels = plan.levels.filter((l) => ids.includes(l.id)).sort((a, b) => a.elevation - b.elevation);
    const chunks: SlabChunk[] = [];
    const first = levels[0];
    if (first) {
      const x = Math.min(...levels.map((l) => l.bounds.x));
      const y = Math.min(...levels.map((l) => l.bounds.y));
      const w = Math.max(...levels.map((l) => l.bounds.x + l.bounds.w)) - x;
      const h = Math.max(...levels.map((l) => l.bounds.y + l.bounds.h)) - y;
      const assets = levels.reduce((n, l) => n + Math.round(l.bounds.w * l.bounds.h * 0.6), 0);
      const slab = `NOT-A-REAL-SLAB:${plan.id}`;
      chunks.push({
        id: "build-01",
        levelId: first.id,
        levelIds: levels.map((l) => l.id),
        index: 1,
        countInLevel: 1,
        slab,
        compressedBytes: slab.length,
        base64Length: slab.length,
        assetCount: assets,
        bounds: {
          min: { x: 0, y: first.elevation, z: 0 },
          max: { x: w, y: Math.max(...levels.map((l) => l.elevation)) + 2, z: h },
        },
        cellRect: { x, y, w, h },
        pasteNote: "Fake build: the compiler isn't in this build.",
        hasAlignmentMarkers: false,
        label: "Whole map",
        columns: "",
        offsetFromFirst: { x: 0, y: 0, z: 0 },
        contentHash: createHash("sha256").update(JSON.stringify(levels)).digest("hex"),
      });
    }
    progress("encode", 1, 1);
    const sorted = [...plan.levels]
      .sort((a, b) => a.elevation - b.elevation)
      .filter((l) => ids.includes(l.id));
    return {
      planId: plan.id,
      planVersion: 0,
      resolvedHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16),
      createdAt: new Date().toISOString(),
      chunks,
      diagnostics: [
        {
          severity: "warning",
          code: "plan_invalid",
          stage: "encode",
          message: "Fake compiler: these slabs are placeholders and won't paste into TaleSpire.",
        },
      ],
      stats: {
        totalAssets: chunks.reduce((n, c) => n + c.assetCount, 0),
        totalChunks: chunks.length,
        perLevel: ids.map((levelId) => ({
          levelId,
          assets: Math.round(levelArea(plan, levelId) * 0.6),
          chunks: 1,
        })),
        droppedPlacements: 0,
      },
      instructions: "Fake build — the real compiler isn't available in this build.",
      assetSource: input.availability ? "install" : "builtin",
      substitutions: [],
      levelPlacement: sorted.map((l, idx) => ({
        levelId: l.id,
        pasteOrder: idx + 1,
        kind: idx === 0 ? "ground" : "storeys-up",
        storeys: idx,
      })),
    };
  },
};
