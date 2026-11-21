/**
 * Vertical span of a wall edge. It lives in resolve/ (not compile/) because every stage needs the same arithmetic: the
 * resolver settles wall heights with it (resolve/wallTops.ts, resolve/wallSettle.ts), realize places the pieces with it
 * and verify measures them with it, so all three agree on where a wall starts and stops.
 *
 *  - Base: the lower of the two floor tops (a wall between a pit and rock reaches down to the pit floor).
 *  - Top: the wall height above the HIGHER of (the two floor tops, the reference floor of the open side's area),
 *    where an area's reference floor is the height most of its floor cells have. So the wall at the end of a chasm
 *    cut into a cave rises to the cave's normal wall top instead of stopping a few tiles above the chasm floor
 *    (which left a hole above it), and a room's wall beside a sunken pit keeps the room's wall line.
 *  - Railings: an edge hosted on a bridge deck stands on the deck: base = deck top, top = base + height.
 */
import { CELL, CELL_FLAG, type ResolvedLevel } from "../contracts/resolved";

export interface SpanCell {
  open: boolean;
  floor: boolean;
  /** Relative floor height (tiles). */
  height: number;
  /** Display area index + 1 (0 = none). */
  area: number;
  flags: number;
}

/** The span view of a resolved level's cell at local (lx, ly); outside the level it is solid. */
export function spanCellOf(L: ResolvedLevel): (lx: number, ly: number) => SpanCell {
  const { w, h } = L.bounds;
  return (lx, ly) => {
    if (lx < 0 || ly < 0 || lx >= w || ly >= h)
      return { open: false, floor: false, height: 0, area: 0, flags: 0 };
    const i = ly * w + lx;
    const flags = L.cells.flags[i] ?? 0;
    const open = L.cells.state[i] === CELL.OPEN;
    return {
      open,
      floor: open && (flags & CELL_FLAG.NO_FLOOR) === 0 && (L.cells.material[i] ?? 0) > 0,
      height: (L.cells.height[i] ?? 0) / 4,
      area: L.cells.area[i] ?? 0,
      flags,
    };
  };
}

/** Reference floor height (tiles) per display area index + 1: the most common height of its floor cells (ties: higher). */
export function areaReferenceHeights(L: ResolvedLevel): Map<number, number> {
  const counts = new Map<number, Map<number, number>>();
  const n = L.bounds.w * L.bounds.h;
  for (let i = 0; i < n; i++) {
    const a = L.cells.area[i] ?? 0;
    if (a === 0 || L.cells.state[i] !== CELL.OPEN) continue;
    const f = L.cells.flags[i] ?? 0;
    if (f & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) continue;
    const h = L.cells.height[i] ?? 0;
    const m = counts.get(a) ?? new Map<number, number>();
    m.set(h, (m.get(h) ?? 0) + 1);
    counts.set(a, m);
  }
  const out = new Map<number, number>();
  for (const [a, m] of counts) {
    let best = 0;
    let bestN = -1;
    for (const [h, c] of m) if (c > bestN || (c === bestN && h > best)) [best, bestN] = [h, c];
    out.set(a, best / 4);
  }
  return out;
}

export function wallSpan(
  elevation: number,
  a: SpanCell,
  b: SpanCell,
  hostFirst: boolean,
  wallHeight: number,
  ref: ReadonlyMap<number, number>,
): { base: number; top: number } {
  const host = hostFirst ? a : b;
  const other = hostFirst ? b : a;
  const top = (c: SpanCell): number => elevation + c.height + 0.5;
  if (host.floor && (host.flags & CELL_FLAG.BRIDGE) !== 0 && (other.flags & CELL_FLAG.BRIDGE) === 0) {
    const base = top(host);
    return { base, top: base + wallHeight };
  }
  const tops = [a, b].filter((c) => c.floor).map(top);
  const base = tops.length ? Math.min(...tops) : elevation + 0.5;
  let hi = tops.length ? Math.max(...tops) : base;
  for (const c of [a, b]) {
    if (!c.open || c.area === 0) continue;
    const r = ref.get(c.area);
    if (r !== undefined) hi = Math.max(hi, elevation + r + 0.5);
  }
  return { base, top: hi + wallHeight };
}

/**
 * How far a wall's span reaches above `base + wallHeight`: the step between the floors it divides (the higher floor
 * top, or the reference floor of the open side, above the lower floor top). 0 on level ground. It does not depend on
 * the wall height itself.
 */
export function wallRise(
  elevation: number,
  a: SpanCell,
  b: SpanCell,
  hostFirst: boolean,
  wallHeight: number,
  ref: ReadonlyMap<number, number>,
): number {
  const span = wallSpan(elevation, a, b, hostFirst, wallHeight, ref);
  return span.top - wallHeight - span.base;
}
