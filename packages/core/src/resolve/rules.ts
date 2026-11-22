/**
 * The plan rules that need the resolver: the geometric and playability check validatePlan runs after its structural
 * ones, and the generator behind the `materialize` op. Plan and ops sit below the resolver and cannot import it, so
 * they take these as an argument (`ValidateContext.checks`, ops' `PlanRules`); this module builds them for the
 * palettes a plan is built with. Every caller passes them explicitly: no process-wide registration, so validatePlan
 * and applyOps give the same answer whoever imported what.
 */
import type { ElementId, Feature, LevelId, MapPlan } from "../contracts/plan";
import type { ResolvedPlan } from "../contracts/resolved";
import { featureInfo, rotatedSize } from "../gen/catalog";
import type { PlanRules } from "../ops/apply";
import type { ResolvePalettes } from "../palette/resolve";
import type { PlanCheck } from "../plan/validate";
import { resolvePlan } from "./resolvePlan";
import { geometryChecks } from "./validate";
import { sizeLimits, type SizeTierId } from "../plan/sizeTiers";
import { canonicalJson } from "../util/canonical";

export const GEOMETRY_CHECK_NAME = "wp2-geometry";

/**
 * Features a scatter/dress op generates (resolved against `palettes`), as plan features (ids "<opId>#<n>"; applyOps
 * renames them). `size` is given before rotation and only when it differs from the catalog default.
 */
export function materializeOp(
  plan: MapPlan,
  levelId: LevelId,
  opId: ElementId,
  palettes: ResolvePalettes,
): { ok: true; features: Feature[] } | { ok: false; message: string } {
  const level = plan.levels.find((l) => l.id === levelId);
  const op = level?.terrain.find((t) => t.id === opId);
  if (!level || !op) return { ok: false, message: `no terrain op "${opId}" on level "${levelId}"` };
  if (op.op !== "scatter" && op.op !== "dress")
    return { ok: false, message: `"${opId}" is a ${op.op} op; only scatter and dress generate features` };
  const resolved = resolvePlan(plan, palettes, { levels: [levelId] });
  const rl = resolved.levels.find((l) => l.id === levelId);
  if (!rl) return { ok: false, message: `level "${levelId}" did not resolve` };
  const features: Feature[] = rl.features
    .filter((f) => f.generatedBy === opId)
    .map((f) => {
      const out: Feature = { id: f.id, type: f.type, at: [f.at[0], f.at[1]] };
      if (f.rot !== 0) out.rot = f.rot;
      const base = rotatedSize(f.size, f.rot);
      const def = featureInfo(f.type).size;
      if (base[0] !== def[0] || base[1] !== def[1]) out.size = base;
      if (f.wall !== undefined) out.wall = f.wall;
      if (f.variant !== undefined) out.variant = f.variant;
      return out;
    });
  return { ok: true, features };
}

/**
 * A caller's own resolve of a plan, for the checks to reuse instead of resolving the plan again: `resolved` is
 * `resolvePlan(plan, palettes)` with every level. It is reused only for a plan of the same content (validatePlan
 * hands its checks the schema's parsed copy, never the object passed in, so the match is by canonical JSON: same
 * levels, areas, seed, generator, everything a resolve reads) and only when `palettes` is the very palettes object the
 * rules are built with; anything else is resolved again, so a stale resolve is never taken.
 */
export interface ResolvedReuse {
  readonly plan: MapPlan;
  readonly palettes: ResolvePalettes;
  readonly resolved: ResolvedPlan;
}

/** `reuse.resolved` for a plan of `reuse.plan`'s content resolved against `palettes`; undefined for anything else. */
export function reusedResolve(
  palettes: ResolvePalettes,
  reuse: ResolvedReuse,
): (plan: MapPlan) => ResolvedPlan | undefined {
  const usable =
    reuse.palettes === palettes &&
    reuse.resolved.planId === reuse.plan.id &&
    reuse.resolved.generator === reuse.plan.generator &&
    // a resolve of every level (resolvePlan's `levels` option leaves some out)
    reuse.resolved.levels.length === reuse.plan.levels.length;
  let key: string | undefined;
  return (plan) => {
    if (!usable) return undefined;
    if (plan === reuse.plan) return reuse.resolved;
    key ??= canonicalJson(reuse.plan);
    return canonicalJson(plan) === key ? reuse.resolved : undefined;
  };
}

/**
 * The resolver's geometry and playability check, on the plan resolved against `palettes`; `resolvedFor` gives the
 * caller's own resolve of the plan the check is handed, when it has one.
 */
export function geometryCheck(
  palettes: ResolvePalettes,
  resolvedFor?: (plan: MapPlan) => ResolvedPlan | undefined,
): PlanCheck {
  return {
    name: GEOMETRY_CHECK_NAME,
    run: (plan) => {
      const resolved = resolvedFor?.(plan);
      return geometryChecks(plan, palettes, resolved ? { resolved } : {});
    },
  };
}

/**
 * The full rules for plans built with `palettes`: what validatePlan checks (`validatePlan(plan, planRules(p))`) and
 * what applyOps checks and materializes with (`applyOps(plan, ops, planRules(p))`). Cheap to build; a caller whose
 * palettes change (the app: user palettes, the game's assets) builds them from its current palettes at each call.
 * `sizeTier`: the map size setting plans are held to (plan/sizeTiers.ts; standard when absent).
 * `resolved`: the caller's own `resolvePlan(plan, palettes)` of a plan, so validation does not resolve the same plan a
 * second time (a large map spends half an edit resolving); core matches it to the plan it checks (ResolvedReuse).
 * `resolvedFor`: the same as a callback the caller matches itself (it is handed the schema's parsed copy of the plan,
 * so a match by identity never succeeds); `resolved` is asked first. Neither, or no match: resolve here.
 */
export function planRules(
  palettes: ResolvePalettes,
  opts: {
    sizeTier?: SizeTierId;
    resolved?: ResolvedReuse;
    resolvedFor?: (plan: MapPlan) => ResolvedPlan | undefined;
  } = {},
): PlanRules {
  const reused = opts.resolved !== undefined ? reusedResolve(palettes, opts.resolved) : undefined;
  const { resolvedFor } = opts;
  const lookup =
    reused !== undefined && resolvedFor !== undefined
      ? (plan: MapPlan) => reused(plan) ?? resolvedFor(plan)
      : (reused ?? resolvedFor);
  return {
    checks: [geometryCheck(palettes, lookup)],
    materialize: (plan, levelId, opId) => materializeOp(plan, levelId, opId, palettes),
    ...(opts.sizeTier !== undefined ? { limits: sizeLimits(opts.sizeTier) } : {}),
  };
}
