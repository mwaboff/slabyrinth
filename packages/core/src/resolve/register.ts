/**
 * Plugs WP2 into WP1's hooks: the geometric validation pass (registerPlanCheck) and the `materialize` op
 * generator (registerMaterializer). Both resolve the plan, so they are registered with the palettes the process
 * builds with: `validatePlan` and `applyOps` then see the map the build produces. Re-registering replaces the
 * previous registration.
 */
import type { ElementId, Feature, LevelId, MapPlan } from "../contracts/plan";
import { featureInfo, rotatedSize } from "../gen/catalog";
import { registerMaterializer } from "../ops/apply";
import type { ResolvePalettes } from "../palette/resolve";
import { registerPlanCheck } from "../plan/validate";
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

/**
 * Registers the WP2 plan check and materializer for this process. `palettes` returns the palettes the process
 * builds with, asked at each check (they change when the user's palettes or the game's assets do); core's index
 * registers `bundledPalettes`, and the app registers its build palettes. A validation that names its own palettes
 * (`ValidateContext.palettes`) checks against those. Returns a function that unregisters both.
 */
export function registerWp2Hooks(palettes: () => ResolvePalettes): () => void {
  const a = registerPlanCheck({
    name: GEOMETRY_CHECK_NAME,
    run: (plan, ctx) => geometryChecks(plan, ctx.palettes ?? palettes()),
  });
  const b = registerMaterializer((plan, levelId, opId) => materializeOp(plan, levelId, opId, palettes()));
  return () => {
    a();
    b();
  };
}
