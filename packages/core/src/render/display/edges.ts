/**
 * Lines along cell edges: low ledges and the grid (merged into runs), cliffs (one directed segment per edge), and
 * bridge decks.
 */
import type { DisplayItem, ResolvedLevel } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { hEdgeIndex, vEdgeIndex } from "../../resolve/levelGrid";
import type { DisplayCtx } from "./context";
import { cellRings } from "./rings";
import { maxOf, minOf } from "../../util/lists";

/** A drop of at least this many quarter tiles is a cliff (drawn with hachures), a lower one a ledge line. */
const CLIFF_HEIGHT = 1;

type EdgeGrid = ResolvedLevel["hEdges"];

/**
 * Runs of consecutive edges passing `test` (horizontal edges row by row, then vertical edges column by column), as
 * open two-point segments. `test` gets the edge grid, the edge index and the cells on either side (a before b; -1
 * outside the level).
 */
function edgeRuns(
  c: DisplayCtx,
  test: (g: EdgeGrid, e: number, a: number, b: number) => boolean,
): number[][] {
  const { bx, by, w, h, level } = c;
  const runs: number[][] = [];
  for (let ly = 0; ly <= h; ly++) {
    let start = -1;
    for (let lx = 0; lx <= w; lx++) {
      const on =
        lx < w &&
        test(level.hEdges, hEdgeIndex(level.bounds, lx, ly), c.cellAt(lx, ly - 1), c.cellAt(lx, ly));
      if (on && start < 0) start = lx;
      if (!on && start >= 0) {
        runs.push([bx + start, by + ly, bx + lx, by + ly]);
        start = -1;
      }
    }
  }
  for (let lx = 0; lx <= w; lx++) {
    let start = -1;
    for (let ly = 0; ly <= h; ly++) {
      const on =
        ly < h &&
        test(level.vEdges, vEdgeIndex(level.bounds, lx, ly), c.cellAt(lx - 1, ly), c.cellAt(lx, ly));
      if (on && start < 0) start = ly;
      if (!on && start >= 0) {
        runs.push([bx + lx, by + start, bx + lx, by + ly]);
        start = -1;
      }
    }
  }
  return runs;
}

/** Height steps lower than a cliff, merged into runs. */
export function ledgeItems(c: DisplayCtx): DisplayItem[] {
  const rings = edgeRuns(c, (g, e) => g.kind[e] === EDGE.LEDGE && (g.height[e] as number) < CLIFF_HEIGHT);
  return rings.length > 0 ? [{ layer: "ledge", style: "ledge", geom: { rings, closed: false } }] : [];
}

/**
 * Cliffs (drops of a tile or more): one segment per edge, directed so the LOW side is on its right (screen
 * coordinates, y down); the renderer draws the cliff line with hachures toward the low side.
 */
export function cliffItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, w, h, level } = c;
  const H = level.hEdges;
  const V = level.vEdges;
  const hq = c.groundHeight;
  const cliffRings: number[][] = [];
  for (let ly = 1; ly < h; ly++)
    for (let lx = 0; lx < w; lx++) {
      const e = hEdgeIndex(level.bounds, lx, ly);
      if (H.kind[e] !== EDGE.LEDGE || (H.height[e] as number) < CLIFF_HEIGHT) continue;
      const northLow = hq((ly - 1) * w + lx) < hq(ly * w + lx);
      cliffRings.push(
        northLow ? [bx + lx + 1, by + ly, bx + lx, by + ly] : [bx + lx, by + ly, bx + lx + 1, by + ly],
      );
    }
  for (let ly = 0; ly < h; ly++)
    for (let lx = 1; lx < w; lx++) {
      const e = vEdgeIndex(level.bounds, lx, ly);
      if (V.kind[e] !== EDGE.LEDGE || (V.height[e] as number) < CLIFF_HEIGHT) continue;
      const westLow = hq(ly * w + lx - 1) < hq(ly * w + lx);
      cliffRings.push(
        westLow ? [bx + lx, by + ly, bx + lx, by + ly + 1] : [bx + lx, by + ly + 1, bx + lx, by + ly],
      );
    }
  return cliffRings.length > 0
    ? [{ layer: "ledge", style: "cliff", geom: { rings: cliffRings, closed: false } }]
    : [];
}

/** Bridges: the deck outline with planks across it ("bridge-h" runs east–west, "bridge-v" north–south). */
export function bridgeItems(c: DisplayCtx): DisplayItem[] {
  const { bx, by, w, level } = c;
  const items: DisplayItem[] = [];
  for (const b of level.bridges ?? []) {
    const set = new Set(b.cells.map(([x, y]) => (y - by) * w + (x - bx)));
    const rings = cellRings(level, (i) => set.has(i));
    if (rings.length === 0) continue;
    const xs = b.cells.map((p) => p[0]);
    const ys = b.cells.map((p) => p[1]);
    const ew = maxOf(xs) - minOf(xs) >= maxOf(ys) - minOf(ys);
    items.push({
      layer: "ledge",
      style: ew ? "bridge-h" : "bridge-v",
      geom: { rings, closed: true },
      ref: b.id,
    });
  }
  return items;
}

/** The grid between floor cells (and along the level's border), merged into runs; walls and openings break it. */
export function gridItems(c: DisplayCtx): DisplayItem[] {
  if (!c.opts.grid) return [];
  const rings = edgeRuns(c, (g, e, a, b) => {
    const kind = g.kind[e] as number;
    if (kind === EDGE.WALL || kind === EDGE.OPENING) return false;
    const fa = a >= 0 && c.isFloor(a);
    const fb = b >= 0 && c.isFloor(b);
    return (fa && fb) || (fa && b < 0) || (fb && a < 0);
  });
  return rings.length > 0 ? [{ layer: "grid", style: "grid", geom: { rings, closed: false } }] : [];
}
