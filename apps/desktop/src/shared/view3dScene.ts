/**
 * The 3D scene of a plan: resolve, realize (the build's own placements) and the scene builder, over palettes and a mesh
 * source the caller gives. Pure: main's scene worker runs it with the build's palettes and the piece cache; the
 * renderer's fake bridge with the bundled palettes and boxes.
 */
import type {
  AssetCatalog,
  MapPlan,
  OrientationCalibration,
  PaletteCatalog,
  ResolvedPlan,
} from "@slabyrinth/core";
import { realize } from "@slabyrinth/core/compile";
import { resolvePlan } from "@slabyrinth/core/resolve";
import { pieceLookup, sceneFromBuild, type MeshSource, type Scene } from "@slabyrinth/scene3d";

export interface PlanScene {
  scene: Scene;
  resolved: ResolvedPlan;
}

export async function sceneOfPlan(
  plan: MapPlan,
  palettes: PaletteCatalog,
  catalog: AssetCatalog | null,
  source: MeshSource,
  orientation?: OrientationCalibration,
  /** Between the stages (the worker reports layout progress and checks for a cancel here). */
  step?: (done: number, total: number) => void,
): Promise<PlanScene> {
  step?.(0, 3);
  const resolved = resolvePlan(plan, palettes);
  step?.(1, 3);
  const set = realize(resolved, palettes, orientation ? { orientation } : {});
  step?.(2, 3);
  const scene = await sceneFromBuild(resolved, set, pieceLookup(palettes.palettes, catalog), source);
  step?.(3, 3);
  return { scene, resolved };
}
