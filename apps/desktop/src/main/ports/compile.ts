import { createCompilePlan, estimate as coreEstimate } from "@slabyrinth/core/compile";
import { buildPaletteCatalog, loadOrientation } from "@slabyrinth/core/palette";
import { planGate, validatePlan, type SizeTierId } from "@slabyrinth/core/plan";
import { planRules, resolvePlan } from "@slabyrinth/core/resolve";
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
} from "@slabyrinth/core";

/**
 * Port onto core's compiler (resolve → realize → chunk → encode). Runs inside the compile
 * worker_thread. Bundled palettes and orientation are compiled into core; user overrides
 * (userData/palettes, userData/orientation.json) are passed in as raw JSON.
 */
export type CompileStage = "resolve" | "realize" | "chunk" | "encode";

export interface CompileInput {
  plan: MapPlan;
  options: ChunkOptions;
  /** Effective palettes (bundled + user) as the shell sees them (diagnostics). */
  palettes: Palette[];
  /** Raw user palette files for core's loader. */
  userPalettes: Array<{ source: string; data: unknown }>;
  orientation: unknown;
  orientationOverride: unknown;
  /** Assets of the scanned catalog; null = no catalog (built-in asset set: everything counts as present). */
  availability: CatalogAsset[] | null;
  /** The map size tier the build gate holds the plan to (core plan/sizeTiers.ts); standard when absent. */
  sizeTier?: SizeTierId;
}

export interface CompileBackend {
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
  // the same function main builds its palettes with (services/buildPalettes.ts) and the CLI uses
  const palettesFor = (input: CompileInput): PaletteCatalog =>
    buildPaletteCatalog(input.userPalettes, input.availability);

  return {
    compile(input, progress) {
      progress("resolve", 0, 4);
      const compilePlan = createCompilePlan({
        resolvePlan: (plan, palettes, opts) => resolvePlan(plan, palettes, opts ?? {}),
        // What refuses a build is core's build gate (plan/gate.ts); playability findings are reported, never
        // refused. createCompilePlan passes the plan to verify, which then skips build findings the plan-level
        // checks already report.
        validatePlan: (plan, palettes) => {
          const { blocking } = planGate(
            validatePlan(
              plan,
              planRules(palettes, input.sizeTier !== undefined ? { sizeTier: input.sizeTier } : {}),
            ).issues,
            "build",
          );
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
      const palettes = palettesFor(input);
      const resolved = resolvePlan(input.plan, palettes, levels === undefined ? {} : { levels });
      // The plan lets verify skip findings the plan-level playability pass already reports.
      const opts: Parameters<typeof coreEstimate>[2] = {
        orientation: orientationFor(input),
        plan: input.plan,
      };
      if (input.plan.entryLevel !== undefined) opts.entryLevelId = input.plan.entryLevel;
      if (levels !== undefined) opts.levels = levels;
      if (input.options.grouping !== undefined) opts.grouping = input.options.grouping;
      if (input.options.fill !== undefined) opts.fill = input.options.fill;
      return coreEstimate(resolved, palettes, opts);
    },
  };
}
