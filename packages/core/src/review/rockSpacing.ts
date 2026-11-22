/**
 * How evenly the band's rocks stand along an edge (the "fence" of cliff boulders). A skilled builder sets rock in
 * clusters with clear gaps and stretches with none; a generator that steps along a lip at a near-constant interval
 * makes a row of teeth. Pure geometry over the pieces' centres, shared by the design review and the proofs.
 *
 * Rocks of one kind are linked when their centres are within `link` tiles; each linked chain is walked end to end
 * (nearest unvisited neighbour from an end). A chain of `minRun` or more rocks whose gaps all lie within
 * `spread` of their median is a fence run: the same step over and over.
 */

export interface RockAt {
  x: number;
  y: number;
}

export interface FenceRun {
  /** Rocks in the run. */
  n: number;
  /** Median gap between neighbours (tiles). */
  gap: number;
  /** Centres in walking order. */
  points: RockAt[];
}

export interface FenceRule {
  /** Link distance (tiles): a gap wider than this ends a chain, so clusters stay apart. */
  link: number;
  /** Fewest rocks in a run (clusters are two to five; a row is longer). */
  minRun: number;
  /**
   * "teeth": every gap lies in [gapMin, link], i.e. separate pieces standing at a steady interval (boulders overlap
   * in a group; a gap of about a boulder's width or more reads as a tooth).
   * "step": every gap within `spread` of the run's median (overlapping long pieces laid at one constant step).
   */
  mode: "teeth" | "step";
  gapMin: number;
  spread: number;
}

/** The rules by rock kind (design review `cliff_even_spacing`). */
export const FENCE: Readonly<Record<string, FenceRule>> = {
  cliff_crest: { link: 3.6, minRun: 5, mode: "teeth", gapMin: 1.4, spread: 0 },
  cliff_face: { link: 4.6, minRun: 7, mode: "step", gapMin: 0, spread: 0.2 },
};

/** Rocks closer than this are one pile (stacked on one spot), not neighbours. */
const PILE = 0.6;

const dist = (a: RockAt, b: RockAt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Chains of rocks (linked within `link`), each walked from an end. */
export function chains(points: readonly RockAt[], link: number): RockAt[][] {
  const seen = new Array<boolean>(points.length).fill(false);
  const near = (i: number): number[] => {
    const p = points[i] as RockAt;
    const r: number[] = [];
    for (let j = 0; j < points.length; j++) if (j !== i && dist(p, points[j] as RockAt) <= link) r.push(j);
    return r;
  };
  const out: RockAt[][] = [];
  for (let s = 0; s < points.length; s++) {
    if (seen[s]) continue;
    // the component by flood fill
    const comp: number[] = [];
    const stack = [s];
    seen[s] = true;
    while (stack.length) {
      const i = stack.pop() as number;
      comp.push(i);
      for (const j of near(i))
        if (!seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
    }
    // walk from the end farthest from the first member, always to the nearest unvisited neighbour
    let start = comp[0] as number;
    let far = -1;
    for (const i of comp) {
      const d = dist(points[i] as RockAt, points[s] as RockAt);
      if (d > far) {
        far = d;
        start = i;
      }
    }
    const left = new Set(comp);
    const walk: RockAt[] = [];
    let cur = start;
    left.delete(cur);
    walk.push(points[cur] as RockAt);
    while (left.size) {
      let best = -1;
      let bd = Infinity;
      for (const j of left) {
        const d = dist(points[cur] as RockAt, points[j] as RockAt);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      if (best < 0 || bd > link) break;
      left.delete(best);
      cur = best;
      walk.push(points[cur] as RockAt);
    }
    out.push(walk);
  }
  return out;
}

/** The fence runs among rocks of one kind (centres in tiles). */
export function fenceRuns(points: readonly RockAt[], rule: FenceRule): FenceRun[] {
  const runs: FenceRun[] = [];
  for (const raw of chains(points, rule.link)) {
    // a pile counts once
    const walk: RockAt[] = [];
    for (const p of raw) {
      const last = walk[walk.length - 1];
      if (!last || dist(last, p) >= PILE) walk.push(p);
    }
    if (walk.length < rule.minRun) continue;
    const gaps: number[] = [];
    for (let i = 1; i < walk.length; i++) gaps.push(dist(walk[i - 1] as RockAt, walk[i] as RockAt));
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    if (rule.mode === "step" && median < 1.4) continue;
    const ok = (g: number): boolean =>
      rule.mode === "teeth"
        ? g >= rule.gapMin && g <= rule.link
        : Math.abs(g - median) <= rule.spread * median;
    // the longest stretch of consecutive gaps that all qualify
    let bestStart = 0;
    let bestLen = 0;
    let st = 0;
    for (let i = 0; i <= gaps.length; i++) {
      if (i === gaps.length || !ok(gaps[i] as number)) {
        if (i - st > bestLen) {
          bestLen = i - st;
          bestStart = st;
        }
        st = i + 1;
      }
    }
    if (bestLen + 1 >= rule.minRun)
      runs.push({ n: bestLen + 1, gap: median, points: walk.slice(bestStart, bestStart + bestLen + 1) });
  }
  return runs;
}

/** Share of the rocks of one kind (and how many) that stand in fence runs. */
export function fenceShare(
  points: readonly RockAt[],
  rule: FenceRule,
): { rocks: number; inRuns: number; share: number; runs: FenceRun[] } {
  const runs = fenceRuns(points, rule);
  const inRuns = runs.reduce((a, r) => a + r.n, 0);
  return { rocks: points.length, inRuns, share: points.length === 0 ? 0 : inRuns / points.length, runs };
}
