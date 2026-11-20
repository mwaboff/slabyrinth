/**
 * Cave walls (generator 3): a natural wall is rock mass two to three cells deep, built behind the wall columns
 * (gen/cavewall.ts). Where the plan leaves only one cell of rock between the open floor and the level's edge, or
 * another open area, the realizer has no room for the mass and the wall stays what generator 2 built: one block column
 * per cell, a row of identical posts. This note measures that from the resolved level, so the model can leave rock.
 */
import type { MapPlan } from "../contracts/plan";
import { CELL, type ResolvedLevel } from "../contracts/resolved";
import type { DesignNote } from "./review";
import { REVIEW } from "./thresholds";

const D4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Thickness (rock cells straight back from the floor, capped) of every wall cell of a level; for tests and proofs. */
export function caveWallThickness(L: ResolvedLevel): number[] {
  const { w, h } = L.bounds;
  const state = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -1 : (L.cells.state[y * w + x] ?? CELL.VOID);
  const out: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (state(x, y) === CELL.OPEN) continue;
      if (state(x, y) === -1) continue;
      const open = D4.find(([dx, dy]) => state(x + dx, y + dy) === CELL.OPEN);
      if (!open) continue;
      // straight back, away from the open neighbour
      let n = 0;
      let cx = x;
      let cy = y;
      while (n < REVIEW.caveWall.depth && state(cx, cy) !== CELL.OPEN && state(cx, cy) !== -1) {
        n++;
        cx -= open[0];
        cy -= open[1];
      }
      out.push(n);
    }
  return out;
}

export function caveWallChecks(plan: MapPlan, L: ResolvedLevel): DesignNote[] {
  const T = REVIEW.caveWall;
  if (plan.generator < 3) return [];
  if (!L.wallStyles.some((s) => s === "cave_rock")) return [];
  const t = caveWallThickness(L);
  if (t.length < T.minFaces) return [];
  const thin = t.filter((n) => n < T.thin).length / t.length;
  if (thin <= T.share) return [];
  return [
    {
      code: "cave_wall_thin",
      levelId: L.id,
      score: T.weight * Math.min(3, thin / T.share),
      message: `${Math.round(thin * 100)}% of the cave wall has under ${T.thin} cells of rock behind it: it is built as one block column per cell, a row of identical posts (palisade), not as rock mass`,
      action: `leave ${T.depth} or more cells of solid rock behind the cave wall (keep areas and the level edge ${T.depth + 1} cells apart, and leave a solid cell between neighbouring areas)`,
    },
  ];
}
