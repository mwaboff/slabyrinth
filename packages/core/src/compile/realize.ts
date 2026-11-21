/**
 * Realize: ResolvedPlan + palettes + orientation → PlacementSet (architecture §4.3). World space: x east, y up,
 * z north, tiles. Never throws for bad content; problems become aggregated diagnostics.
 *
 * This file is the order of the passes. The passes live in compile/realize/: each takes one level's state
 * (`LevelWork`, realize/work.ts) with the plan-wide context on it (`RealizeCtx`, realize/context.ts), and its header
 * says what it reads and writes. A pass may rely on everything an earlier pass left on the level state.
 */
import type { Box3, PaletteCatalog, Placement } from "../contracts/compiler";
import type { ResolvedPlan } from "../contracts/resolved";
import { emptyBox } from "./geometry";
import { planRockBand } from "./realize/cliffBand";
import { createRealizeCtx, type PlacementMeta, type RealizeOptions } from "./realize/context";
import { dressOutcrops, layFeatures } from "./realize/features";
import { layPiers, layRaisedFill } from "./realize/fill";
import { layFloors, layGroundUnderDecks, layLiquidGlow, layRoadMarkings, layWaterBeds } from "./realize/floors";
import { layKerbs } from "./realize/kerbs";
import { layLinks, layStairEdges } from "./realize/links";
import { layOpenings } from "./realize/openings";
import { finishLevel, finishRealize, type RealizedSet, type RealizeOutput } from "./realize/output";
import { layRockWalls } from "./realize/rockWalls";
import { layShellCap, planSolidShell } from "./realize/solidShell";
import { layStructures } from "./realize/structures";
import { layCornerPosts, layWalls } from "./realize/walls";
import { LevelWork } from "./realize/work";

/** World AABB of every placement made by realize (keyed by object; used by chunking for exact bounds). */
export const placementBoxes = new WeakMap<Placement, Box3>();

/** Asset name and geometry of every placement made by realize (used by the verify stage). */
export const placementMeta = new WeakMap<Placement, PlacementMeta>();

export function realize(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: RealizeOptions = {},
): RealizedSet {
  const ctx = createRealizeCtx(resolved, palettes, opts, { placementBoxes, placementMeta });
  const levelsWanted = opts.levels ? new Set(opts.levels) : null;
  const out: RealizeOutput = { levels: [], levelInfo: [], allBox: emptyBox() };

  for (const L of resolved.levels) {
    if (levelsWanted && !levelsWanted.has(L.id)) continue;
    const w = new LevelWork(ctx, L);

    // ground: what the rock band changes, then floors, beds and what stands under raised floors
    planRockBand(w);
    layFloors(w);
    layRoadMarkings(w);
    layWaterBeds(w);
    layGroundUnderDecks(w);
    layRaisedFill(w);
    layPiers(w);
    layLiquidGlow(w);

    // walls: the shell plan joins its skirt to the wall runs; columns and rock mass after the runs gathered them
    planSolidShell(w);
    layWalls(w);
    layShellCap(w);
    layRockWalls(w);
    layKerbs(w);
    layStairEdges(w);
    layOpenings(w);
    // after the walls and openings, whose strips meet at the posts
    layCornerPosts(w);

    // links between levels, features, outcrop dressing, buildings
    layLinks(w);
    layFeatures(w);
    dressOutcrops(w);
    layStructures(w);

    finishLevel(w, out);
  }

  return finishRealize(ctx, out);
}
