/**
 * Cliff edges of a resolved level, for dressing that drapes large rock (or any edge) props over drops so the grid
 * edge never shows as a bare block face. Theme-neutral: it reports geometry only; what goes there is palette data.
 */
import type { Material, Side, Vec2 } from "../contracts/plan";
import { CELL, CELL_FLAG, EDGE, type ResolvedCliffRun, type ResolvedLevel } from "../contracts/resolved";
import { cellIndex, hEdgeIndex, vEdgeIndex } from "./levelGrid";
import { isNaturalGround } from "./materials";

export interface CliffEdge {
  /** The upper cell (the edge lies on its `side`). */
  at: Vec2;
  /** Side of `at` the drop is on: a prop draped over the edge faces this way. */
  side: Side;
  /** Height of the drop in tiles (upper floor minus the floor below). */
  drop: number;
  /** Absolute height of the upper floor top (tiles). */
  top: number;
}

/** Every LEDGE edge with a drop of at least `minDrop` tiles (bridge decks excluded), row-major. */
export function cliffEdges(level: ResolvedLevel, minDrop = 1): CliffEdge[] {
  const { x: bx, y: by, w, h } = level.bounds;
  const out: CliffEdge[] = [];
  const at = (x: number, y: number): number => cellIndex(level.bounds, x, y);
  const usable = (i: number): boolean =>
    i >= 0 && level.cells.state[i] === CELL.OPEN && ((level.cells.flags[i] ?? 0) & CELL_FLAG.BRIDGE) === 0;
  const push = (a: number, b: number, sideOfA: Side, sideOfB: Side): void => {
    if (!usable(a) || !usable(b)) return;
    const ha = (level.cells.height[a] ?? 0) / 4;
    const hb = (level.cells.height[b] ?? 0) / 4;
    const upper = ha > hb ? a : b;
    const drop = Math.abs(ha - hb);
    if (drop < minDrop) return;
    out.push({
      at: [bx + (upper % w), by + Math.floor(upper / w)],
      side: upper === a ? sideOfA : sideOfB,
      drop,
      top: level.elevation + Math.max(ha, hb) + 0.5,
    });
  };
  for (let ly = 1; ly < h; ly++)
    for (let lx = 0; lx < w; lx++)
      if (level.hEdges.kind[hEdgeIndex(level.bounds, lx, ly)] === EDGE.LEDGE)
        push(at(lx, ly - 1), at(lx, ly), "S", "N");
  for (let ly = 0; ly < h; ly++)
    for (let lx = 1; lx < w; lx++)
      if (level.vEdges.kind[vEdgeIndex(level.bounds, lx, ly)] === EDGE.LEDGE)
        push(at(lx - 1, ly), at(lx, ly), "E", "W");
  return out.sort((p, q) => p.at[1] - q.at[1] || p.at[0] - q.at[0]);
}

/**
 * Natural cliff runs (generator 2): every LEDGE edge where natural ground rises at least `minRise` quarter tiles,
 * chained into runs along the lattice (the upper ground on the right), with stair edges kept in the chain as
 * crossings. Bridge decks and building areas are left out. Deterministic, row-major starts.
 */
export function cliffRuns(level: ResolvedLevel, minRise = 4): ResolvedCliffRun[] {
  const { x: bx, y: by, w, h } = level.bounds;
  const at = (x: number, y: number): number => cellIndex(level.bounds, x, y);
  const mat = (i: number): Material | null => level.materials[(level.cells.material[i] ?? 1) - 1] ?? null;
  const usable = (i: number): boolean =>
    i >= 0 &&
    level.cells.state[i] === CELL.OPEN &&
    ((level.cells.flags[i] ?? 0) & (CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR)) === 0 &&
    level.areas[(level.cells.area[i] ?? 0) - 1]?.kind !== "building";
  interface Seg {
    from: string;
    to: string;
    edge: ResolvedCliffRun["edges"][number];
    stair: boolean;
  }
  const segs: Seg[] = [];
  const add = (a: number, b: number, sideOfA: Side, sideOfB: Side, stair: boolean): void => {
    if (!usable(a) || !usable(b)) return;
    const ha = level.cells.height[a] ?? 0;
    const hb = level.cells.height[b] ?? 0;
    if (ha === hb) return;
    const [u, l, side] = ha > hb ? [a, b, sideOfA] : [b, a, sideOfB];
    if (!stair && (level.cells.height[u] ?? 0) - (level.cells.height[l] ?? 0) < minRise) return;
    const mu = mat(u);
    const ml = mat(l);
    if (!stair && !(mu !== null && isNaturalGround(mu)) && !(ml !== null && isNaturalGround(ml))) return;
    const x = bx + (u % w);
    const y = by + Math.floor(u / w);
    // clockwise round the upper cell: the upper ground is on the right of the segment
    const [p, q] =
      side === "N"
        ? [
            [x, y],
            [x + 1, y],
          ]
        : side === "E"
          ? [
              [x + 1, y],
              [x + 1, y + 1],
            ]
          : side === "S"
            ? [
                [x + 1, y + 1],
                [x, y + 1],
              ]
            : [
                [x, y + 1],
                [x, y],
              ];
    segs.push({
      from: `${p[0]},${p[1]}`,
      to: `${q[0]},${q[1]}`,
      edge: { at: [x, y], side, low: level.cells.height[l] ?? 0, high: level.cells.height[u] ?? 0 },
      stair,
    });
  };
  for (let ly = 1; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const k = level.hEdges.kind[hEdgeIndex(level.bounds, lx, ly)];
      if (k === EDGE.LEDGE || k === EDGE.STAIR) add(at(lx, ly - 1), at(lx, ly), "S", "N", k === EDGE.STAIR);
    }
  for (let ly = 0; ly < h; ly++)
    for (let lx = 1; lx < w; lx++) {
      const k = level.vEdges.kind[vEdgeIndex(level.bounds, lx, ly)];
      if (k === EDGE.LEDGE || k === EDGE.STAIR) add(at(lx - 1, ly), at(lx, ly), "E", "W", k === EDGE.STAIR);
    }
  const byStart = new Map<string, Seg[]>();
  const byEnd = new Map<string, Seg[]>();
  for (const s of segs) {
    byStart.set(s.from, [...(byStart.get(s.from) ?? []), s]);
    byEnd.set(s.to, [...(byEnd.get(s.to) ?? []), s]);
  }
  const used = new Set<Seg>();
  const runs: ResolvedCliffRun[] = [];
  const follow = (start: Seg): { chain: Seg[]; closed: boolean } => {
    const chain: Seg[] = [];
    let cur: Seg | undefined = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      chain.push(cur);
      // where terraces touch, several edges leave one corner: keep to the same step (same upper and lower ground),
      // then to the same direction
      const here: Seg = cur;
      const next = (byStart.get(here.to) ?? []).filter((s) => !used.has(s));
      const rank = (s: Seg): number =>
        (s.edge.high === here.edge.high ? 0 : 4) +
        (s.edge.low === here.edge.low ? 0 : 2) +
        (s.edge.side === here.edge.side ? 0 : 1);
      cur = next.sort((a, b) => rank(a) - rank(b))[0];
    }
    return { chain, closed: chain.length > 1 && chain[chain.length - 1]?.to === start.from };
  };
  // open runs first (from segments nothing leads into), then the loops that remain
  const order = [...segs].sort((p, q) => p.edge.at[1] - q.edge.at[1] || p.edge.at[0] - q.edge.at[0]);
  for (const pass of [0, 1])
    for (const s of order) {
      if (used.has(s) || (pass === 0 && (byEnd.get(s.from) ?? []).length > 0)) continue;
      // walk back to where the chain begins (or round a loop once), so a run is not cut where the scan met it
      let first = s;
      const back = new Set<Seg>([s]);
      for (;;) {
        const prev = (byEnd.get(first.from) ?? []).find((p) => !used.has(p) && !back.has(p));
        if (!prev) break;
        back.add(prev);
        first = prev;
      }
      const { chain, closed } = follow(first);
      // a run of stairs alone is not a cliff
      const cliff = chain.filter((c) => !c.stair);
      if (cliff.length === 0) continue;
      const rises = cliff.map((c) => c.edge.high - c.edge.low);
      runs.push({
        edges: chain.map((c) => c.edge),
        closed,
        minRise: Math.min(...rises),
        maxRise: Math.max(...rises),
        material: chain[0] ? mat(at(chain[0].edge.at[0] - bx, chain[0].edge.at[1] - by)) : null,
        crossings: chain.flatMap((c, k) => (c.stair ? [k] : [])),
      });
    }
  return runs;
}
