/**
 * Realize: ResolvedPlan + palettes + orientation → PlacementSet (architecture §4.3). World space: x east, y up,
 * z north, tiles. Never throws for bad content; problems become aggregated diagnostics.
 *
 * This file is the order and the wiring of the passes, which live in compile/realize/. Every pass gets the level
 * (`RealizeLevel`, realize/level.ts: the resolved level read through its view, the facts derived from it once, and
 * `emit`, the one way to place an asset) with the plan-wide context on it (`RealizeCtx`, realize/context.ts), plus
 * exactly the records it uses. A record is written by one owner and handed to the passes after it read-only (its type
 * is a readonly view); a record used by one later pass is returned and passed on, never parked on the level:
 *
 *   record              owner (writes)                         read by
 *   RockBand            cliffBand.ts planRockBand              layFloors (low ground laid as rock), layRaisedFill
 *   CliffTones          cliffBand.ts (memo of tone lookups)    planRockBand, layFeatures
 *   WaterCells          floors.ts layFloors                    layWaterBeds
 *   GroundUnderDecks    floors.ts layGroundUnderDecks          layRaisedFill
 *   SolidShellPlan      solidShell.ts planSolidShell           layWalls (skirt edges), layShellCap, layRockWalls
 *   CornerStrips        edges.ts (layWalls, layOpenings add)   layCornerPosts
 *   FullCellColumns     walls.ts layWalls                      layRockWalls
 *
 * A pass that only runs for some generators checks its own switch on its first line and names it in its doc comment,
 * so this file stays a plain list.
 */
import type { Box3, PaletteCatalog, Placement } from "../contracts/compiler";
import type { ResolvedPlan } from "../contracts/resolved";
import { emptyBox } from "./geometry";
import { CliffTones, planRockBand } from "./realize/cliffBand";
import { createRealizeCtx, type PlacementMeta, type RealizeOptions } from "./realize/context";
import { CornerStrips } from "./realize/edges";
import { dressOutcrops, layFeatures } from "./realize/features";
import { layPiers, layRaisedFill } from "./realize/fill";
import {
  layFloors,
  layGroundUnderDecks,
  layLiquidGlow,
  layRoadMarkings,
  layWaterBeds,
} from "./realize/floors";
import { layKerbs } from "./realize/kerbs";
import { RealizeLevel } from "./realize/level";
import { layLinks, layStairEdges } from "./realize/links";
import { layOpenings } from "./realize/openings";
import { finishLevel, finishRealize, type RealizedSet, type RealizeOutput } from "./realize/output";
import { layRockWalls } from "./realize/rockWalls";
import { layShellCap, planSolidShell } from "./realize/solidShell";
import { layStructures } from "./realize/structures";
import { layCornerPosts, layWalls } from "./realize/walls";

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
    const lv = new RealizeLevel(ctx, L);
    const tones = new CliffTones(lv);

    // ground: what the rock band changes, then floors, beds and what stands under raised floors
    const band = planRockBand(lv, tones);
    const waterCells = layFloors(lv, band);
    layRoadMarkings(lv);
    layWaterBeds(lv, waterCells);
    const groundUnder = layGroundUnderDecks(lv);
    layRaisedFill(lv, band, groundUnder);
    layPiers(lv);
    layLiquidGlow(lv);

    // walls: the shell plan joins its skirt to the wall runs; columns and rock mass after the runs gathered them
    const shell = planSolidShell(lv);
    const strips = new CornerStrips();
    const fullCells = layWalls(lv, shell, strips);
    layShellCap(lv, shell);
    layRockWalls(lv, fullCells, shell);
    layKerbs(lv);
    layStairEdges(lv);
    layOpenings(lv, strips);
    // after the walls and openings, whose strips meet at the posts
    layCornerPosts(lv, strips);

    // links between levels, features, outcrop dressing, buildings
    layLinks(lv);
    layFeatures(lv, tones);
    dressOutcrops(lv);
    layStructures(lv);

    finishLevel(lv, out);
  }

  return finishRealize(ctx, out);
}
