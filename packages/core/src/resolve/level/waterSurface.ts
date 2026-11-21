/**
 * The level's water surface: where TaleSpire's one board-wide water plane should sit. Asked by the placement grid
 * (dressing sinks stones to it, without reporting) and by the output (with the plan issues).
 * Reads: water cells and the dry floor round them, the upper reaches and falls of stepped rivers.
 * Writes: `waterRange` (the range a stepped river allows) and, when reporting, `water_level` plan issues.
 */
import { CELL_FLAG } from "../../contracts/resolved";
import type { LevelWork } from "./work";

/** True when a water cell lies within `r` cells (Chebyshev) of cell `i`. */
function nearWater(work: LevelWork, i: number, r: number): boolean {
  const [x, y] = work.cellXY(i);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const j = work.idx(x + dx, y + dy);
      if (j >= 0 && ((work.flags[j] as number) & CELL_FLAG.WATER) !== 0) return true;
    }
  return false;
}

/**
 * The level's water surface (absolute tiles), for TaleSpire's board-wide water plane: half a tile below the
 * lowest dry floor that touches water, but at least a quarter tile above the highest water bed. Warns when other dry
 * walkable floor (a dry pit, a lava rift, a cellar) lies below it, since the plane would flood it.
 */
export function waterSurface(work: LevelWork, report = true): number | null {
  const water: number[] = [];
  // the upper reaches of a stepped river lie above the board plane: they do not set it
  for (let i = 0; i < work.n; i++)
    if (work.isFloor(i) && (work.flags[i] as number) & CELL_FLAG.WATER && !work.upperReach.has(i))
      water.push(i);
  if (water.length === 0) return null;
  const top = (i: number): number => work.level.elevation + (work.height[i] as number) / 4 + 0.5;
  let bank = Infinity;
  let bed = -Infinity;
  for (const i of water) {
    bed = Math.max(bed, top(i));
    for (const j of work.neighbours4(i))
      if (j >= 0 && work.isFloor(j) && ((work.flags[j] as number) & CELL_FLAG.WATER) === 0)
        bank = Math.min(bank, top(j));
  }
  if (work.falls.length > 0) {
    const lo = bed + 0.25;
    work.waterRange = [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
  }
  // aim half a tile below the lowest bank (room for an imprecise setting either way), never below the beds
  const surface = Number.isFinite(bank) ? Math.max(bed + 0.25, bank - 0.5) : bed + 0.25;
  let low: number | null = null;
  let lowCount = 0;
  const checks = work.gen.waterLevelChecks;
  for (let i = 0; i < work.n; i++) {
    if (!work.isFloor(i) || (work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) continue;
    if (top(i) < surface) {
      // generator 3: a trail cell on a channel's bed beside water is a ford; it is meant to be wet
      if (checks && ((work.flags[i] as number) & CELL_FLAG.PATH) !== 0 && nearWater(work, i, 2)) continue;
      lowCount++;
      low ??= i;
    }
  }
  // generator 3: water cells above the plane stay dry in game (the upper reaches of a stepped river): the slab cannot
  // carry a second water level and the palettes have no piece that reads as water, so say so
  if (checks) {
    let dry = 0;
    let first: number | null = null;
    for (const i of work.upperReach) {
      if (
        work.isFloor(i) &&
        ((work.flags[i] as number) & CELL_FLAG.WATER) !== 0 &&
        top(i) >= surface + 0.25 - 1e-6
      ) {
        dry++;
        first ??= i;
      }
    }
    if (report && dry > 0 && first !== null) {
      const [x, y] = work.cellXY(first);
      work.issue(
        "warning",
        "water_level",
        `${dry} water cell${dry > 1 ? "s lie" : " lies"} above the level's water surface (${surface} tiles) and will stay dry in game: TaleSpire has one flat water plane and the palettes have no piece that reads as water, so the upper reaches of a stepped river are dry beds`,
        {
          elementId: work.level.id,
          cell: [x, y],
          hint: "keep a river on one level, on the low ground or in a cut, with terraces beside it; step it only if dry upper reaches suit the scene",
        },
      );
    }
  }
  if (report && low !== null) {
    const [x, y] = work.cellXY(low);
    work.issue(
      "warning",
      "water_level",
      `${lowCount} dry floor cell${lowCount > 1 ? "s lie" : " lies"} below this level's water surface (${surface} tiles): TaleSpire's water plane is one height for the whole board and would flood ${lowCount > 1 ? "them" : "it"}`,
      {
        elementId: work.level.id,
        cell: [x, y],
        hint: "keep water and floor that must stay dry apart in height (raise the dry part, or lower the water's channel), or make that floor water too",
      },
    );
  }
  return surface;
}
