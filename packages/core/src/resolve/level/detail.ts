/**
 * Step 11 (generator 5, the detail recipe switches): detail recipes over the finished level. The level is read as it
 * will be built (its walls, hosts, buildings, features), its anchors derived from it (resolve/anchors/), and every
 * enabled recipe instanced by the engine (resolve/recipes/engine.ts) within the level's share of the detail budget.
 * Reads: the finished ResolvedLevel, the generator switches, the plan seed and the palette view. Writes: the level's
 * arrangement records (the attach), and `ResolvedLevel.arrangements` from them.
 */
import type { ResolvedLevel } from "../../contracts/resolved";
import { runRecipes } from "../recipes/engine";
import type { ArrangementRecords } from "./arrangements";
import type { ResolveGrid } from "./grid";

export function stepDetailRecipes(
  work: Readonly<ResolveGrid>,
  level: ResolvedLevel,
  records: ArrangementRecords,
  budget: number,
): void {
  if (!work.profile.arrangements) return;
  runRecipes(level, records, {
    planSeed: work.plan.seed,
    profile: work.profile,
    palette: work.ctx.palette,
    budget,
  });
  if (records.all.length > 0) level.arrangements = records.all;
}
