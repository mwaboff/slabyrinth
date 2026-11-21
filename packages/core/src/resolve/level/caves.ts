/**
 * Natural caves (generator 4): ragged chamber outlines right after the areas (step 3), and half-tile floor shelves
 * after the over-layer terrain (step 4).
 * Reads: the areas with natural rock walls, cell owners, state, heights and flags, and what the plan placed by hand
 * (features, openings, link ends, stairs runs, shaping terrain ops), which both passes leave as drawn.
 * Writes: the cells an outline opens (claimed for the area) or closes (back to rock), the owner counts, and the
 * heights of the shelf cells. The shape logic lives in resolve/caveOutline.ts and resolve/caveRelief.ts.
 */
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { forEachMaskCell } from "../../gen/mask";
import { rasterPolyline, rasterizeShape } from "../../gen/shapes";
import { isNaturalWallStyle } from "../../gen/wallStyles";
import { linkCellsOnLevel } from "../../plan/links";
import { elementSeed } from "../../util/hash";
import { raggedCaveOutline } from "../caveOutline";
import { CAVE_RELIEF, caveShelves } from "../caveRelief";
import type { AreaInfo, ResolveGrid } from "./grid";

/**
 * Generator 4: cells the natural cave passes (ragged outlines, floor shelves) must leave as the plan drew them:
 * explicit features, openings, link ends, stairs runs and the shapes of shaping terrain ops, each with a ring of
 * `ring` cells.
 */
function caveKeep(work: ResolveGrid, ring: number): Set<number> {
  const keep = new Set<number>();
  const addRing = (gx: number, gy: number, r: number): void => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const i = work.idx(gx + dx, gy + dy);
        if (i >= 0) keep.add(i);
      }
  };
  for (const ft of work.level.features)
    for (const c of work.footprint(ft.at, ft.size ?? [1, 1]).cells) {
      const [x, y] = work.cellXY(c);
      addRing(x, y, ring);
    }
  for (const o of work.level.openings) if (o.at) addRing(o.at.x, o.at.y, ring + 1);
  // the ends of a link, and every cell its run, stairwell and landing cover (plan/links.ts `linkGeometry`)
  for (const l of work.plan.links)
    for (const end of [l.from, l.to])
      if (end.level === work.level.id && end.at) addRing(end.at[0], end.at[1], ring + 1);
  for (const [x, y] of linkCellsOnLevel(work.plan, work.level.id)) addRing(x, y, ring);
  const clip = work.rasterClip();
  for (const op of work.level.terrain) {
    if (op.op === "stairs") {
      forEachMaskCell(rasterPolyline([op.from, op.to], 1, clip), (x, y) => {
        addRing(x, y, ring + 1);
      });
      continue;
    }
    if (op.op !== "platform" && op.op !== "outcrop" && op.op !== "floor_opening" && op.op !== "height")
      continue;
    forEachMaskCell(rasterizeShape(op.shape, { planSeed: work.plan.seed, clip }), (x, y) => {
      addRing(x, y, ring);
    });
  }
  return keep;
}

/**
 * Generator 4 (switch `caveOutlines`): chambers and corridors with natural rock walls get ragged, bulging outlines
 * (resolve/caveOutline.ts), passages at least two cells wide, every connection kept. Runs right after the areas are
 * claimed.
 */
export function stepCaveOutlines(work: ResolveGrid): void {
  if (!work.profile.caveOutlines) return;
  const keep = caveKeep(work, 1);
  const zoneAt = (i: number): boolean => {
    const d = work.disp[i] as number;
    return d > 0 && (work.areas[d - 1] as AreaInfo).isZone;
  };
  for (const info of work.areas) {
    if (info.isZone || info.isBridge || !isNaturalWallStyle(info.wallStyle) || info.mode === "none") continue;
    const cells = work.areaCells(info.index);
    if (cells.length < 6) continue;
    const ai1 = info.index + 1;
    const r = raggedCaveOutline(
      {
        w: work.w,
        h: work.h,
        owner: (i) => work.struct[i] as number,
        open: (i) => work.state[i] === CELL.OPEN,
        rock: (i) => work.state[i] === CELL.SOLID && work.struct[i] === 0 && work.disp[i] === 0,
        keep: (i) => keep.has(i) || zoneAt(i),
      },
      ai1,
      cells,
      elementSeed(work.plan.seed, `${info.area.id}~caveoutline`),
    );
    for (const i of r.open) work.claim(i, info);
    for (const i of r.close) {
      work.state[i] = CELL.SOLID;
      work.struct[i] = 0;
      work.disp[i] = 0;
      work.mat[i] = 0;
      work.flags[i] = 0;
      work.height[i] = 0;
      work.heightSet[i] = 0;
    }
  }
  work.recountStruct();
}

/**
 * Generator 4 (switch `caveRelief`): a cave floor the plan left flat (CAVE_RELIEF.flatShare of its dry cave floor at
 * one height) gets a few half-tile shelves (resolve/caveRelief.ts): low by the water, rising toward the back of side
 * chambers. Never under explicit features, bridges, links, openings or the pool edge, never beside another step.
 */
export function stepCaveRelief(work: ResolveGrid): void {
  if (!work.profile.caveRelief) return;
  const cave = (i: number): boolean => {
    const s = work.struct[i] as number;
    if (s <= 0 || work.state[i] !== CELL.OPEN) return false;
    const info = work.areas[s - 1] as AreaInfo;
    return isNaturalWallStyle(info.wallStyle) && !info.isBridge;
  };
  const dry = (i: number): boolean =>
    ((work.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) === 0;
  const floor: number[] = [];
  const count = new Map<number, number>();
  for (let i = 0; i < work.n; i++)
    if (cave(i) && dry(i)) {
      floor.push(i);
      count.set(work.height[i] as number, (count.get(work.height[i] as number) ?? 0) + 1);
    }
  if (floor.length < CAVE_RELIEF.minCells) return;
  let flat = 0;
  let most = 0;
  for (const [hq, n] of count)
    if (n > most) {
      most = n;
      flat = hq;
    }
  if (most / floor.length < CAVE_RELIEF.flatShare) return;
  // what stays: plan-made cells and their rings, water and its banks, bridges, any other step and the cells by it
  const keep = caveKeep(work, 1);
  const near = (i: number, r: number, test: (j: number) => boolean): boolean => {
    const [x, y] = work.cellXY(i);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const j = work.idx(x + dx, y + dy);
        if (j >= 0 && test(j)) return true;
      }
    return false;
  };
  const bridgeArea = (j: number): boolean => {
    const s = work.struct[j] as number;
    return s > 0 && (work.areas[s - 1] as AreaInfo).isBridge;
  };
  const cells = floor.filter(
    (i) =>
      work.height[i] === flat &&
      !keep.has(i) &&
      !near(
        i,
        2,
        (j) => ((work.flags[j] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) !== 0 || bridgeArea(j),
      ) &&
      !near(i, 1, (j) => work.state[j] === CELL.OPEN && work.height[j] !== flat),
  );
  // low ground: the water; with none, the heart of the largest cave chamber
  let low: number[] = [];
  for (let i = 0; i < work.n; i++)
    if (work.state[i] === CELL.OPEN && ((work.flags[i] as number) & CELL_FLAG.WATER) !== 0) low.push(i);
  if (low.length === 0) {
    let best = -1;
    let size = 0;
    for (const info of work.areas) {
      if (info.isZone || !isNaturalWallStyle(info.wallStyle)) continue;
      const n = work.areaCells(info.index).length;
      if (n > size) {
        size = n;
        best = info.index;
      }
    }
    if (best < 0) return;
    const d = work.innerDistance(work.areaCells(best));
    const top = Math.max(...d.values());
    low = [...d].filter(([, v]) => v >= top - 1).map(([i]) => i);
  }
  const shelves = caveShelves(
    work.organicGrid(),
    cells,
    low,
    (i) => work.state[i] === CELL.OPEN && ((work.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0,
    elementSeed(work.plan.seed, `${work.level.id}~caverelief`),
  );
  for (const [i, t] of shelves) if (t > 0) work.height[i] = (work.height[i] as number) + 2 * t;
}
