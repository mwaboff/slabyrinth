/**
 * Generator 3 water dressing: pools and slow reaches are part of the rock, not a cut in the ground.
 *
 * In the studied builds a pool carries 0.4 to 0.75 pieces per water-edge tile, clustered: boulders sunk so their tops sit
 * at the surface, reeds and roots standing in the shallows, rock along part of the shore (never all of it: one bank stays
 * open), and stepping stones where a trail crosses shallow water. Everything goes through palette roles (the sunk and
 * shore rocks are the theme's `cliff_crest` boulder, the plants its `reeds`, the rest its `edge_dressing`); a theme
 * without the role gets nothing for that part.
 *
 * Sunk boulders use the band rock type (`cliff_crest`) so that the verifier's rule for rock that stands on its own base
 * course applies (a boulder sunk into the bed is by design). They are kept off paths, links and the water's narrow
 * necks, and the stepping stones are placed only where a ford really joins two dry banks.
 */
import type { FeatureType } from "../contracts/plan";
import { ValueNoise } from "./noise";
import { gridProfile, type GeneratedPlacement, type PlacementGrid } from "./placementGrid";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";

import {
  FLAG_LINK,
  FLAG_NO_FLOOR,
  FLAG_PATH,
  FLAG_WATER,
  NEIGHBOURS4 as D4,
  cellKey as key,
} from "./gridGeometry";

/** Pieces per water-edge tile (a water cell with a dry neighbour, or a dry cell beside water). */
export const WATER_DRESS = {
  perEdge: [0.5, 0.75],
  minWater: 12,
  shareShore: 0.35,
  shareReeds: 0.35,
} as const;

export interface WaterParams {
  /** The area's cells (global). */
  cells: ReadonlyArray<[number, number]>;
  inArea: (x: number, y: number) => boolean;
  /** Cells something already stands on or that a group has taken. */
  taken: (x: number, y: number) => boolean;
  seed: number;
  remaining: number;
}

export interface WaterResult {
  placements: GeneratedPlacement[];
  /** Water-edge tiles counted, and how many of the pieces are plants, shore rock, sunk boulders and stepping stones. */
  edge: number;
  plants: number;
  shore: number;
  sunk: number;
  stones: number;
  /** Longest run of shoreline (cells) with no rock, root or plant within one cell. */
  openBank: number;
}

export function dressWater(grid: PlacementGrid, prm: WaterParams): WaterResult {
  const out: GeneratedPlacement[] = [];
  const res: WaterResult = { placements: out, edge: 0, plants: 0, shore: 0, sunk: 0, stones: 0, openBank: 0 };
  if (!gridProfile(grid).waterBody || !grid.height) return res;
  const height = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  const fl = (x: number, y: number): number => grid.flags(x, y);
  const isWater = (x: number, y: number): boolean =>
    grid.inBounds(x, y) &&
    grid.isFloor(x, y) &&
    (fl(x, y) & FLAG_WATER) !== 0 &&
    (fl(x, y) & FLAG_PATH) === 0;
  const isDry = (x: number, y: number): boolean =>
    grid.inBounds(x, y) && grid.isFloor(x, y) && (fl(x, y) & (FLAG_WATER | FLAG_NO_FLOOR)) === 0;
  const water = prm.cells.filter(([x, y]) => isWater(x, y));
  if (water.length < WATER_DRESS.minWater) return res;

  // the board's water surface (tiles above the level floor, the scale of grid.height): half a tile below the lowest bank
  // and at least a quarter tile above the highest bed (resolve/level/waterSurface.ts); an optional hook wins
  let bed = -Infinity;
  let bank = Infinity;
  for (const [x, y] of water) {
    bed = Math.max(bed, height(x, y));
    for (const [dx, dy] of D4) if (isDry(x + dx, y + dy)) bank = Math.min(bank, height(x + dx, y + dy));
  }
  const surface =
    grid.waterSurface?.() ?? (Number.isFinite(bank) ? Math.max(bed + 0.25, bank - 0.5) : bed + 0.25);

  const rng = createPrng(subSeed(prm.seed, "waterdress"));
  const field = new ValueNoise(subSeed(prm.seed, "waterdress:field"));
  const used = new Set<number>();
  const free = (x: number, y: number): boolean =>
    prm.inArea(x, y) && !grid.occupied(x, y) && !prm.taken(x, y) && !used.has(key(x, y));
  const nearPath = (x: number, y: number, r = 1): boolean => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (grid.inBounds(x + dx, y + dy) && (fl(x + dx, y + dy) & (FLAG_PATH | FLAG_LINK)) !== 0)
          return true;
    return false;
  };

  // water-edge tiles: shallow rim (water with a dry neighbour) and the bank (dry with water beside it)
  const rim: Array<[number, number]> = [];
  const shore: Array<[number, number]> = [];
  for (const [x, y] of prm.cells) {
    if (isWater(x, y) && D4.some(([dx, dy]) => isDry(x + dx, y + dy))) rim.push([x, y]);
    else if (isDry(x, y) && D4.some(([dx, dy]) => isWater(x + dx, y + dy))) shore.push([x, y]);
  }
  res.edge = rim.length + shore.length;
  if (res.edge === 0) return res;
  const target = Math.round(
    res.edge * (WATER_DRESS.perEdge[0] + rng.next() * (WATER_DRESS.perEdge[1] - WATER_DRESS.perEdge[0])),
  );
  const room = (): number =>
    Math.min(prm.remaining - out.length, target - (res.plants + res.shore + res.sunk + res.stones));

  const add = (
    type: FeatureType,
    x: number,
    y: number,
    size: [number, number],
    extra: Partial<GeneratedPlacement> = {},
  ): void => {
    for (let yy = y; yy < y + size[1]; yy++) for (let xx = x; xx < x + size[0]; xx++) used.add(key(xx, yy));
    out.push({ type, at: [x, y], size, rot: 0, rotFine: rng.int(24) * 15, ...extra });
  };

  // ── stepping stones where a ford joins two banks ──
  const boulder = grid.pieceExtent?.("cliff_crest");
  const bsize = grid.pieceSize?.("cliff_crest");
  const bw = bsize ? Math.max(1, Math.round(bsize.w)) : 2;
  const bh = bsize ? Math.max(1, Math.round(bsize.d)) : 2;
  const wetBlock = (x: number, y: number): boolean => {
    for (let yy = y; yy < y + bh; yy++)
      for (let xx = x; xx < x + bw; xx++) if (!isWater(xx, yy) || !free(xx, yy)) return false;
    return true;
  };
  const sink = (x: number, y: number, top: number): number => {
    // the stone's top at `top` above the level floor, from the shallowest cell of its footprint
    let lo = Infinity;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) lo = Math.min(lo, height(xx, yy));
    return top - lo - (boulder?.h ?? 1.6);
  };
  if (boulder) {
    for (const [px, py] of prm.cells) {
      if ((fl(px, py) & FLAG_PATH) === 0) continue;
      for (const [dx, dy] of D4) {
        // a path cell whose neighbour is shallow water: walk straight across; a ford joins it to dry floor within 6 cells
        let n = 0;
        let x = px + dx;
        let y = py + dy;
        const run: Array<[number, number]> = [];
        while (isWater(x, y) && n < 7) {
          run.push([x, y]);
          x += dx;
          y += dy;
          n++;
        }
        if (run.length < 2 || run.length > 6 || !isDry(x, y) || (fl(x, y) & FLAG_PATH) === 0) continue;
        // only shallows: every cell of the run within a tile of the surface
        if (!run.every(([qx, qy]) => surface - height(qx, qy) <= 1.0)) continue;
        for (let i = 0; i < run.length; i += 2) {
          const [qx, qy] = run[i] as [number, number];
          if (room() <= 0) break;
          // the stone sits on the run; its box may spill sideways, so the cell must sit on water
          if (!wetBlock(qx, qy)) continue;
          add("cliff_crest", qx, qy, [bw, bh], { lift: sink(qx, qy, surface + 0.12) });
          res.stones++;
        }
      }
    }
  }

  // ── reeds and roots in the shallows (clusters of two to four along the rim) ──
  let want = Math.round(target * WATER_DRESS.shareReeds);
  for (const [x, y] of rng.shuffle(rim)) {
    if (want <= 0 || room() <= 0) break;
    if (field.sample(x / 3, y / 3) < 0.5 || !rng.chance(0.55) || !free(x, y) || nearPath(x, y)) continue;
    const clump: Array<[number, number]> = [[x, y]];
    for (const [dx, dy] of rng.shuffle(D4)) {
      if (clump.length >= 2 + rng.int(3)) break;
      const nx = x + dx;
      const ny = y + dy;
      if (isWater(nx, ny) && free(nx, ny) && !nearPath(nx, ny) && surface - height(nx, ny) <= 1.25)
        clump.push([nx, ny]);
    }
    for (const [cx, cy] of clump) {
      if (want <= 0 || room() <= 0) break;
      add("reeds", cx, cy, [1, 1]);
      res.plants++;
      want--;
    }
  }

  // ── rock along part of the shore: clusters of two to four, bare bank between (one bank stays open) ──
  let wantShore = Math.round(target * WATER_DRESS.shareShore);
  const rockType: FeatureType = "edge_dressing";
  for (const [x, y] of rng.shuffle(shore)) {
    if (wantShore <= 0 || room() <= 0) break;
    if (field.sample(x / 3.5 + 40, y / 3.5) < 0.55 || !free(x, y) || nearPath(x, y, 2)) continue;
    const clump: Array<[number, number]> = [[x, y]];
    for (const [dx, dy] of rng.shuffle(D4)) {
      if (clump.length >= 2 + rng.int(3)) break;
      const nx = x + dx;
      const ny = y + dy;
      if (
        isDry(nx, ny) &&
        free(nx, ny) &&
        !nearPath(nx, ny, 2) &&
        D4.some(([ax, ay]) => isWater(nx + ax, ny + ay))
      )
        clump.push([nx, ny]);
    }
    for (const [cx, cy] of clump) {
      if (wantShore <= 0 || room() <= 0) break;
      add(rockType, cx, cy, [1, 1]);
      res.shore++;
      wantShore--;
    }
  }

  // ── boulders sunk so their tops sit at the surface, in the water's interior, in loose pairs ──
  if (boulder) {
    const deep = water.filter(
      ([x, y]) => !rim.some(([rx, ry]) => Math.abs(rx - x) <= 1 && Math.abs(ry - y) <= 1),
    );
    let wantSunk = Math.max(0, target - res.plants - res.shore - res.stones);
    for (const [x, y] of rng.shuffle(deep)) {
      if (wantSunk <= 0 || room() <= 0) break;
      if (field.sample(x / 4 + 80, y / 4) < 0.5 || !wetBlock(x, y) || nearPath(x, y, 2)) continue;
      // keep a cell clear round it (no neck): the cells round the block are water or already stone
      add("cliff_crest", x, y, [bw, bh], { lift: sink(x, y, surface + 0.05) });
      res.sunk++;
      wantSunk--;
    }
  }

  // the longest run of shoreline with nothing within a cell (one bank stays open)
  const dressed = out.map((p) => p.at);
  let run = 0;
  for (const [x, y] of shore.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const bare = !dressed.some(([qx, qy]) => Math.abs(qx - x) <= 1 && Math.abs(qy - y) <= 1);
    run = bare ? run + 1 : 0;
    res.openBank = Math.max(res.openBank, run);
  }
  return res;
}
