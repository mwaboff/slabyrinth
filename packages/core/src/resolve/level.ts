/**
 * Per-level resolution (architecture §2.4, normative order):
 *   1 base · 2 terrain "under" · 3 areas (routes last) · 4 terrain "over" · 5 edges + wall runs · 6 openings
 *   [7 links: done across levels by resolvePlan] · 8 explicit features · 9 generated features · 10 derived data.
 *
 * This file is the order; each stage lives in resolve/level/ and works on the level's working state
 * (resolve/level/work.ts `LevelWork`: typed cell and edge arrays plus the records the stages fill).
 * resolvePlan drives a plan through it:
 *   new LevelWork(ctx) per level → runPhase1 (steps 1–6) per level → links between levels and
 *   linkOpenings (resolve/level/floorOpenings.ts) → runPhase2 (steps 8–9) per level → toResolved
 *   (resolve/level/output.ts, step 10 and the ResolvedLevel contract shape).
 * The structure hooks (resolve/structure.ts `StructureWork`) run between stages, where buildings need the level's
 * cells as they stand at that point.
 */
import { checkAreaFields, initAreas, stepAreas, stepBase } from "./level/areas";
import { stepBridgeRubble, stepBridges, stepRailings } from "./level/bridges";
import { stepCaveOutlines, stepCaveRelief } from "./level/caves";
import { stepGeneratedFeatures } from "./level/dressing";
import { stepEdges, stepStairs, stepWallRuns } from "./level/edges";
import { stepExplicitFeatures } from "./level/features";
import { stepOpeningRimDebris, stepOpeningRims, stepOpeningRubble } from "./level/floorOpenings";
import { stepMarket } from "./level/market";
import { stepOpenings } from "./level/openings";
import { stepKerbs, stepPavementFronts, stepRoads } from "./level/paths";
import { stepRoomFloors, stepRoomRecipes, stepWallFootRubble } from "./level/rooms";
import { checkUnderSurvivors, stepOutline, stepTerrain } from "./level/terrain";
import type { LevelWork } from "./level/work";

/** Steps 1–6: the level's cells, terrain, edges and openings, before the links between levels. */
export function runPhase1(work: LevelWork): void {
  initAreas(work);
  stepBase(work);
  stepTerrain(work, "under");
  stepAreas(work);
  if (work.gen.caveOutlines) stepCaveOutlines(work);
  work.structs?.afterAreas(work);
  checkUnderSurvivors(work);
  stepTerrain(work, "over");
  work.structs?.afterTerrain(work);
  if (work.gen.caveRelief) stepCaveRelief(work);
  stepPavementFronts(work);
  stepOutline(work);
  stepBridges(work);
  if (work.gen.roomFloors) stepRoomFloors(work);
  stepEdges(work);
  stepStairs(work);
  stepRailings(work);
  stepRoads(work);
  stepKerbs(work);
  stepWallRuns(work);
  stepOpenings(work);
  stepOpeningRims(work);
  work.structs?.afterOpenings(work);
  checkAreaFields(work);
}

/** Steps 8–9: the plan's features, then everything generated, once the links and floor openings are known. */
export function runPhase2(work: LevelWork): void {
  stepExplicitFeatures(work);
  stepMarket(work);
  stepBridgeRubble(work);
  stepOpeningRubble(work);
  stepOpeningRimDebris(work);
  // generator 4: rooms the plan left bare are dressed from their purpose, and every room is lit. Before the loose
  // rubble and the scatters, so those fill what the furniture leaves and never take a wall run from it.
  if (work.gen.roomRecipes && work.level.roomDress !== false) stepRoomRecipes(work);
  stepWallFootRubble(work);
  stepGeneratedFeatures(work);
}
