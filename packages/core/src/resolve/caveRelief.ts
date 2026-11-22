/**
 * Generator 4: natural relief on a flat cave floor. A cave whose plan leaves the floor one flat sheet (apart from the
 * pool and the odd platform) reads as a ballroom with rock walls. This pass lifts the floor in a few broad shelves of
 * half a tile each, following the cave's own shape: the floor stays low by the water (or, with no water, in the
 * middle of the largest chamber) and climbs toward the back of side chambers and corridors (the walking distance
 * from the low ground), with broad noise so the shelves wander. Shelf edges are broken like organic tiers
 * (breakStraightSteps), tiny shelves join their neighbour, and neighbours never differ by more than one shelf,
 * so every step is half a tile (walkable without stairs; the build clads it with rock fill, never brick blocks).
 *
 * Only `cells` change (the caller passes the floor at the flat height, away from water, features, bridges, links,
 * openings and other steps); everything else counts as shelf 0. Pure; arithmetic and value noise only.
 */
import { NEIGHBOURS4 } from "../gen/gridGeometry";
import { ValueNoise } from "../gen/noise";
import { subSeed } from "../util/hash";
import { breakStraightSteps, type OrganicGrid } from "./organic";

export const CAVE_RELIEF = {
  /** One shelf's rise (tiles). */
  shelfTiles: 0.5,
  /** A floor counts as flat when this share of its dry cave floor is at one height. */
  flatShare: 0.75,
  /** Fewest cells worth shaping. */
  minCells: 40,
  /** Walking distance from the low ground (cells) that stays at shelf 0. */
  lowBand: 3,
  /** Highest shelf (half tiles): 2 in a small cave, 3 when the far end lies this far from the low ground. */
  maxShelf: 2,
  maxShelfFar: 3,
  far: 22,
  /** Broad noise (cells) and its pull (shelves, ± half). */
  scale: 6,
  wander: 1.4,
  /** Shelves smaller than this (cells) drop to the one below. */
  minShelf: 8,
} as const;

const N4 = NEIGHBOURS4;

/**
 * Shelf (0..maxShelf, in half tiles) for each of `cells`. `low` are the cells the floor stays low at (water, or the
 * heart of the main chamber); `walk` says which cells the walking distance may pass through (open floor). No shelf
 * rises above `ceilingShelf` (a level stacked above leaves room for that many: plan/levels.ts `highestFloorTop`).
 */
export function caveShelves(
  grid: OrganicGrid,
  cells: readonly number[],
  low: readonly number[],
  walk: (i: number) => boolean,
  seed: number,
  ceilingShelf = Infinity,
): Map<number, number> {
  const out = new Map<number, number>();
  if (cells.length < CAVE_RELIEF.minCells || low.length === 0 || ceilingShelf < 1) return out;
  const set = new Set(cells);
  // walking distance from the low ground
  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (const i of low) {
    dist.set(i, 0);
    frontier.push(i);
  }
  for (let d = 1; frontier.length > 0; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const [x, y] = grid.xy(i);
      for (const [dx, dy] of N4) {
        const j = grid.idx(x + dx, y + dy);
        if (j < 0 || dist.has(j) || !walk(j)) continue;
        dist.set(j, d);
        next.push(j);
      }
    }
    frontier = next;
  }
  const reach = cells.map((i) => dist.get(i)).filter((d): d is number => d !== undefined);
  if (reach.length === 0) return out;
  const sorted = [...reach].sort((a, b) => a - b);
  const far = sorted[Math.floor(sorted.length * 0.95)] as number;
  // the slope is the cave's own; a low ceiling only flattens the top shelves
  const slopeShelf = far >= CAVE_RELIEF.far ? CAVE_RELIEF.maxShelfFar : CAVE_RELIEF.maxShelf;
  const maxShelf = Math.min(slopeShelf, ceilingShelf);
  const span = Math.max(4, far - CAVE_RELIEF.lowBand);
  const noise = new ValueNoise(subSeed(seed, "caverelief"));
  for (const i of cells) {
    const d = dist.get(i);
    if (d === undefined) {
      out.set(i, 0);
      continue;
    }
    const [x, y] = grid.xy(i);
    const t = (Math.max(0, d - CAVE_RELIEF.lowBand) / span) * (slopeShelf + 0.6);
    const n = (noise.sample(x / CAVE_RELIEF.scale, y / CAVE_RELIEF.scale) - 0.5) * 2 * CAVE_RELIEF.wander;
    // nothing rises inside the low band
    const v = d <= CAVE_RELIEF.lowBand ? 0 : Math.round(t + n);
    out.set(i, Math.max(0, Math.min(maxShelf, v)));
  }
  // the rock walls are no step: pad them with the shelf beside them while the edges are shaped (the organic passes
  // count a cell outside the map as shelf 0), then drop the pads
  const pads: number[] = [];
  for (const i of cells) {
    const [x, y] = grid.xy(i);
    for (const [dx, dy] of N4) {
      const j = grid.idx(x + dx, y + dy);
      if (j < 0 || walk(j) || set.has(j)) continue;
      if (!out.has(j)) pads.push(j);
      out.set(j, Math.max(out.get(j) ?? 0, out.get(i) as number));
    }
  }
  // organic shelf edges, then no tiny shelves, then one shelf apart everywhere (open cells outside count as 0)
  breakStraightSteps(out, grid, subSeed(seed, "caverelief:edges"));
  for (const j of pads) out.delete(j);
  for (let pass = 0; pass < 3; pass++) if (!dropSmall(out, grid, set)) break;
  relaxToZero(out, grid, walk);
  return out;
}

/** Shelves (same value, 4-connected) under CAVE_RELIEF.minShelf cells drop by one. Returns whether any did. */
function dropSmall(tiers: Map<number, number>, grid: OrganicGrid, set: ReadonlySet<number>): boolean {
  const seen = new Set<number>();
  let changed = false;
  for (const s of [...tiers.keys()].sort((a, b) => a - b)) {
    const t = tiers.get(s) as number;
    if (seen.has(s) || t === 0) continue;
    const group = [s];
    seen.add(s);
    for (let k = 0; k < group.length; k++) {
      const [x, y] = grid.xy(group[k] as number);
      for (const [dx, dy] of N4) {
        const j = grid.idx(x + dx, y + dy);
        if (j < 0 || seen.has(j) || !set.has(j) || tiers.get(j) !== t) continue;
        seen.add(j);
        group.push(j);
      }
    }
    if (group.length < CAVE_RELIEF.minShelf) {
      // it joins the shelf it borders most (a shelf bordering only rock and kept ground stays)
      const votes = new Map<number, number>();
      for (const i of group) {
        const [x, y] = grid.xy(i);
        for (const [dx, dy] of N4) {
          const j = grid.idx(x + dx, y + dy);
          if (j < 0 || !set.has(j) || tiers.get(j) === t) continue;
          const tj = tiers.get(j) as number;
          votes.set(tj, (votes.get(tj) ?? 0) + 1);
        }
      }
      if (votes.size === 0) continue;
      let to = t - 1;
      let most = 0;
      for (const [tj, n] of [...votes].sort((a, b) => a[0] - b[0]))
        if (n > most) {
          most = n;
          to = tj;
        }
      for (const i of group) tiers.set(i, to);
      changed = true;
    }
  }
  return changed;
}

/** Neighbours at most one shelf apart; an open cell outside the map counts as shelf 0, rock is no neighbour (lowering only). */
function relaxToZero(tiers: Map<number, number>, grid: OrganicGrid, walk: (i: number) => boolean): void {
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const [i, t] of tiers) {
      const [x, y] = grid.xy(i);
      let cap = t;
      for (const [dx, dy] of N4) {
        const j = grid.idx(x + dx, y + dy);
        if (j < 0 || (!tiers.has(j) && !walk(j))) continue;
        const tj = tiers.get(j) ?? 0;
        cap = Math.min(cap, tj + 1);
      }
      if (cap < t) {
        tiers.set(i, Math.max(0, cap));
        changed = true;
      }
    }
    if (!changed) break;
  }
}
