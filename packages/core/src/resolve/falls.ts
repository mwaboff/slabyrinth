/**
 * Stepped rivers, generator 3 (terrain round, 2026-11-20). A river that runs down a slope used to be cut to one level
 * and became a trench. Where its course drops 2 tiles or more it is split into reaches at different levels with a fall
 * between them (1 to 3 tiles each), as a real stream steps down a hillside. This module only plans: which samples of
 * the course end a reach, which reach every channel cell belongs to and what level each reach is cut to. The resolver
 * (level.ts) cuts the heights, widens a pool at each foot and records the falls.
 *
 * Arithmetic only (no trigonometry), integer-lattice neutral: every engine agrees on the cells.
 */
import type { Side } from "../contracts/plan";
import type { ChasmSample } from "./chasm";

/** Heights are quarter tiles. A fall is 1 to 3 tiles. */
export const FALL_MIN_Q = 4;
export const FALL_MAX_Q = 12;
/** One fall per this much descent (2.5 tiles). */
const FALL_TYPICAL_Q = 10;
const MAX_FALLS = 6;
/** A reach whose ground drops this much along it (2 tiles) is split again. */
const REACH_SPREAD_Q = 8;
/** A course must drop this much (quarter tiles) before it steps. */
export const STEP_MIN_DROP_Q = 8;
/** Samples are half a cell apart: no fall within this many samples of another or of an end of the course. */
const MIN_GAP = 8;

export interface ChannelCell {
  i: number;
  x: number;
  y: number;
}

export interface PlannedFall {
  /** Flow index (0 = upstream end) of the first sample of the lower reach. */
  boundary: number;
  /** Direction the water falls. */
  side: Side;
  /** Channel cells of the last cell-length of the upper reach, all across the channel. */
  lip: number[];
  /** The upper reach's last cell (the lip's centre). */
  at: [number, number];
}

export interface ReachPlan {
  /** Sample index for each flow index. */
  flow: number[];
  /** Flow index for each sample index. */
  inv: number[];
  /** Reach number (0 = upstream) of every channel cell, by cell index. */
  reachOf: Map<number, number>;
  /** Flow index of the nearest sample of every channel cell, by cell index. */
  flowOf: Map<number, number>;
  /** Level (quarter tiles) every reach is cut from: its ground's lower quartile, falls 1 to 3 tiles apart. */
  low: number[];
  falls: PlannedFall[];
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/**
 * Plan the reaches of a river. `ground` gives the ground height (quarter tiles) at a cell, null off the open floor.
 * Returns null when the course drops less than 2 tiles (it stays one level) or has no room for a fall.
 */
export function planReaches(
  samples: readonly ChasmSample[],
  cells: readonly ChannelCell[],
  widths: readonly number[],
  ground: (x: number, y: number) => number | null,
): ReachPlan | null {
  const n = samples.length;
  if (n < 2 * MIN_GAP + 2 || cells.length === 0) return null;
  // the ground beside the course: its lower bank (a river along the foot of a rise has one high bank), smoothed by a
  // median over three cells
  const raw: number[] = [];
  let last = 0;
  const inChannel = new Set(cells.map((c) => `${c.x},${c.y}`));
  samples.forEach((s, k) => {
    // the dry ground within two cells of the channel here (what the review measures as the banks): its lower quartile
    const cx = Math.floor(s.x);
    const cy = Math.floor(s.y);
    const r = Math.ceil((widths[k] ?? 2) / 2) + 2;
    const banks: number[] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r || inChannel.has(`${cx + dx},${cy + dy}`)) continue;
        const g = ground(cx + dx, cy + dy);
        if (g !== null) banks.push(g);
      }
    banks.sort((a, b) => a - b);
    const g = banks.length > 0 ? (banks[Math.floor((banks.length - 1) / 2)] as number) : ground(cx, cy);
    if (g !== null) last = g;
    raw.push(last);
  });
  const sg = raw.map((_, k) => median(raw.slice(Math.max(0, k - 3), Math.min(n, k + 4))));
  const q = Math.max(1, Math.floor(n / 4));
  const mean = (a: number, b: number): number => {
    let t = 0;
    for (let k = a; k < b; k++) t += sg[k] as number;
    return t / Math.max(1, b - a);
  };
  const rev = mean(0, q) < mean(n - q, n);
  const flow = sg.map((_, k) => (rev ? n - 1 - k : k));
  const inv = new Array<number>(n);
  flow.forEach((s, j) => {
    inv[s] = j;
  });
  // cumulative descent along the flow (never decreasing)
  const g0 = sg[flow[0] as number] as number;
  const m: number[] = [];
  let run = 0;
  for (let j = 0; j < n; j++) {
    run = Math.max(run, g0 - (sg[flow[j] as number] as number));
    m.push(run);
  }
  const total = m[n - 1] as number;
  if (total < STEP_MIN_DROP_Q) return null;
  // falls of about two to two and a half tiles (never more than three)
  const falls = Math.min(MAX_FALLS - 1, Math.ceil(total / FALL_TYPICAL_Q));
  const bounds: number[] = [];
  for (let f = 1; f <= falls; f++) {
    const want = (total * (f - 0.5)) / falls;
    let j = 0;
    while (j < n - 1 && (m[j] as number) < want) j++;
    const prev = bounds.length > 0 ? (bounds[bounds.length - 1] as number) : 0;
    if (j - prev < MIN_GAP || n - 1 - j < MIN_GAP) continue;
    bounds.push(j);
  }
  if (bounds.length === 0) return null;
  // a reach whose ground still drops 2 tiles or more along it would stay a trench: split it where it falls fastest
  for (let guard = 0; guard < 6 && bounds.length < MAX_FALLS; guard++) {
    const edges = [0, ...bounds, n];
    let split = -1;
    for (let r = 0; r + 1 < edges.length && split < 0; r++) {
      const lo = edges[r] as number;
      const hi = edges[r + 1] as number;
      let mx = -Infinity;
      let mn = Infinity;
      for (let j = lo; j < hi; j++) {
        const g = sg[flow[j] as number] as number;
        mx = Math.max(mx, g);
        mn = Math.min(mn, g);
      }
      if (mx - mn < REACH_SPREAD_Q) continue;
      const mid = (mx + mn) / 2;
      for (let j = lo + MIN_GAP; j < hi - MIN_GAP; j++)
        if ((sg[flow[j] as number] as number) <= mid) {
          split = j;
          break;
        }
    }
    if (split < 0) break;
    bounds.push(split);
    bounds.sort((a, b) => a - b);
  }
  // every channel cell belongs to the reach of its nearest sample
  const reachOf = new Map<number, number>();
  const flowOf = new Map<number, number>();
  const per: number[][] = bounds.map(() => []);
  per.push([]);
  for (const c of cells) {
    let best = Infinity;
    let bk = 0;
    for (let k = 0; k < n; k++) {
      const s = samples[k] as ChasmSample;
      const dx = c.x + 0.5 - s.x;
      const dy = c.y + 0.5 - s.y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bk = k;
      }
    }
    const fp = inv[bk] as number;
    let r = 0;
    while (r < bounds.length && (bounds[r] as number) <= fp) r++;
    reachOf.set(c.i, r);
    flowOf.set(c.i, fp);
    const g = ground(c.x, c.y);
    if (g !== null) (per[r] as number[]).push(g);
  }
  const low: number[] = per.map((gs, r) => {
    if (gs.length === 0) return r === 0 ? g0 : 0;
    const s = [...gs].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * 0.25)] as number;
  });
  for (let r = 1; r < low.length; r++) {
    const above = low[r - 1] as number;
    low[r] = Math.max(above - FALL_MAX_Q, Math.min(above - FALL_MIN_Q, low[r] as number));
  }
  const out: PlannedFall[] = bounds.map((b) => {
    const lip: number[] = [];
    for (const c of cells) {
      const fp = flowOf.get(c.i) as number;
      if (fp >= b - 2 && fp < b) lip.push(c.i);
    }
    const s = samples[flow[b - 1] as number] as ChasmSample;
    const tx = rev ? -s.tx : s.tx;
    const ty = rev ? -s.ty : s.ty;
    const side: Side = Math.abs(tx) >= Math.abs(ty) ? (tx > 0 ? "E" : "W") : ty > 0 ? "S" : "N";
    return { boundary: b, side, lip, at: [Math.floor(s.x), Math.floor(s.y)] as [number, number] };
  });
  return { flow, inv, reachOf, flowOf, low, falls: out };
}
