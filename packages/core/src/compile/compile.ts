/** Compile entry points: resolved plan → bundle, plan → bundle (with injected validate/resolve), and the estimate. */
import type {
  ChunkOptions,
  CompileDiagnostic,
  CompileEstimate,
  CompilePlan,
  ExportBundle,
  OrientationCalibration,
  PaletteCatalog,
  SlabCodec,
} from "../contracts/compiler";
import type { LevelId, MapPlan, ValidationResult } from "../contracts/plan";
import type { ResolvedPlan } from "../contracts/resolved";
import { paletteOptionsFor, type PaletteView } from "../palette/view";
import { slabCodec } from "../slab/codec";
import { DEFAULT_FILL, chunkAndEncode, extentDiagnostic, type ChunkEncodeOptions } from "./chunk";
import { realize } from "./realize";
import type { RealizedSet } from "./realize/output";
import { verifyBuild, type VerifyOptions } from "./verify/verify";

/** Compressed bytes per instance used by the estimate (format research §1: real slabs compress to ~3.4 B/asset). */
export const ESTIMATE_BYTES_PER_ASSET = 3.4;

export interface CompileOptions extends ChunkEncodeOptions {
  orientation?: OrientationCalibration;
  seed?: number;
  /** Entry level for the verify stage's reachability check (MapPlan.entryLevel). */
  entryLevelId?: LevelId;
  /** Skip the verify stage (default false). */
  skipVerify?: boolean;
  /** The plan: lets verify reuse the resolver's WalkGraph and skip problems the plan-level pass already reports. */
  plan?: MapPlan;
  /** Paste layers to leave out of the build (Placement.layer), e.g. ["roof"] for a see-inside build. */
  omitLayers?: string[];
}

/** realize → verify, shared by compile and estimate. Verify diagnostics are appended to the set's diagnostics. */
function realizeAndVerify(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: {
    levels?: LevelId[];
    seed?: number;
    orientation?: OrientationCalibration;
    entryLevelId?: LevelId;
    skipVerify?: boolean;
    plan?: MapPlan;
    omitLayers?: string[];
  },
): RealizedSet {
  const ropts: {
    levels?: LevelId[];
    seed?: number;
    orientation?: OrientationCalibration;
    omitLayers?: string[];
  } = {};
  if (opts.omitLayers) ropts.omitLayers = opts.omitLayers;
  if (opts.levels) ropts.levels = opts.levels;
  if (opts.seed !== undefined) ropts.seed = opts.seed;
  if (opts.orientation) ropts.orientation = opts.orientation;
  const set = realize(resolved, palettes, ropts);
  if (!opts.skipVerify) {
    const vopts: VerifyOptions = {};
    if (opts.entryLevelId) vopts.entryLevelId = opts.entryLevelId;
    if (opts.plan) vopts.plan = opts.plan;
    if (opts.orientation) vopts.flipZ = opts.orientation.flipZ;
    set.diagnostics.push(...verifyBuild(resolved, set, palettes, vopts).diagnostics);
  }
  return set;
}

/** realize → verify → chunk → encode → bundle for an already-resolved plan. */
export function compileResolved(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  codec: SlabCodec = slabCodec,
  opts: CompileOptions = {},
): ExportBundle {
  const set = realizeAndVerify(resolved, palettes, opts);
  return chunkAndEncode(set, codec, opts);
}

export interface CompileDeps {
  /** `palette` is a view of the palettes the plan is compiled with (generator 4+), so both stages decide from the same ones. */
  resolvePlan: (plan: MapPlan, opts?: { levels?: LevelId[]; palette?: PaletteView }) => ResolvedPlan;
  /** Optional: plans with error issues are refused with `plan_invalid`. */
  validatePlan?: (plan: MapPlan) => ValidationResult;
  orientation?: OrientationCalibration;
}

/**
 * Builds the contract's `CompilePlan` (validate → resolve → realize → chunk → encode) from WP1/WP2 functions,
 * which are injected so this module does not depend on their implementation status.
 */
export function createCompilePlan(deps: CompileDeps): CompilePlan {
  return (plan: MapPlan, palettes: PaletteCatalog, codec: SlabCodec, opts?: ChunkOptions): ExportBundle => {
    if (deps.validatePlan) {
      const v = deps.validatePlan(plan);
      const errors = v.issues.filter((i) => i.severity === "error");
      if (!v.ok || errors.length) {
        const diagnostics: CompileDiagnostic[] = errors.map((i) => {
          const d: CompileDiagnostic = {
            severity: "error",
            code: "plan_invalid",
            stage: "validate",
            message: `${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ""}`,
          };
          if (i.levelId) d.levelId = i.levelId;
          if (i.elementId) d.elementId = i.elementId;
          return d;
        });
        return {
          planId: plan.id,
          planVersion: 0,
          resolvedHash: "",
          createdAt: new Date().toISOString(),
          chunks: [],
          diagnostics,
          stats: { totalAssets: 0, totalChunks: 0, perLevel: [], droppedPlacements: 0 },
          instructions: "Build refused: the plan has validation errors.",
          assetSource:
            palettes.availability.status("00000000-0000-0000-0000-000000000000") === null
              ? "builtin"
              : "install",
          substitutions: [],
          levelPlacement: [],
        };
      }
    }
    const view = paletteOptionsFor(plan, palettes);
    const resolved = deps.resolvePlan(plan, opts?.levels ? { levels: opts.levels, ...view } : view);
    const copts: CompileOptions = { ...(opts ?? {}) };
    if (deps.orientation) copts.orientation = deps.orientation;
    if (plan.entryLevel) copts.entryLevelId = plan.entryLevel;
    copts.plan = plan;
    const bundle = compileResolved(resolved, palettes, codec, copts);
    const resolveIssues: CompileDiagnostic[] = resolved.issues
      .filter((i) => i.severity !== "info")
      .map((i) => {
        const d: CompileDiagnostic = {
          severity: i.severity === "error" ? "error" : "warning",
          code: "plan_invalid",
          stage: "resolve",
          message: `${i.code}: ${i.message}`,
        };
        if (i.levelId) d.levelId = i.levelId;
        if (i.elementId) d.elementId = i.elementId;
        return d;
      });
    return { ...bundle, diagnostics: [...resolveIssues, ...bundle.diagnostics] };
  };
}

/** Cheap estimate (realize only, no gzip) for the agent's compile_preview tool and the UI badge. */
export function estimate(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: {
    levels?: LevelId[];
    fill?: number;
    orientation?: OrientationCalibration;
    maxCompressedBytes?: number;
    grouping?: ChunkOptions["grouping"];
    levelLayout?: ChunkOptions["levelLayout"];
    sideBySideGap?: number;
    entryLevelId?: LevelId;
    plan?: MapPlan;
  } = {},
): CompileEstimate {
  // the estimate runs the verify stage too, so compile_preview reports build problems to the agent
  const set = realizeAndVerify(resolved, palettes, opts);
  // the same coordinate-range check compile runs (shared code): never more optimistic than compile
  const eopts: Pick<ChunkEncodeOptions, "levels" | "levelLayout" | "sideBySideGap"> = {};
  if (opts.levels) eopts.levels = opts.levels;
  if (opts.levelLayout) eopts.levelLayout = opts.levelLayout;
  if (opts.sideBySideGap !== undefined) eopts.sideBySideGap = opts.sideBySideGap;
  const overflow = extentDiagnostic(set, slabCodec, eopts);
  if (overflow) set.diagnostics.push(overflow);
  const budget =
    (opts.fill ?? DEFAULT_FILL) * (opts.maxCompressedBytes ?? slabCodec.limits.maxCompressedBytes);
  const perLevel = set.levels.map((l) => ({
    levelId: l.levelId,
    assets: l.placements.length,
    estimatedChunks:
      l.placements.length === 0
        ? 0
        : Math.max(1, Math.ceil((l.placements.length * ESTIMATE_BYTES_PER_ASSET) / budget)),
  }));
  // "fewest" (default): every level shares slabs, so the build needs ceil(total / budget) chunks, not one per level.
  const perLevelSum = perLevel.reduce((s, l) => s + l.estimatedChunks, 0);
  const total = set.stats.total;
  const whole = total === 0 ? 0 : Math.max(1, Math.ceil((total * ESTIMATE_BYTES_PER_ASSET) / budget));
  return {
    perLevel,
    totalAssets: total,
    // compile refuses an overflowing build (0 chunks); so does the estimate
    estimatedChunks: overflow ? 0 : opts.grouping === "per-level" ? perLevelSum : whole,
    // errors first, so a truncated list (compile_preview shows 20) keeps them
    diagnostics: set.diagnostics
      .filter((d) => d.severity !== "info")
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)),
  };
}
