/**
 * What hides a cliff face (shared by the rock band, the realizer's "is this edge covered" test and the design review).
 *
 * A face is hidden when, at the middle of the edge cell and 0.4 either side along it, rock pieces whose real outline
 * (a rotated rectangle of the asset's size, slid by its offset) contains that point, between them, stand over the whole
 * height of the face: from the low ground up to the upper ground, gaps of at most 0.3 tile. A rock merely standing in a
 * footprint cell next to the edge does not count (the old test, which called a face covered when any piece's box came
 * within 0.3 of the edge midpoint and so passed boxes whose rock was elsewhere, or whose top stopped halfway).
 */

/** One rock piece as it stands: centre (cells), turn (degrees), outline size (tiles) and its vertical span. */
export interface RockShape {
  cx: number;
  cy: number;
  rot: number;
  w: number;
  d: number;
  base: number;
  top: number;
}

/** Whether the point lies inside the piece's outline grown by `pad`. */
export function shapeHas(s: RockShape, x: number, y: number, pad: number): boolean {
  const r = (s.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const n = Math.sin(r);
  const u = (x - s.cx) * c + (y - s.cy) * n;
  const v = -(x - s.cx) * n + (y - s.cy) * c;
  return Math.abs(u) <= s.w / 2 + pad && Math.abs(v) <= s.d / 2 + pad;
}

/**
 * How much of each terrace's walkable ground the rock stands on. A cell counts as covered when at least two of five
 * sample points (the middle and four quarter points) lie inside the outline of a rock that stands on that ground
 * (its base within 0.6 tile of the cell's height). Terraces are the ground heights rounded to whole tiles; those with
 * fewer than `minCells` cells are left out.
 */
export function terraceRockShare(
  shapes: ReadonlyArray<RockShape>,
  cells: ReadonlyArray<{ x: number; y: number; ground: number }>,
  minCells = 20,
): Array<{ terrace: number; cells: number; covered: number; share: number }> {
  const SAMPLES: ReadonlyArray<readonly [number, number]> = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  const by = new Map<number, { cells: number; covered: number }>();
  for (const c of cells) {
    const k = Math.round(c.ground);
    const e = by.get(k) ?? { cells: 0, covered: 0 };
    e.cells++;
    const near = shapes.filter(
      (s) => Math.abs(s.base - c.ground) <= 0.6 && Math.hypot(s.cx - c.x - 0.5, s.cy - c.y - 0.5) <= Math.max(s.w, s.d),
    );
    if (near.length > 0) {
      let hit = 0;
      for (const [qx, qy] of SAMPLES) if (near.some((s) => shapeHas(s, c.x + qx, c.y + qy, 0))) hit++;
      if (hit >= 2) e.covered++;
    }
    by.set(k, e);
  }
  return [...by]
    .filter(([, e]) => e.cells >= minCells)
    .map(([terrace, e]) => ({ terrace, cells: e.cells, covered: e.covered, share: e.covered / e.cells }))
    .sort((a, b) => a.terrace - b.terrace);
}

/** A palette variant as the tone rule sees it. */
export interface ToneVariant {
  tone?: "dark" | "mid" | "light";
  weight: number;
}

/**
 * One rock tone per cliff (generator 3). `own` is the role's pieces (the face rocks, say) and `other` the paired
 * role's (the boulders). When both roles have pieces tagged with a common tone, the tone with the most pieces across
 * the two wins and `own` is narrowed to it. When they share none, `own` keeps its own most numerous tone (the family
 * with the most pieces) and `missing` names the tone the paired role would need. Untagged pieces count for nothing:
 * with no tags on `own` the pool is returned unchanged (tone unknown, nothing to match).
 */
export function matchTone<T extends ToneVariant>(
  own: readonly T[],
  other: readonly T[],
): { pool: readonly T[]; tone?: string; missing?: string } {
  const tally = (list: readonly T[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const v of list) if (v.weight > 0 && v.tone) m.set(v.tone, (m.get(v.tone) ?? 0) + 1);
    return m;
  };
  const mine = tally(own);
  if (mine.size === 0) return { pool: own };
  const theirs = tally(other);
  let best: string | undefined;
  let bestN = 0;
  for (const [t, n] of mine) {
    const both = theirs.get(t);
    if (both === undefined) continue;
    if (n + both > bestN) {
      best = t;
      bestN = n + both;
    }
  }
  if (best !== undefined) return { pool: own.filter((v) => v.tone === best), tone: best };
  let top = "";
  let topN = 0;
  for (const [t, n] of mine)
    if (n > topN) {
      top = t;
      topN = n;
    }
  return {
    pool: own.filter((v) => v.tone === top),
    tone: top,
    ...(theirs.size > 0 ? { missing: top } : {}),
  };
}

/** The tone families (distinct tags of the pieces that can be picked) in a pool; untagged pieces count for nothing. */
export function toneFamilies(pool: readonly ToneVariant[]): string[] {
  return [...new Set(pool.filter((v) => v.weight > 0 && v.tone).map((v) => v.tone as string))].sort();
}

/**
 * One rock tone per cliff (generator 3). The face piece decides: a cliff never loses its face rock for tone. The
 * boulders and nearby formations then match it where the palette has a piece of that tone; where it has none they keep
 * their own tone (the realizer falls back to the other-tone boulders, and the review notes it). Only a palette with no
 * tagged face piece lets the boulders' tone decide; with no tags at all nothing is decided. Both kinds are always built.
 */
export function cliffRockKinds(
  face: readonly ToneVariant[],
  crest: readonly ToneVariant[],
): { tone?: string; face: boolean; crest: boolean } {
  const tally = (list: readonly ToneVariant[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const v of list) if (v.weight > 0 && v.tone) m.set(v.tone, (m.get(v.tone) ?? 0) + 1);
    return m;
  };
  const f = tally(face);
  const c = tally(crest);
  const top = (m: Map<string, number>): string | undefined =>
    [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const tone = f.size > 0 ? top(f) : top(c);
  return { ...(tone !== undefined ? { tone } : {}), face: true, crest: true };
}

export const COVER = {
  /** Samples along the edge cell, either side of the middle (cells). */
  along: 0.4,
  /** The outline is grown by this much before a sample counts as inside. */
  pad: 0.1,
  /** Largest vertical gap between pieces that still hides the face (tiles). */
  gap: 0.3,
  /** The face is judged from this far above the low ground to this far below the upper ground (tiles). */
  trim: 0.3,
} as const;

/**
 * True when the face at the edge midpoint (mx, my), running along the unit vector (ax, ay), from ground `lo` up to
 * ground `hi` (absolute tiles, the same scale as the shapes' base and top), is hidden by `shapes`.
 */
export function edgeHidden(
  shapes: ReadonlyArray<RockShape>,
  mx: number,
  my: number,
  ax: number,
  ay: number,
  lo: number,
  hi: number,
): boolean {
  const from = lo + Math.min(COVER.trim, (hi - lo) / 3);
  const to = hi - Math.min(COVER.trim, (hi - lo) / 3);
  for (const k of [0, -COVER.along, COVER.along]) {
    const px = mx + ax * k;
    const py = my + ay * k;
    const spans = shapes
      .filter((s) => shapeHas(s, px, py, COVER.pad))
      .map((s) => [s.base, s.top] as const)
      .sort((p, q) => p[0] - q[0]);
    let reach = from;
    for (const [b, t] of spans) {
      if (b > reach + COVER.gap) break;
      if (t > reach) reach = t;
    }
    if (reach < to) return false;
  }
  return true;
}
