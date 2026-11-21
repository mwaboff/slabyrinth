/**
 * Generator 4: ragged cave outlines. A chamber or corridor drawn as a rectangle (or a coarse polygon) in a level whose
 * walls are natural rock reads as a box cut into the rock: straight sides, square corners. This pass bulges the outline
 * out into the rock and bites it in, in broad seeded waves (value noise, about three cells across), so the chamber
 * reads as a natural cave, then breaks any straight run of wall longer than MAX_STRAIGHT cells.
 *
 * Rules that keep the map playable and the rock intact:
 *  - a bulge never comes within `edgeMargin` cells of the level's edge, nor within `areaGap` cells of another area's
 *    floor (the rock between them stays at least two cells thick, so the wall can still be built as rock mass);
 *  - bulges and bites are at least two cells wide (single-cell nubs of floor or rock are undone);
 *  - a bite never touches a protected cell (explicit features, openings, links, terrain-op shapes, zones), never a
 *    cell beside another area's floor, never narrows a passage below two cells (every floor cell that stood in a 2×2
 *    block of floor still does) and never splits the open floor (the number of connected floor pieces stays).
 *
 * Pure: it reads the grid through callbacks and returns the cells to open and to close; the level resolver applies
 * them. Arithmetic and value noise only (architecture §2.5).
 */
import { NEIGHBOURS4 } from "../gen/gridGeometry";
import { ValueNoise } from "../gen/noise";
import { inBlock2x2 } from "../gen/solidMass";
import { h32, subSeed } from "../util/hash";
import { MAX_STRAIGHT } from "./organic";

export interface OutlineGrid {
  w: number;
  h: number;
  /** Area owner of a local cell: 0 = none (rock or ground), k = area index + 1. */
  owner: (i: number) => number;
  /** Open floor (any owner) at a local cell. */
  open: (i: number) => boolean;
  /** Plain rock a bulge may open: solid, owned by no area. */
  rock: (i: number) => boolean;
  /** Cells a bite must keep (features, openings, links, terrain-op shapes, zones). */
  keep: (i: number) => boolean;
}

export const CAVE_OUTLINE = {
  /** Noise scale (cells) and the stretched noise thresholds for a bulge, a second ring of bulge, a bite, a deeper bite. */
  scale: 2.6,
  bulge: 0.2,
  bulgeDeep: 0.55,
  bite: -0.25,
  biteDeep: -0.6,
  /** Cells kept between a bulge and the level edge, and (Chebyshev) between a bulge and another area's floor. */
  edgeMargin: 3,
  areaGap: 3,
  /** Rounds of breaking straight runs. */
  rounds: 4,
} as const;

const N4 = NEIGHBOURS4;

/** The eight cells round a cell in order, each 4-adjacent to the next (corners and sides alternate). */
const RING: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/**
 * The local test for "removing this floor cell cannot split the floor". `open(dx, dy)` says whether the cell at that
 * offset is floor. When the cell has at least one floor side-neighbour and all of them are joined to each other through
 * floor in the 3×3 window round it, any path that ran through the cell can run round it instead, so the number of floor
 * pieces is unchanged. False means "not shown by the window" (an isolated cell, or neighbours that join only by a longer
 * way): the caller confirms with a flood. Sufficient, never necessary.
 */
export function windowKeepsJoined(open: (dx: number, dy: number) => boolean): boolean {
  const on = RING.map(([dx, dy]) => open(dx, dy));
  const sides = [1, 3, 5, 7].filter((k) => on[k]);
  if (sides.length === 0) return false;
  // the open cells of the ring joined along the ring: one walk round the cycle from the first open side
  const seen = new Array<boolean>(8).fill(false);
  const start = sides[0] as number;
  const stack = [start];
  seen[start] = true;
  while (stack.length > 0) {
    const k = stack.pop() as number;
    for (const j of [(k + 1) % 8, (k + 7) % 8])
      if (on[j] && !seen[j]) {
        seen[j] = true;
        stack.push(j);
      }
  }
  return sides.every((k) => seen[k]);
}

/**
 * Ragged outline of one area (`area` = index + 1). `cells` are its open cells (local indices). Returns the cells to
 * open (claimed by the area) and to close (back to rock). Deterministic in `seed`.
 */
export function raggedCaveOutline(
  grid: OutlineGrid,
  area: number,
  cells: readonly number[],
  seed: number,
): { open: number[]; close: number[] } {
  const { w, h } = grid;
  const xy = (i: number): [number, number] => [i % w, Math.floor(i / w)];
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x);
  const noise = new ValueNoise(subSeed(seed, "caveoutline"));
  const fine = new ValueNoise(subSeed(seed, "caveoutline:fine"));
  const m = (i: number): number => {
    const [x, y] = xy(i);
    const n =
      noise.sample(x / CAVE_OUTLINE.scale, y / CAVE_OUTLINE.scale) * 0.75 +
      fine.sample(x / 1.4, y / 1.4) * 0.25;
    return Math.max(-1, Math.min(1, (n - 0.5) * 3.6));
  };

  // the working state: + opened, - closed, relative to the grid
  const opened = new Set<number>();
  const closed = new Set<number>();
  const isOpen = (i: number): boolean => i >= 0 && (opened.has(i) || (grid.open(i) && !closed.has(i)));
  const mine = (i: number): boolean =>
    i >= 0 && (opened.has(i) || (grid.owner(i) === area && grid.open(i) && !closed.has(i)));
  const otherFloorNear = (i: number, r: number): boolean => {
    const [x, y] = xy(i);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const j = at(x + dx, y + dy);
        if (j >= 0 && grid.open(j) && grid.owner(j) !== area) return true;
      }
    return false;
  };
  const canOpen = (i: number): boolean => {
    if (i < 0 || !grid.rock(i) || opened.has(i)) return false;
    const [x, y] = xy(i);
    const e = CAVE_OUTLINE.edgeMargin;
    if (x < e || y < e || x >= w - e || y >= h - e) return false;
    return !otherFloorNear(i, CAVE_OUTLINE.areaGap);
  };
  const canClose = (i: number): boolean =>
    i >= 0 &&
    grid.owner(i) === area &&
    grid.open(i) &&
    !closed.has(i) &&
    !grid.keep(i) &&
    !otherFloorNear(i, 1);
  const n4 = (i: number): number[] => {
    const [x, y] = xy(i);
    return N4.map(([dx, dy]) => at(x + dx, y + dy));
  };
  // a cell in a 2×2 block of floor (passage width two or more)
  // (gen/solidMass.ts: the same single-cell-nub rule the interior shell's cleanup uses)
  const inBlock = (i: number, open: (j: number) => boolean): boolean => inBlock2x2({ w, h }, i, open);
  const wide = new Set<number>();
  for (const i of cells) if (inBlock(i, isOpen)) wide.add(i);
  // connected floor pieces of the whole level (4-neighbour)
  const pieces = (): number => {
    const seen = new Uint8Array(w * h);
    let n = 0;
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || !isOpen(s)) continue;
      n++;
      const stack = [s];
      seen[s] = 1;
      while (stack.length > 0) {
        const c = stack.pop() as number;
        for (const j of n4(c))
          if (j >= 0 && !seen[j] && isOpen(j)) {
            seen[j] = 1;
            stack.push(j);
          }
      }
    }
    return n;
  };
  const basePieces = pieces();
  const widthOk = (i: number): boolean => {
    const [x, y] = xy(i);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const j = at(x + dx, y + dy);
        if (j >= 0 && wide.has(j) && isOpen(j) && !inBlock(j, isOpen)) return false;
      }
    return true;
  };
  const tryClose = (i: number): boolean => {
    if (!canClose(i)) return false;
    closed.add(i);
    // closing never splits the floor: decided by the cell's own 3×3 window when that is enough (nearly always, on a
    // chamber's rim); the flood over the whole level only settles the cases the window cannot (a pinch where the
    // neighbours join the long way round), so a long outline costs a window per cell, not a level per cell
    if (!widthOk(i) || (!staysJoined(i) && pieces() !== basePieces)) {
      closed.delete(i);
      return false;
    }
    return true;
  };
  /** True when taking floor cell `i` away provably leaves the floor in as many pieces: see `windowKeepsJoined`. */
  const staysJoined = (i: number): boolean => {
    const [x, y] = xy(i);
    return windowKeepsJoined((dx, dy) => {
      const j = at(x + dx, y + dy);
      return j >= 0 && isOpen(j);
    });
  };
  const boundary = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < w * h; i++) if (mine(i) && n4(i).some((j) => j >= 0 && !isOpen(j))) out.push(i);
    return out;
  };
  const rim = (): number[] => {
    const out = new Set<number>();
    for (const i of boundary()) for (const j of n4(i)) if (canOpen(j)) out.add(j);
    return [...out].sort((a, b) => a - b);
  };

  // 1. bulges: a ring of rock where the noise is high, and a second ring where it is higher
  for (const j of rim()) if (m(j) > CAVE_OUTLINE.bulge) opened.add(j);
  for (const j of rim()) if (m(j) > CAVE_OUTLINE.bulgeDeep && n4(j).some((k) => opened.has(k))) opened.add(j);
  // 2. bites: floor on the outline where the noise is low, then a second cell in where it is lower
  const original = boundary().filter((i) => !opened.has(i));
  for (const i of original) if (m(i) < CAVE_OUTLINE.bite) tryClose(i);
  for (const i of boundary())
    if (!opened.has(i) && m(i) < CAVE_OUTLINE.biteDeep && n4(i).some((k) => closed.has(k))) tryClose(i);
  tidy();

  // 3. straight runs of wall longer than MAX_STRAIGHT: a bulge or a bite every 3-4 cells
  for (let round = 0; round < CAVE_OUTLINE.rounds; round++) {
    let edited = false;
    for (const run of straightRuns()) {
      let hsh = h32(`${seed}:run:${round}:${run.cells[0]}:${run.side}`);
      for (let k = 2 + (hsh % 2); k < run.cells.length - 1; k += 3 + ((hsh >>> 4) % 2)) {
        hsh = h32(`${hsh}`);
        const i = run.cells[k] as number;
        const [x, y] = xy(i);
        const [dx, dy] = N4[run.side] as readonly [number, number];
        const out = at(x + dx, y + dy);
        const alongX = dx === 0 ? 1 : 0;
        const alongY = dx === 0 ? 0 : 1;
        const out2 = at(x + dx + alongX, y + dy + alongY);
        const in2 = at(x + alongX, y + alongY);
        const bulgeFirst = (hsh >>> 3) % 3 !== 0;
        const bulge = (): boolean => {
          if (!canOpen(out) || !canOpen(out2)) return false;
          opened.add(out);
          opened.add(out2);
          return true;
        };
        const bite = (): boolean => {
          if (!tryClose(i)) return false;
          if (!tryClose(in2)) {
            closed.delete(i);
            return false;
          }
          return true;
        };
        if (bulgeFirst ? bulge() || bite() : bite() || bulge()) edited = true;
      }
    }
    tidy();
    if (!edited) break;
  }
  return {
    open: [...opened].sort((a, b) => a - b),
    close: [...closed].sort((a, b) => a - b),
  };

  /** Undo single-cell nubs: opened floor outside every 2×2 floor block, closed rock outside every 2×2 rock block. */
  function tidy(): void {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const i of [...opened])
        if (!inBlock(i, isOpen)) {
          opened.delete(i);
          changed = true;
        }
      for (const i of [...closed])
        if (!inBlock(i, (j) => j < 0 || !isOpen(j))) {
          closed.delete(i);
          changed = true;
        }
      if (!changed) break;
    }
  }

  /** Runs of the area's outline cells along one straight line of wall (rock on side `side`, index into N4). */
  function straightRuns(): Array<{ side: number; cells: number[] }> {
    const out: Array<{ side: number; cells: number[] }> = [];
    const edge = new Set<string>();
    for (const i of boundary()) {
      const nb = n4(i);
      for (let s = 0; s < 4; s++) {
        const j = nb[s] as number;
        if (j >= 0 && !isOpen(j)) edge.add(`${i}:${s}`);
      }
    }
    const done = new Set<string>();
    for (const k of [...edge].sort()) {
      if (done.has(k)) continue;
      const [i0, s] = k.split(":").map(Number) as [number, number];
      const [dx] = N4[s] as readonly [number, number];
      const ax = dx === 0 ? 1 : 0;
      const ay = dx === 0 ? 0 : 1;
      // walk back to the start of the run, then forward
      let [x, y] = xy(i0);
      while (edge.has(`${at(x - ax, y - ay)}:${s}`)) {
        x -= ax;
        y -= ay;
      }
      const run: number[] = [];
      while (edge.has(`${at(x, y)}:${s}`)) {
        const c = at(x, y);
        run.push(c);
        done.add(`${c}:${s}`);
        x += ax;
        y += ay;
      }
      if (run.length > MAX_STRAIGHT) out.push({ side: s, cells: run });
    }
    return out;
  }
}
