/**
 * Realize, plan-wide context: what every pass on every level shares, built once per realize() call.
 * Reads: the resolved plan, the palettes, the options and the orientation calibration.
 * Writes: through `lookup` and `addDiag`, the build's diagnostics (`diag`) and asset substitutions (`subs`); through
 * `placed`, each placement's name, geometry and world box (written by `RealizeLevel.emit`, realize/level.ts, and handed
 * on as the set's `PlacementSet.placed`).
 */
import type {
  CompileDiagnostic,
  OrientationCalibration,
  PaletteCatalog,
  PaletteFacing,
  PlacedAsset,
  Placement,
  RoleName,
} from "../../contracts/compiler";
import type { LevelId, ThemeId } from "../../contracts/plan";
import type { ResolvedPlan } from "../../contracts/resolved";
import { ValueNoise } from "../../gen/noise";
import { frontSide } from "../../gen/pieceFacts";
import { loadOrientation } from "../../palette/load";
import { own } from "../../util/own";
import { createPlanRoles } from "../../palette/planRoles";
import { type ResolvedVariant, type ResolveOutcome, type VariantFilter } from "../../palette/resolve";
import { generatorProfile, type GeneratorProfile } from "../../plan/generator";
import { familiesOfVariants, type FloorFamily } from "../../resolve/floorFamilies";
import { BuildFacts } from "../buildFacts";
import { WorldFrame } from "../geometry";
import { h32Utf16, hashUnitUtf16 } from "../../util/hash";

export interface RealizeOptions {
  levels?: LevelId[];
  seed?: number;
  orientation?: OrientationCalibration;
  /**
   * Paste layers to leave out (Placement.layer): "roof" drops roofs, attic decks, gable fill and attachment roofs
   * (a see-inside build); "storey:2" drops one storey. Absent = everything.
   */
  omitLayers?: string[];
}

export interface BundleSubstitution {
  role: RoleName;
  wanted: { uuid: string; name?: string };
  used: { uuid: string; name?: string } | null;
  count: number;
}

export type AddDiag = (
  d: Omit<CompileDiagnostic, "count" | "stage"> & { stage?: CompileDiagnostic["stage"] },
  n?: number,
) => void;

/** Role lookup with diagnostics: the first of `roles` the theme's palette resolves (quiet: no role_missing warning). */
export type Lookup = (
  levelId: LevelId,
  theme: ThemeId,
  roles: RoleName[],
  filter?: VariantFilter,
  quiet?: boolean,
) => ResolveOutcome["resolution"];

export interface RealizeCtx {
  readonly resolved: ResolvedPlan;
  readonly palettes: PaletteCatalog;
  readonly opts: RealizeOptions;
  readonly orientation: OrientationCalibration;
  readonly seed: number;
  readonly frame: WorldFrame;
  /**
   * What the plan's generator does (plan/generator.ts): every version-dependent rule of a pass reads a switch of it.
   * Palette roles carry their own first generator (minGenerator).
   */
  readonly profile: GeneratorProfile;
  /** The theme a theme with no palette is built in (palette/planRoles.ts). */
  readonly defaultTheme: ThemeId;
  /** Diagnostics of the whole build, merged by severity, code, level, role and element. */
  readonly diag: Map<string, CompileDiagnostic>;
  readonly addDiag: AddDiag;
  /** Asset substitutions the palette made, counted per role, wanted and used asset. */
  readonly subs: Map<string, BundleSubstitution>;
  /** Name, geometry and world box of every placement of this call (`RealizeLevel.emit` writes; the set carries it). */
  readonly placed: Map<Placement, PlacedAsset>;
  /**
   * The world turn of every placement of this call (game degrees clockwise, the build's rotSense applied), decided once
   * by `RealizeLevel.emit`: settle, the stall canopies and verify read it (the set carries it as `RealizedSet.turns`), so
   * no later reader derives a turn again from an orientation that may not be the build's.
   */
  readonly turns: Map<Placement, number>;
  /**
   * The role answers and the per-level facts (grid, faces, claims) of this build, shared with verify through the set
   * (compile/buildFacts.ts); links read the level above's grid from it.
   */
  readonly facts: BuildFacts;
  /** The one way a pass asks for a role: `facts.roles` with the theme_fallback and role_missing diagnostics. */
  readonly lookup: Lookup;
  /** Seeded weighted pick among a role's variants. */
  readonly pick: (vs: ResolvedVariant[], key: string) => ResolvedVariant | undefined;
  /** Weighted pick in organic patches (floors). */
  readonly pickPatch: (
    vs: ResolvedVariant[],
    x: number,
    y: number,
    key: string,
  ) => ResolvedVariant | undefined;
  /** Floor families of a role's variants. */
  readonly familiesOf: (vs: ResolvedVariant[]) => FloorFamily[];
  /** The floor family of a cell from the coarse family noise. */
  readonly familyAt: (fams: Array<{ name: string; share: number }>, x: number, y: number) => string;
  /** The family noise's warp field (also feathers caused families). */
  readonly familyWarp: ValueNoise;
  /** The facing a variant's asset has at rot 0 (orientation defaults, then the variant's own). */
  readonly facingOf: (v: ResolvedVariant, rolePrefix: string, role: RoleName) => PaletteFacing;
}

/**
 * A variant's facing at rot 0: the calibration's defaults ("*", the role's prefix, the role), the palette's own
 * `facing`, and over them a front measured from the piece's mesh (gen/pieceFacts.ts `frontSide`, the one source the
 * object engine reads too). Only generator-5 kit pieces carry a measured front, so no frozen generator's turn moves.
 */
export function variantFacing(
  defaults: Readonly<Record<string, PaletteFacing>>,
  v: Pick<ResolvedVariant, "name" | "facing">,
  rolePrefix: string,
  role: RoleName,
): PaletteFacing {
  const measured = frontSide(v.name);
  return {
    ...(own(defaults, "*") ?? {}),
    ...(own(defaults, rolePrefix) ?? {}),
    ...(own(defaults, role) ?? {}),
    ...(v.facing ?? {}),
    ...(measured !== undefined ? { front: measured } : {}),
  };
}

export function createRealizeCtx(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: RealizeOptions,
): RealizeCtx {
  const orientation = opts.orientation ?? loadOrientation().orientation;
  const seed = opts.seed ?? h32Utf16(resolved.planId);
  const hg = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const frame = new WorldFrame(orientation, hg);
  const profile = generatorProfile(resolved);
  // the one answer realize builds from and verify judges by (the set carries it)
  const facts = new BuildFacts(resolved, createPlanRoles(palettes, resolved.generator), profile);
  const { roles } = facts;
  const { defaultTheme } = roles;

  const diag = new Map<string, CompileDiagnostic>();
  const addDiag = (
    d: Omit<CompileDiagnostic, "count" | "stage"> & { stage?: CompileDiagnostic["stage"] },
    n = 1,
  ): void => {
    const key = [d.severity, d.code, d.levelId ?? "", d.role ?? "", d.elementId ?? ""].join("|");
    const prev = diag.get(key);
    if (prev) prev.count = (prev.count ?? 1) + n;
    else diag.set(key, { ...d, stage: d.stage ?? "realize", count: n });
  };
  const subs = new Map<string, BundleSubstitution>();
  const themeWarned = new Set<string>();

  // ── role lookup with diagnostics ──
  const lookup = (
    levelId: LevelId,
    theme: ThemeId,
    roleNames: RoleName[],
    filter?: VariantFilter,
    quiet = false,
  ): ResolveOutcome["resolution"] => {
    const t = roles.paletteTheme(theme);
    if (t !== theme && !themeWarned.has(theme)) {
      themeWarned.add(theme);
      addDiag({
        severity: "warning",
        code: "theme_fallback",
        message: `Theme "${theme}" has no palette; using "${defaultTheme}"`,
        levelId,
      });
    }
    for (const role of roleNames) {
      const out = roles.resolve(t, role, filter);
      if (out.resolution) {
        for (const s of out.substitutions) {
          const k = `${s.role}|${s.wanted.uuid}|${s.used?.uuid ?? ""}`;
          const e = subs.get(k);
          if (e) e.count++;
          else subs.set(k, { ...s, count: 1 });
        }
        return out.resolution;
      }
    }
    if (!quiet) {
      const role = roleNames[0] ?? "?";
      addDiag({
        severity: "warning",
        code: "role_missing",
        message: `No usable palette asset for role "${role}"${filter ? ` (${filter.key})` : ""} in theme "${t}"; placements dropped`,
        levelId,
        role,
      });
    }
    return null;
  };

  const pick = (vs: ResolvedVariant[], key: string): ResolvedVariant | undefined => {
    const weighted = vs.filter((v) => v.weight > 0);
    const pool = weighted.length ? weighted : vs.slice(0, 1);
    const total = pool.reduce((s, v) => s + v.weight, 0);
    if (pool.length <= 1 || total <= 0) return pool[0];
    let r = hashUnitUtf16(seed, key) * total;
    for (const v of pool) {
      r -= v.weight;
      if (r < 0) return v;
    }
    return pool[pool.length - 1];
  };

  /**
   * Floor variants in organic patches: a value-noise field (about 5 cells across) picks the variant by
   * its weight band, with a little per-tile jitter, so variants form patches instead of a salt-and-pepper grid.
   */
  const patchNoise = new ValueNoise(h32Utf16(`${seed}:floorpatches`));
  const pickPatch = (
    vs: ResolvedVariant[],
    x: number,
    y: number,
    key: string,
  ): ResolvedVariant | undefined => {
    const weighted = vs.filter((v) => v.weight > 0);
    if (weighted.length <= 1) return pick(vs, key);
    const total = weighted.reduce((sum, v) => sum + v.weight, 0);
    const jitter = (hashUnitUtf16(seed, key, "j") - 0.5) * 0.15;
    let r = Math.min(0.9999, Math.max(0, patchNoise.sample(x / 5, y / 5) + jitter)) * total;
    for (const v of weighted) {
      r -= v.weight;
      if (r < 0) return v;
    }
    return weighted[weighted.length - 1];
  };

  /**
   * Floor families: a floor role's weighted variants that carry a `variant` name form a family
   * each (untagged variants are the default family) — rock slab, dark rock, packed earth, gravel; short and lush
   * grass. A coarse value-noise field (about 7 cells across, stretched so every family shows) gives each cell one
   * family, so the floor reads as large irregular patches of different ground instead of one tile on a grid. Each
   * family's share is its heaviest variant's weight. Roles without tagged variants behave as before.
   */
  const familyNoise = new ValueNoise(h32Utf16(`${seed}:floorfamilies`));
  const familyWarp = new ValueNoise(h32Utf16(`${seed}:floorfamilies:warp`));
  const familiesOf = (vs: ResolvedVariant[]): FloorFamily[] => familiesOfVariants(vs);
  const familyAt = (fams: Array<{ name: string; share: number }>, x: number, y: number): string => {
    if (fams.length <= 1) return fams[0]?.name ?? "";
    const total = fams.reduce((t, q) => t + q.share, 0);
    const wx = (familyWarp.sample(x / 4, y / 4) - 0.5) * 3;
    const raw = familyNoise.sample((x + wx) / 7, (y - wx) / 7);
    let r = Math.min(0.9999, Math.max(0, (raw - 0.5) * 1.9 + 0.5)) * total;
    for (const q of fams) {
      r -= q.share;
      if (r < 0) return q.name;
    }
    return fams[fams.length - 1]?.name ?? "";
  };

  const facingOf = (v: ResolvedVariant, rolePrefix: string, role: RoleName): PaletteFacing =>
    variantFacing(orientation.defaultFacing, v, rolePrefix, role);

  return {
    resolved,
    palettes,
    opts,
    orientation,
    seed,
    frame,
    profile,
    defaultTheme,
    diag,
    addDiag,
    subs,
    placed: new Map(),
    turns: new Map(),
    facts,
    lookup,
    pick,
    pickPatch,
    familiesOf,
    familyAt,
    familyWarp,
    facingOf,
  };
}
