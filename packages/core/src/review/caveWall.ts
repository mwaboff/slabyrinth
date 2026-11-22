/**
 * Cave walls (generator 3): a natural wall is rock mass two to three cells deep, built behind the wall columns
 * (gen/cavewall.ts). Where the plan leaves only one cell of rock between the open floor and the level's edge, or
 * another open area, the realizer has no room for the mass and the wall stays what generator 2 built: one block column
 * per cell, a row of identical posts. This note measures that from the resolved level, so the model can leave rock.
 */
import type { MapPlan } from "../contracts/plan";
import { CELL, CELL_FLAG, EDGE, type ResolvedLevel } from "../contracts/resolved";
import { NEIGHBOURS4 as D4 } from "../gen/gridGeometry";
import { hasNaturalWallStyle, naturalStyleRefs } from "../gen/wallStyles";
import { generatorProfile } from "../plan/generator";
import { cellIndex, hEdgeIndex, vEdgeIndex } from "../resolve/levelGrid";
import type { DesignNote } from "./review";
import { REVIEW, capped, over } from "./thresholds";
import { maxOf } from "../util/lists";

/** CELL state of local cell (x, y), -1 outside the level. */
function stateAt(L: ResolvedLevel, x: number, y: number): number {
  const i = cellIndex(L.bounds, x, y);
  return i < 0 ? -1 : (L.cells.state[i] ?? CELL.VOID);
}

/** Thickness (rock cells straight back from the floor, capped) of every wall cell of a level; for tests and proofs. */
export function caveWallThickness(L: ResolvedLevel): number[] {
  const { w, h } = L.bounds;
  const state = (x: number, y: number): number => stateAt(L, x, y);
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

/** Measures of a natural cave's floor and outline (generator 4 notes; for tests and proofs too). */
export interface CaveNaturalMeasures {
  /** Dry walkable floor cells of areas walled in natural rock, and the share at the commonest height. */
  floorCells: number;
  flatShare: number;
  /** Wall edges (open floor beside rock walled as cave rock), the share of them in straight runs over REVIEW.caveNatural.run, and the longest run. */
  wallEdges: number;
  straightShare: number;
  longest: number;
  longestAt: [number, number] | null;
}

export function caveNaturalMeasures(L: ResolvedLevel): CaveNaturalMeasures {
  const T = REVIEW.caveNatural;
  const { w, h } = L.bounds;
  const natural = naturalStyleRefs(L.wallStyles);
  const st = (x: number, y: number): number => stateAt(L, x, y);
  // an edge walled in cave rock (local coordinates): the north edge of (x,y) or its west edge
  const caveWall = (g: ResolvedLevel["hEdges"], e: number): boolean =>
    g.kind[e] === EDGE.WALL && natural.has(g.ref[e] ?? -1);
  const caveH = (x: number, y: number): boolean => caveWall(L.hEdges, hEdgeIndex(L.bounds, x, y));
  const caveV = (x: number, y: number): boolean => caveWall(L.vEdges, vEdgeIndex(L.bounds, x, y));
  // areas with a cave-rock wall, and their dry floor
  const caveAreas = new Set<number>();
  // straight runs: per line of edges (orientation, line, which side is open) the positions along it
  const lines = new Map<string, number[]>();
  let edges = 0;
  for (let y = 0; y <= h; y++)
    for (let x = 0; x <= w; x++) {
      for (const orient of ["h", "v"] as const) {
        if (orient === "h" ? x >= w : y >= h) continue;
        if (!(orient === "h" ? caveH(x, y) : caveV(x, y))) continue;
        const [ax, ay] = orient === "h" ? [x, y - 1] : [x - 1, y];
        const aOpen = st(ax, ay) === CELL.OPEN;
        const bOpen = st(x, y) === CELL.OPEN;
        if (aOpen === bOpen) continue;
        const [ox, oy] = aOpen ? [ax, ay] : [x, y];
        const a = L.cells.area[oy * w + ox] ?? 0;
        if (a > 0) caveAreas.add(a);
        edges++;
        const k = `${orient}${orient === "h" ? y : x}${aOpen ? "-" : "+"}`;
        const l = lines.get(k) ?? [];
        l.push(orient === "h" ? x : y);
        lines.set(k, l);
      }
    }
  let inRuns = 0;
  let longest = 0;
  let longestAt: [number, number] | null = null;
  for (const [k, l] of lines) {
    l.sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= l.length; i++) {
      if (i < l.length && l[i] === (l[i - 1] as number) + 1) continue;
      const run = i - start;
      if (run > T.run) inRuns += run;
      if (run > longest) {
        longest = run;
        const fixed = Number(k.slice(1, -1));
        const along = l[start] as number;
        longestAt =
          k[0] === "h" ? [L.bounds.x + along, L.bounds.y + fixed] : [L.bounds.x + fixed, L.bounds.y + along];
      }
      start = i;
    }
  }
  const count = new Map<number, number>();
  let floorCells = 0;
  for (let i = 0; i < w * h; i++) {
    if (L.cells.state[i] !== CELL.OPEN || !caveAreas.has(L.cells.area[i] ?? 0)) continue;
    if (((L.cells.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) !== 0)
      continue;
    floorCells++;
    const hq = L.cells.height[i] as number;
    count.set(hq, (count.get(hq) ?? 0) + 1);
  }
  return {
    floorCells,
    flatShare: floorCells > 0 ? maxOf(count.values()) / floorCells : 0,
    wallEdges: edges,
    straightShare: edges > 0 ? inRuns / edges : 0,
    longest,
    longestAt,
  };
}

/**
 * Generator 4: a natural cave whose floor is one flat sheet, or whose chambers and corridors are straight-sided boxes
 * cut into the rock (the owner's first look at the grotto proof). The resolver shapes both by default; these notes
 * catch what is left (a floor the shelves could not reach, outlines pinned by features and links).
 */
export function caveNaturalChecks(plan: MapPlan, L: ResolvedLevel): DesignNote[] {
  if (!generatorProfile(plan).naturalCaveReview || !hasNaturalWallStyle(L.wallStyles)) return [];
  const T = REVIEW.caveNatural;
  const m = caveNaturalMeasures(L);
  const out: DesignNote[] = [];
  if (m.floorCells >= T.minCells && m.flatShare > T.flatShare)
    out.push({
      code: "cave_floor_flat",
      levelId: L.id,
      score: T.weight * over(m.flatShare, T.flatShare),
      message: `${Math.round(m.flatShare * 100)}% of the cave floor is at one height: a natural cave floor steps and shelves, it is not a ballroom floor`,
      action:
        "let the floor rise in a few broad half-tile shelves toward the back of side chambers and stay low by the water (an uneven op with amount 1 and scale 6, or a ragged platform of 2 tiers of 0.5), keeping the ground under features flat",
    });
  if (m.wallEdges >= T.minEdges && (m.straightShare > T.straightShare || m.longest > T.longest))
    out.push({
      code: "cave_outline_straight",
      levelId: L.id,
      score: T.weight * capped(Math.max(m.straightShare / T.straightShare, m.longest / T.longest)),
      message: `the cave walls run ruler-straight: ${Math.round(m.straightShare * 100)}% of the wall lies in straight runs over ${T.run} cells, the longest ${m.longest} cells: the chambers read as boxes cut into the rock`,
      action:
        "draw cave chambers and passages as polygons with bulges and bays (no rect), passages at least 2 cells wide, and keep features and links off the walls so the outline can wander",
      ...(m.longestAt ? { cell: m.longestAt } : {}),
    });
  return out;
}

export function caveWallChecks(plan: MapPlan, L: ResolvedLevel): DesignNote[] {
  const T = REVIEW.caveWall;
  if (!generatorProfile(plan).caveRockMass) return [];
  if (!hasNaturalWallStyle(L.wallStyles)) return [];
  const t = caveWallThickness(L);
  if (t.length < T.minFaces) return [];
  const thin = t.filter((n) => n < T.thin).length / t.length;
  if (thin <= T.share) return [];
  return [
    {
      code: "cave_wall_thin",
      levelId: L.id,
      score: T.weight * over(thin, T.share),
      message: `${Math.round(thin * 100)}% of the cave wall has under ${T.thin} cells of rock behind it: it is built as one block column per cell, a row of identical posts (palisade), not as rock mass`,
      action: `leave ${T.depth} or more cells of solid rock behind the cave wall (keep areas and the level edge ${T.depth + 1} cells apart, and leave a solid cell between neighbouring areas)`,
    },
  ];
}
