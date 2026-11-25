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
 * The level's wall faces (`RealizeLevel.faces`, resolve/wallFaces.ts: every wall and opening edge with its host, the
 * cell its mass stands in, style, theme and span) are found once per level and read by planSolidShell and layWalls
 * (whose rock columns stand in the mass cells). They, the level grids and the role answers (`lookup`) are the build's
 * facts (compile/buildFacts.ts), which the realized set carries (`RealizedSet.facts`): verify judges by the same ones.
 *
 * A pass that only runs for some generators checks its own switch on its first line and names it in its doc comment,
 * so this file stays a plain list.
 */
import type { PaletteCatalog } from "../contracts/compiler";
import type { ResolvedPlan } from "../contracts/resolved";
import { emptyBox } from "./geometry";
import { layArrangements } from "./realize/arrangements";
import { CliffTones, planRockBand } from "./realize/cliffBand";
import { createRealizeCtx, type RealizeOptions } from "./realize/context";
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
import { settleOnSupports } from "./realize/settle";
import { layShellCap, planSolidShell } from "./realize/solidShell";
import { layStructures } from "./realize/structures";
import { layCornerPosts, layWalls } from "./realize/walls";

/** The plan's placements, with what realize knows about each of them on the set (`placed`: name, geometry, box). */
export function realize(
  resolved: ResolvedPlan,
  palettes: PaletteCatalog,
  opts: RealizeOptions = {},
): RealizedSet {
  const ctx = createRealizeCtx(resolved, palettes, opts);
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

    // links between levels, features, outcrop dressing, buildings, arrangement instances
    layLinks(lv);
    layFeatures(lv, tones);
    dressOutcrops(lv);
    layStructures(lv);
    layArrangements(lv);
    // things set on furniture, once every support stands with its final variant and turn
    settleOnSupports(lv);

    finishLevel(lv, out);
  }

  return finishRealize(ctx, out);
}
