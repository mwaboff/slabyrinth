/**
 * Solid mass, shared. Two systems fill the solid cells behind a wall so nothing
 * reads hollow: the interior shell (compile/shell.ts: a flat cap and a skirt behind built walls) and the cave rock mass
 * (gen/cavewall.ts: stacked rock behind natural walls). They answer the same questions, so the answers live here and
 * both ask:
 *
 *  - how deep is a solid cell behind the wall, and which wall face is nearest (`massDepth`);
 *  - where does a rock cell stand: its foot is never above the foot of a shallower neighbour, so the mass reaches down
 *    to the lowest floor beside it wherever floors step (`massFoot`; the review measures the same rule);
 *  - which of the two dressers owns a solid cell, so a level that mixes built rooms and cave chambers leaves no gutter
 *    of nothing between them and no cell dressed twice (`ownSolid`);
 *  - cell-set cleanup: teeth, notches, holes, isolated lumps and single-cell nubs (`trimTeeth`, `fillNotches`,
 *    `dropLumps`, `inBlock2x2`), used by the shell's cap and by the cave outline.
 *
 * Pure: grids are flat row-major arrays, cells are local indices, `-1` is outside. No stage imports.
 */

/** The four sides of a cell as offsets (N, E, S, W order matches `orthNeighbours`). */
export const ORTH: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export interface CellGrid {
  w: number;
  h: number;
}

/** Local index of (x, y), or -1 outside the grid. */
export function cellAt(g: CellGrid, x: number, y: number): number {
  return x < 0 || y < 0 || x >= g.w || y >= g.h ? -1 : y * g.w + x;
}

/** The cells N, E, S, W of `i` (-1 where outside the grid). */
export function orthNeighbours(g: CellGrid, i: number): number[] {
  const x = i % g.w;
  const y = (i - x) / g.w;
  return [cellAt(g, x, y - 1), cellAt(g, x + 1, y), cellAt(g, x, y + 1), cellAt(g, x - 1, y)];
}

// ───────────────────────── depth and foot ─────────────────────────

/**
 * Depth of every solid cell behind a wall: the seeds (the cells that stand against the wall, or against the floor) are
 * depth 1, each step through solid cells (four-neighbour) one deeper; 0 = not reached. `nearest` is the index into
 * `seeds` of the seed a cell was reached from (-1 = not reached).
 */
export function massDepth(
  g: CellGrid,
  solid: (i: number) => boolean,
  seeds: readonly number[],
): { depth: Int16Array; nearest: Int32Array } {
  const depth = new Int16Array(g.w * g.h);
  const nearest = new Int32Array(g.w * g.h).fill(-1);
  let frontier: number[] = [];
  seeds.forEach((s, k) => {
    depth[s] = 1;
    nearest[s] = k;
    frontier.push(s);
  });
  for (let dd = 2; frontier.length > 0; dd++) {
    const next: number[] = [];
    for (const i of frontier) {
      // E, W, S, N: where two seeds reach a cell on the same step the first in this order claims it (kept as built)
      const x = i % g.w;
      const y = (i - x) / g.w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const j = cellAt(g, x + dx, y + dy);
        if (j < 0 || !solid(j) || depth[j] !== 0) continue;
        depth[j] = dd;
        nearest[j] = nearest[i] as number;
        next.push(j);
      }
    }
    frontier = next;
  }
  return { depth, nearest };
}

/**
 * The foot of the rock at every reached cell (`depth` > 0): `own(i)` where it stands against the wall, never above the
 * foot of a shallower four-neighbour. The mass therefore reaches down to the lowest ground beside it wherever floors
 * step, and no gap opens under the rock behind a low stretch of floor. Cells are settled shallowest first (ties by
 * index), so the result does not depend on the order cells are listed.
 */
export function massFoot(g: CellGrid, depth: ArrayLike<number>, own: (i: number) => number): Float64Array {
  const foot = new Float64Array(g.w * g.h);
  const byDepth: number[] = [];
  for (let i = 0; i < g.w * g.h; i++) if ((depth[i] as number) > 0) byDepth.push(i);
  byDepth.sort((a, b) => (depth[a] as number) - (depth[b] as number) || a - b);
  for (const i of byDepth) {
    let v = own(i);
    for (const j of orthNeighbours(g, i)) {
      if (j < 0) continue;
      const dj = depth[j] as number;
      if (dj > 0 && dj < (depth[i] as number)) v = Math.min(v, foot[j] as number);
    }
    foot[i] = v;
  }
  return foot;
}

// ───────────────────────── who owns a solid cell ─────────────────────────

export const OWNER = { none: 0, rock: 1, built: 2 } as const;

/**
 * Which dresser owns each solid cell: the one whose wall is nearest (steps through solid cells). Natural rock walls
 * (`rockSeeds`) are dressed by the cave rock mass, built walls (`builtSeeds`) by the shell, and a cell is dressed by
 * one of them only, so the two meet without a gutter and never overlap. Equidistant cells go to the built side (the
 * thin cap keeps its line). A cell reached by neither stays `none`: either dresser may take it, as before. With no
 * seeds of one kind nothing is taken from the other (a level of only caves, or only rooms, is unchanged).
 */
export function ownSolid(
  g: CellGrid,
  solid: (i: number) => boolean,
  rockSeeds: readonly number[],
  builtSeeds: readonly number[],
): Uint8Array {
  const owner = new Uint8Array(g.w * g.h);
  let built: number[] = [];
  let rock: number[] = [];
  for (const i of builtSeeds)
    if (owner[i] === 0) {
      owner[i] = OWNER.built;
      built.push(i);
    }
  for (const i of rockSeeds)
    if (owner[i] === 0) {
      owner[i] = OWNER.rock;
      rock.push(i);
    }
  while (built.length > 0 || rock.length > 0) {
    const nb: number[] = [];
    const nr: number[] = [];
    for (const [front, kind, out] of [
      [built, OWNER.built, nb],
      [rock, OWNER.rock, nr],
    ] as const)
      for (const i of front)
        for (const j of orthNeighbours(g, i)) {
          if (j < 0 || !solid(j) || owner[j] !== 0) continue;
          owner[j] = kind;
          out.push(j);
        }
    built = nb;
    rock = nr;
  }
  return owner;
}

// ───────────────────────── cell-set cleanup ─────────────────────────

/**
 * Is the cell in a 2×2 block of cells `member` calls true (-1, outside the grid, is passed to `member` too)? A cell that
 * is not is a single-cell nub or a one-cell-wide strip.
 */
export function inBlock2x2(g: CellGrid, i: number, member: (j: number) => boolean): boolean {
  const x = i % g.w;
  const y = (i - x) / g.w;
  for (const [ox, oy] of [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ] as const) {
    let all = true;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      if (!member(cellAt(g, x + ox + dx, y + oy + dy))) {
        all = false;
        break;
      }
    if (all) return true;
  }
  return false;
}

/** Teeth: a cell of the set with at most one four-neighbour in the set goes, when `removable` says it may. */
export function trimTeeth(
  g: CellGrid,
  set: Map<number, number>,
  removable: (i: number, v: number) => boolean,
): void {
  for (const [i, v] of [...set]) {
    if (!removable(i, v)) continue;
    if (orthNeighbours(g, i).filter((k) => set.has(k)).length <= 1) set.delete(i);
  }
}

/**
 * Notches and holes: a cell outside the set (and `eligible`) with set cells on both sides of a line, or on three
 * sides, joins it. `fill(i, near)` gives its value, `near` being the first four-neighbour (N, E, S, W) already in the
 * set, found as the cells are added.
 */
export function fillNotches(
  g: CellGrid,
  set: Map<number, number>,
  eligible: (i: number) => boolean,
  fill: (i: number, near: number) => number,
  passes = 3,
): void {
  for (let pass = 0; pass < passes; pass++) {
    const add: number[] = [];
    for (let k = 0; k < g.w * g.h; k++) {
      if (set.has(k) || !eligible(k)) continue;
      const [n, e, s, wst] = orthNeighbours(g, k).map((q) => set.has(q));
      const count = [n, e, s, wst].filter(Boolean).length;
      if (count >= 3 || (n && s) || (e && wst)) add.push(k);
    }
    if (add.length === 0) break;
    for (const k of add) {
      const near = orthNeighbours(g, k).find((q) => set.has(q)) as number;
      set.set(k, fill(k, near));
    }
  }
}

/**
 * Isolated lumps: eight-connected components of the set that hold no `anchored` cell, or fewer than `minSize` cells,
 * are dropped.
 */
export function dropLumps(
  g: CellGrid,
  set: Map<number, number>,
  anchored: (i: number, v: number) => boolean,
  minSize: number,
): void {
  const seen = new Set<number>();
  for (const start of [...set.keys()]) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      comp.push(i);
      const x = i % g.w;
      const y = (i - x) / g.w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = cellAt(g, x + dx, y + dy);
          if (k >= 0 && set.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push(k);
          }
        }
    }
    if (!comp.some((i) => anchored(i, set.get(i) as number)) || comp.length < minSize)
      for (const i of comp) set.delete(i);
  }
}
