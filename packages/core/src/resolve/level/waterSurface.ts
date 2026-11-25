/**
 * The level's water surface: where TaleSpire's one board-wide water plane should sit. Asked by the placement grid
 * (dressing sinks stones to it, without reporting) and by the output (with the plan issues).
 * Reads: water cells and the dry floor round them, the upper reaches and falls of stepped rivers (ChasmRecords).
 * Returns the surface and the range a stepped river allows; writes nothing but, when reporting, `water_level` issues.
 */
import type { PlanIssue, Vec2 } from "../../contracts/plan";
import { CELL, CELL_FLAG, type ResolvedLevel } from "../../contracts/resolved";
import type { ChasmRecords } from "./chasms";
import type { ReadOnly, ResolveGrid } from "./grid";

/** Where the board's water plane should sit (absolute tiles). */
export interface WaterSurface {
  level: number;
  /** Generator 3, a level with falls: the lowest and highest settings that keep every reach right (or null). */
  range: [number, number] | null;
}

/** True when a water cell lies within `r` cells (Chebyshev) of cell `i`. */
function nearWater(work: ResolveGrid, i: number, r: number): boolean {
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
export function waterSurface(
  work: ResolveGrid,
  rivers: ReadOnly<ChasmRecords>,
  report = true,
): WaterSurface | null {
  const water: number[] = [];
  // the upper reaches of a stepped river lie above the board plane: they do not set it
  for (let i = 0; i < work.n; i++)
    if (work.isFloor(i) && (work.flags[i] as number) & CELL_FLAG.WATER && !rivers.upperReach.has(i))
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
  let range: [number, number] | null = null;
  if (rivers.falls.length > 0) {
    const lo = bed + 0.25;
    range = [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
  }
  // aim half a tile below the lowest bank (room for an imprecise setting either way), never below the beds
  const surface = Number.isFinite(bank) ? Math.max(bed + 0.25, bank - 0.5) : bed + 0.25;
  let low: number | null = null;
  let lowCount = 0;
  const checks = work.profile.waterLevelChecks;
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
    for (const i of rivers.upperReach) {
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
  return { level: surface, range };
}

/**
 * Water surface range of a resolved level (absolute tiles): a quarter tile above its highest water bed to a quarter
 * below its lowest dry bank on the same level. The compiler's water advice reads it where the level records none.
 */
export function waterRangeOf(L: ResolvedLevel): [number, number] {
  const { w, h } = L.bounds;
  const top = (i: number): number => L.elevation + (L.cells.height[i] ?? 0) / 4 + 0.5;
  const floor = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0;
  const wet = (i: number): boolean => ((L.cells.flags[i] ?? 0) & CELL_FLAG.WATER) !== 0;
  let bed = -Infinity;
  let bank = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (!floor(i) || !wet(i)) continue;
    bed = Math.max(bed, top(i));
    const x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
      if (j >= 0 && j < w * h && floor(j) && !wet(j)) bank = Math.min(bank, top(j));
  }
  const lo = bed + 0.25;
  return [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
}

/**
 * Generator 5 (switch `waterUnderFloors`): TaleSpire's water plane floods every floor under it, on any level. A level's
 * water surface and range are lowered to a quarter tile under the lowest dry floor of another level standing inside the
 * footprint of its water areas (a ship's hold in the harbour, a cellar under a moat); when even the lowest setting its
 * channels need would flood that floor, a `water_level` warning says which floor and how to fix it.
 */
export function capWaterUnderOtherFloors(levels: ResolvedLevel[], issues: PlanIssue[]): void {
  for (const L of levels) {
    if (L.waterLevel === undefined) continue;
    const W = L.bounds.w;
    const n = L.cells.state.length;
    // the water's footprint: its cells, and the floorless open cells joined to them (a berth cut in the sea for a
    // hull, a hole in a moat): what stands under those is in the water
    const inFoot = new Uint8Array(n);
    const queue: number[] = [];
    for (let i = 0; i < n; i++)
      if (((L.cells.flags[i] ?? 0) & CELL_FLAG.WATER) !== 0) {
        inFoot[i] = 1;
        queue.push(i);
      }
    const hole = (i: number): boolean =>
      L.cells.state[i] === CELL.OPEN && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) !== 0;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q] as number;
      const x = i % W;
      for (const j of [i - W, i + W, x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1])
        if (j >= 0 && j < n && inFoot[j] === 0 && hole(j)) {
          inFoot[j] = 1;
          queue.push(j);
        }
    }
    const foot: Vec2[] = [];
    for (let i = 0; i < n; i++)
      if (inFoot[i] === 1) foot.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
    let dry = Infinity;
    let at: { level: string; cell: Vec2 } | null = null;
    for (const M of levels) {
      if (M === L) continue;
      for (const [x, y] of foot) {
        const lx = x - M.bounds.x;
        const ly = y - M.bounds.y;
        if (lx < 0 || ly < 0 || lx >= M.bounds.w || ly >= M.bounds.h) continue;
        const i = ly * M.bounds.w + lx;
        const f = M.cells.flags[i] ?? 0;
        if (M.cells.state[i] !== CELL.OPEN || (f & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) !== 0) continue;
        const top = M.elevation + (M.cells.height[i] ?? 0) / 4 + 0.5;
        if (top < dry) {
          dry = top;
          at = { level: M.id, cell: [x, y] };
        }
      }
    }
    const range = L.waterRange ?? waterRangeOf(L);
    const cap = dry - 0.25;
    if (at === null || cap >= range[1]) continue;
    const hi = Math.max(range[0], cap);
    L.waterRange = [range[0], hi];
    L.waterLevel = Math.min(L.waterLevel, hi);
    if (cap < range[0])
      issues.push({
        severity: "warning",
        code: "water_level",
        levelId: L.id,
        elementId: at.level,
        cell: at.cell,
        message: `the floor of level ${at.level} at (${at.cell[0]},${at.cell[1]}) lies ${String(dry)} tiles up, inside the footprint of level ${L.id}'s water, below the lowest water surface its channels need (${String(range[0])}): TaleSpire's water plane is one height for the whole board and would flood it`,
        hint: `raise level ${at.level}'s floor there above ${String(range[0] + 0.25)}, or lower the bed of ${L.id}'s water, or keep that floor out of the water's footprint`,
      });
  }
}
