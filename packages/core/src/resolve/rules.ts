/**
 * The plan rules that need the resolver: the geometric and playability check validatePlan runs after its structural
 * ones, and the generator behind the `materialize` op. Plan and ops sit below the resolver and cannot import it, so
 * they take these as an argument (`ValidateContext.checks`, ops' `PlanRules`); this module builds them for the
 * palettes a plan is built with. Every caller passes them explicitly: no process-wide registration, so validatePlan
 * and applyOps give the same answer whoever imported what.
 */
import type { ElementId, Feature, LevelId, MapPlan } from "../contracts/plan";
import { featureInfo, rotatedSize } from "../gen/catalog";
import type { PlanRules } from "../ops/apply";
import type { ResolvePalettes } from "../palette/resolve";
import type { PlanCheck } from "../plan/validate";
import { resolvePlan } from "./resolvePlan";
import { geometryChecks } from "./validate";

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

/** The resolver's geometry and playability check, on the plan resolved against `palettes`. */
export function geometryCheck(palettes: ResolvePalettes): PlanCheck {
  return { name: GEOMETRY_CHECK_NAME, run: (plan) => geometryChecks(plan, palettes) };
}

/**
 * The full rules for plans built with `palettes`: what validatePlan checks (`validatePlan(plan, planRules(p))`) and
 * what applyOps checks and materializes with (`applyOps(plan, ops, planRules(p))`). Cheap to build; a caller whose
 * palettes change (the app: user palettes, the game's assets) builds them from its current palettes at each call.
 */
export function planRules(palettes: ResolvePalettes): PlanRules {
  return {
    checks: [geometryCheck(palettes)],
    materialize: (plan, levelId, opId) => materializeOp(plan, levelId, opId, palettes),
  };
}
