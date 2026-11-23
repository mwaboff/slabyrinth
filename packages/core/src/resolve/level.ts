/**
 * Per-level resolution (architecture §2.4, normative order):
 *   1 base · 2 terrain "under" · 3 areas (routes last) · 4 terrain "over" · 5 edges + wall runs · 6 openings
 *   [7 links: done across levels by resolvePlan] · 8 explicit features · 9 generated features · 10 derived data ·
 *   11 detail recipes (generator 5: over the finished level, within its share of the map's detail budget).
 *
 * This file is the order and the wiring: each stage lives in resolve/level/ and gets the level's grid (`work`,
 * resolve/level/grid.ts) plus exactly the records it uses. A stage's signature takes a record it owns as is and one it
 * only reads as `ReadOnly<...>`, so a call below and the signature it reaches say what the stage reads and writes
 * (ownership table: resolve/level/state.ts).
 * resolvePlan drives a plan through it:
 *   new ResolveLevelState(ctx) per level → runPhase1 (steps 1–6) per level → links between levels and
 *   linkFloorOpenings (resolve/level/floorOpenings.ts) → runPhase2 (steps 8–9) per level → toResolved
 *   (resolve/level/output.ts, step 10 and the ResolvedLevel contract shape) → the detail budgets of every level
 *   (resolve/recipes/budget.ts) → runDetail (step 11) per level.
 * The structure hooks (resolve/structure.ts `StructureWork`) run between stages, where buildings need the level's
 * cells as they stand at that point. This file is a plain list: a stage that only runs for some generators (or only
 * when the level asks for it) checks its own switch on its first line and names it in its doc comment.
 */
import { checkAreaFields, stepAreas, stepBase } from "./level/areas";
import { stepBridgeRubble, stepBridges, stepRailings } from "./level/bridges";
import { stepCaveOutlines, stepCaveRelief } from "./level/caves";
import type { ResolvedLevel } from "../contracts/resolved";
import { stepDeadEnds } from "./level/deadEnds";
import { stepDetailRecipes } from "./level/detail";
import { stepGeneratedFeatures } from "./level/dressing";
import { stepEdges, stepStairs, stepWallRuns } from "./level/edges";
import { stepExplicitFeatures } from "./level/features";
import { stepOpeningRimDebris, stepOpeningRims, stepOpeningRubble } from "./level/floorOpenings";
import { stepMarket } from "./level/market";
import { stepOpenings } from "./level/openings";
import { stepKerbs, stepPavementFronts, stepRoads } from "./level/paths";
import { stepRoomFloors, stepRoomRecipes, stepWallFootRubble } from "./level/rooms";
import type { ResolveLevelState } from "./level/state";
import { checkUnderSurvivors, stepOutline, stepTerrain } from "./level/terrain";

/** Steps 1–6: the level's cells, terrain, edges and openings, before the links between levels. */
export function runPhase1(s: ResolveLevelState): void {
  const work = s.grid;
  const terrain = { chasms: s.chasms, relief: s.relief, floorOpenings: s.floorOpenings, paths: s.paths };
  stepBase(work);
  const under = stepTerrain(work, "under", terrain);
  const routes = stepAreas(work);
  stepCaveOutlines(work);
  work.structs?.afterAreas(work);
  checkUnderSurvivors(work, under);
  stepTerrain(work, "over", terrain);
  work.structs?.afterTerrain(work);
  stepCaveRelief(work);
  stepPavementFronts(work, s.paths);
  stepOutline(work, s.paths);
  stepBridges(work, s.bridges, s.chasms);
  stepRoomFloors(work);
  stepEdges(work, s.bridges);
  stepStairs(work);
  stepRailings(work, s.bridges);
  stepRoads(work, s.paths);
  stepKerbs(work, s.paths);
  stepWallRuns(work);
  stepOpenings(work, routes, s.openings);
  stepOpeningRims(work, s.floorOpenings);
  work.structs?.afterOpenings(work);
  checkAreaFields(work);
}

/** Steps 8–9: the plan's features, then everything generated, once the links and floor openings are known. */
export function runPhase2(s: ResolveLevelState): void {
  const work = s.grid;
  const features = s.features;
  stepExplicitFeatures(work, features, s.paths);
  stepMarket(work, features, s.lines, s.paths, s.openings);
  stepBridgeRubble(work, features, s.bridges);
  stepOpeningRubble(work, features, s.floorOpenings);
  stepOpeningRimDebris(work, features, s.floorOpenings);
  // rooms are dressed before the loose rubble and the scatters, so those fill what the furniture leaves and never
  // take a wall run from it
  stepRoomRecipes(work, features);
  stepDeadEnds(work, features, s.openings);
  stepWallFootRubble(work, features, s.floorOpenings, s.openings);
  stepGeneratedFeatures(work, features);
}

/** Step 11: detail recipes over the finished level, within its share of the detail budget. */
export function runDetail(s: ResolveLevelState, level: ResolvedLevel, budget: number): void {
  stepDetailRecipes(s.grid, level, s.arrangements, budget);
}
