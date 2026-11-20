/**
 * Organic tier outlines for natural ground (generator 2, edge "ragged"): mounds, terraces, plateaus, knolls.
 *
 *  1. The shape is opened (eroded and dilated by a disc of radius 2): convex corners become round.
 *  2. Each cell's exact distance to the nearest cell outside the opened shape is measured (cells beyond the level
 *     bounds count as inside when `boundsInside`, so a plateau against the map edge stays high there).
 *  3. Tier t holds where distance + A·mₜ ≥ 1 + A/2 + (t − 1)·inset, with an independent noise field per tier
 *     (scale 3.5 cells plus a fine octave at 1.8, stretched ×1.8 and clamped to ±1, A = max(1.6, 0.9·inset + 0.8)): outlines wander, tiers are not parallel and vary in width,
 *     they can merge and split. Tiers nest (t needs t − 1), then neighbours are relaxed to at most one tier apart.
 *  4. Any tier step still straight for more than MAX_STRAIGHT (5) cells gets a seeded bump or notch, 1–2 cells wide,
 *     every 3–4 cells, then neighbours are relaxed again (up to four rounds).
 *
 * Arithmetic, sqrt and value noise only (architecture §2.5).
 */
import { ValueNoise } from "../gen/noise";
import { h32, subSeed } from "../util/hash";

export interface OrganicGrid {
  /** Global cell of a local index. */
  xy: (i: number) => [number, number];
  /** Local index of a global cell, or -1 outside the level. */
  idx: (x: number, y: number) => number;
}

export function organicTiers(
  cells: readonly number[],
  tiers: number,
  inset: number,
  seed: number,
  grid: OrganicGrid,
  boundsInside: boolean,
  /** Cells just outside the shape the outline may wander out onto (open floor within 2 cells). */
  grow: readonly number[] = [],
): Map<number, number> {
  const inS = new Set(cells);
  const inside = (x: number, y: number): boolean => {
    const i = grid.idx(x, y);
    return i < 0 ? boundsInside : inS.has(i);
  };
  // 1. opening by a disc of radius 2
  const R = 2;
  const disc: Array<[number, number]> = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R) disc.push([dx, dy]);
  const eroded = new Set<string>();
  for (const i of cells) {
    const [x, y] = grid.xy(i);
    if (disc.every(([dx, dy]) => inside(x + dx, y + dy))) eroded.add(`${x},${y}`);
  }
  const opened = new Set<number>();
  for (const i of cells) {
    const [x, y] = grid.xy(i);
    if (disc.some(([dx, dy]) => eroded.has(`${x + dx},${y + dy}`))) opened.add(i);
  }
  // small shapes that do not survive the opening keep their raw cells
  const base = opened.size >= Math.max(4, cells.length * 0.4) ? opened : inS;
  // 2. exact distance to the nearest cell outside (boundary ring of the opened shape)
  const ring: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const i of base) {
    const [x, y] = grid.xy(i);
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      const j = grid.idx(nx, ny);
      const out = j < 0 ? !boundsInside : !base.has(j);
      const k = `${nx},${ny}`;
      if (out && !seen.has(k)) {
        seen.add(k);
        ring.push([nx, ny]);
      }
    }
  }
  const dist = new Map<number, number>();
  for (const i of base) {
    const [x, y] = grid.xy(i);
    let best = Infinity;
    for (const [rx, ry] of ring) {
      const d = (rx - x) * (rx - x) + (ry - y) * (ry - y);
      if (d < best) best = d;
    }
    dist.set(i, Number.isFinite(best) ? Math.sqrt(best) : 99);
  }
  // 3. noisy, independent thresholds per tier
  const A = Math.max(1.6, 0.9 * inset + 0.8);
  // outside cells: distance 1 − (distance to the nearest shape cell), so the outline can wander outward too
  const baseXY = [...base].map((i) => grid.xy(i));
  for (const i of grow) {
    const [x, y] = grid.xy(i);
    let best = Infinity;
    for (const [bx, by] of baseXY) best = Math.min(best, (bx - x) * (bx - x) + (by - y) * (by - y));
    if (Number.isFinite(best)) dist.set(i, 1 - Math.sqrt(best));
  }
  const fields = Array.from({ length: tiers }, (_, t) => new ValueNoise(subSeed(seed, `tier${t}`)));
  const fine = Array.from({ length: tiers }, (_, t) => new ValueNoise(subSeed(seed, `fine${t}`)));
  const tierOf = new Map<number, number>();
  for (const i of [...cells, ...grow]) {
    const d = dist.get(i);
    if (d === undefined) {
      tierOf.set(i, 0);
      continue;
    }
    const [x, y] = grid.xy(i);
    let t = 0;
    for (let k = 1; k <= tiers; k++) {
      // value noise clusters near ½: stretch it (×1.8, clamped) so outlines really wander
      const n = (fields[k - 1] as ValueNoise).sample(x / 3.5 + k * 3.1, y / 3.5 + k * 1.7);
      const n2 = (fine[k - 1] as ValueNoise).sample(x / 1.8 + k * 5.3, y / 1.8 + k * 2.9);
      const m = Math.max(-1, Math.min(1, ((n - 0.5) * 2 * 0.7 + (n2 - 0.5) * 2 * 0.3) * 1.8));
      // the outline (tier 1) sits on the shape's edge on average and wanders both ways; inner tiers step in
      if (d + A * m >= (k === 1 ? 1.5 : 1.5 + 0.3 * A + (k - 1) * inset)) t = k;
      else break;
    }
    tierOf.set(i, t);
  }
  relax(tierOf, grid, boundsInside);
  despeckle(tierOf, grid);
  // 4. no long straight riser: a tier step running straight for more than MAX_STRAIGHT cells gets a bump (or a notch)
  //    every 3–4 cells, 1–2 cells wide, so no straight run is longer than MAX_STRAIGHT
  for (let round = 0; round < 6; round++) {
    if (!breakStraightRuns(tierOf, grid, boundsInside, seed, round)) break;
    relax(tierOf, grid, boundsInside);
  }
  return tierOf;
}

/**
 * Steps 3–4 on any tier map (cell → integer tier, neighbours at most one apart; cells outside the map count as tier
 * 0): despeckle, then break straight steps with spurs and gullies. Used by organicTiers and by the uneven op.
 */
export function breakStraightSteps(tierOf: Map<number, number>, grid: OrganicGrid, seed: number): void {
  relax(tierOf, grid, false);
  despeckle(tierOf, grid);
  for (let round = 0; round < 6; round++) {
    if (!breakStraightRuns(tierOf, grid, false, seed, round)) break;
    relax(tierOf, grid, false);
  }
}

/**
 * Cuts the square corners of tier bands once: a cell at an outer corner of its band (two neighbours at right angles
 * and the diagonal between them lower) drops a tier; a cell in an inner corner rises one. Bands read rounded.
 */
export function chamferCorners(tierOf: Map<number, number>, grid: OrganicGrid): void {
  const tierAt = (x: number, y: number): number => {
    const i = grid.idx(x, y);
    return i < 0 ? 0 : (tierOf.get(i) ?? 0);
  };
  const next = new Map<number, number>();
  for (const [i, t] of tierOf) {
    const [x, y] = grid.xy(i);
    for (const [ax, ay, bx, by] of [
      [0, -1, 1, 0],
      [1, 0, 0, 1],
      [0, 1, -1, 0],
      [-1, 0, 0, -1],
    ] as const) {
      const a = tierAt(x + ax, y + ay);
      const b = tierAt(x + bx, y + by);
      const d = tierAt(x + ax + bx, y + ay + by);
      if (a < t && b < t && d < t) {
        next.set(i, t - 1);
        break;
      }
      if (a > t && b > t && d > t) {
        next.set(i, t + 1);
        break;
      }
    }
  }
  for (const [i, t] of next) tierOf.set(i, t);
}

/** Longest straight tier step an organic outline keeps (cells). */
export const MAX_STRAIGHT = 5;

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function relax(tierOf: Map<number, number>, grid: OrganicGrid, boundsInside: boolean): void {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const i of tierOf.keys()) {
      const [x, y] = grid.xy(i);
      for (const [dx, dy] of N4) {
        const j = grid.idx(x + dx, y + dy);
        const tj = j < 0 ? (boundsInside ? undefined : 0) : (tierOf.get(j) ?? 0);
        if (tj !== undefined && (tierOf.get(i) as number) > tj + 1) {
          tierOf.set(i, tj + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** Single raised cells (no neighbour as high) drop a tier; single sunk cells (every neighbour higher) rise one. */
function despeckle(tierOf: Map<number, number>, grid: OrganicGrid): void {
  const next = new Map<number, number>();
  for (const [i, t] of tierOf) {
    const [x, y] = grid.xy(i);
    let higher = 0;
    let asHigh = 0;
    let n = 0;
    for (const [dx, dy] of N4) {
      const j = grid.idx(x + dx, y + dy);
      if (j < 0) continue;
      const tj = tierOf.get(j) ?? 0;
      n++;
      if (tj >= t) asHigh++;
      if (tj > t) higher++;
    }
    if (n === 0) continue;
    if (t > 0 && asHigh === 0) next.set(i, t - 1);
    else if (higher === n) next.set(i, t + 1);
  }
  for (const [i, t] of next) tierOf.set(i, t);
}

/** Breaks tier steps straighter than MAX_STRAIGHT. Returns whether anything changed. */
function breakStraightRuns(
  tierOf: Map<number, number>,
  grid: OrganicGrid,
  boundsInside: boolean,
  seed: number,
  round: number,
): boolean {
  if (tierOf.size === 0) return false;
  const tierAt = (x: number, y: number): number | undefined => {
    const i = grid.idx(x, y);
    if (i < 0) return boundsInside ? undefined : 0;
    return tierOf.get(i) ?? 0;
  };
  // a spur: raise a cell, and lift what lies beyond it so tiers stay at most one apart (a ridge running down the
  // slope); fails when that would need a cell outside the shape and its ring
  const spur = (x: number, y: number, t: number): boolean => {
    const set = new Map<number, number>();
    const queue: Array<[number, number, number]> = [[x, y, t]];
    while (queue.length > 0) {
      const [cx, cy, ct] = queue.pop() as [number, number, number];
      const i = grid.idx(cx, cy);
      if (i < 0) continue;
      if (!tierOf.has(i)) return false;
      if ((set.get(i) ?? tierOf.get(i) ?? 0) >= ct) continue;
      set.set(i, ct);
      for (const [dx, dy] of N4) queue.push([cx + dx, cy + dy, ct - 1]);
    }
    for (const [i, ti] of set) tierOf.set(i, ti);
    return set.size > 0;
  };
  // a gully: lower a cell, and what lies behind it (relaxed at once, a dent running up the slope)
  const gully = (x: number, y: number, t: number): boolean => {
    const i = grid.idx(x, y);
    if (i < 0 || !tierOf.has(i)) return false;
    const queue: Array<[number, number, number]> = [[x, y, t]];
    let changed = false;
    while (queue.length > 0) {
      const [cx, cy, ct] = queue.pop() as [number, number, number];
      const j = grid.idx(cx, cy);
      if (j < 0 || !tierOf.has(j) || (tierOf.get(j) as number) <= ct) continue;
      tierOf.set(j, ct);
      changed = true;
      for (const [dx, dy] of N4) queue.push([cx + dx, cy + dy, ct + 1]);
    }
    return changed;
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of tierOf.keys()) {
    const [x, y] = grid.xy(i);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let edited = false;
  // horiz: steps between rows (a = row above, b = row below); vertical: between columns
  for (const horiz of [true, false]) {
    const u0 = (horiz ? minY : minX) - 1;
    const u1 = horiz ? maxY : maxX;
    const v0 = (horiz ? minX : minY) - 1;
    const v1 = (horiz ? maxX : maxY) + 1;
    const cellA = (u: number, v: number): [number, number] => (horiz ? [v, u] : [u, v]);
    const cellB = (u: number, v: number): [number, number] => (horiz ? [v, u + 1] : [u + 1, v]);
    for (let u = u0; u <= u1; u++) {
      let start = v0;
      let dir = 0;
      for (let v = v0; v <= v1 + 1; v++) {
        let d = 0;
        if (v <= v1) {
          const [ax, ay] = cellA(u, v);
          const [bx, by] = cellB(u, v);
          const ta = tierAt(ax, ay);
          const tb = tierAt(bx, by);
          if (ta !== undefined && tb !== undefined) d = Math.sign(ta - tb);
        }
        if (d !== 0 && d === dir) continue;
        const len = v - start;
        if (dir !== 0 && len > MAX_STRAIGHT) {
          // a spur or a gully every 3–4 cells, 1–2 cells wide, seeded per run; each breaks every parallel step there
          let h = h32(`${seed}:straight:${round}:${horiz ? "h" : "v"}:${u}:${start}`);
          let p = start + 2 + (h % 2);
          const breakAt = (q: number, preferSpur: boolean): boolean => {
            const [ax, ay] = cellA(u, q);
            const [bx, by] = cellB(u, q);
            const ta = tierAt(ax, ay);
            const tb = tierAt(bx, by);
            if (ta === undefined || tb === undefined || ta === tb) return false;
            const [hx, hy, lx, ly] = ta > tb ? [ax, ay, bx, by] : [bx, by, ax, ay];
            const tHigh = Math.max(ta, tb);
            const tLow = Math.min(ta, tb);
            if (preferSpur) return spur(lx, ly, tHigh) || gully(hx, hy, tLow);
            return gully(hx, hy, tLow) || spur(lx, ly, tHigh);
          };
          while (p < v - 1) {
            h = h32(`${h}`);
            const w = 1 + (h % 2);
            const preferSpur = (h >>> 3) % 3 !== 0;
            if (!breakAt(p, preferSpur)) {
              p += 1;
              continue;
            }
            edited = true;
            if (w === 2 && p + 1 < v - 1) breakAt(p + 1, preferSpur);
            p += w + 3 + ((h >>> 5) % 2);
          }
        }
        start = v;
        dir = d;
      }
    }
  }
  return edited;
}
