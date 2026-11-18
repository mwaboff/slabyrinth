/**
 * Plugs WP2 into WP1's hooks: the geometric validation pass (registerPlanCheck) and the `materialize` op
 * generator (registerMaterializer). Called once when the resolve module is loaded; idempotent (re-registering
 * replaces the previous registration).
 */
import type { ElementId, Feature, LevelId, MapPlan } from "../contracts/plan";
import { featureInfo, rotatedSize } from "../gen/catalog";
import { registerMaterializer } from "../ops/apply";
import { registerPlanCheck } from "../plan/validate";
import { resolvePlan } from "./resolvePlan";
import { geometryChecks } from "./validate";

export const GEOMETRY_CHECK_NAME = "wp2-geometry";

/**
 * Features a scatter/dress op generates, as plan features (ids "<opId>#<n>"; applyOps renames them).
 * `size` is given before rotation and only when it differs from the catalog default.
 */
export function materializeOp(
  plan: MapPlan,
  levelId: LevelId,
  opId: ElementId,
): { ok: true; features: Feature[] } | { ok: false; message: string } {
  const level = plan.levels.find((l) => l.id === levelId);
  const op = level?.terrain.find((t) => t.id === opId);
  if (!level || !op) return { ok: false, message: `no terrain op "${opId}" on level "${levelId}"` };
  if (op.op !== "scatter" && op.op !== "dress")
    return { ok: false, message: `"${opId}" is a ${op.op} op; only scatter and dress generate features` };
  const resolved = resolvePlan(plan, { levels: [levelId] });
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

/** Registers the WP2 plan check and materializer. Returns a function that unregisters both. */
export function registerWp2Hooks(): () => void {
  const a = registerPlanCheck({ name: GEOMETRY_CHECK_NAME, run: (plan) => geometryChecks(plan) });
  const b = registerMaterializer(materializeOp);
  return () => {
    a();
    b();
  };
}
