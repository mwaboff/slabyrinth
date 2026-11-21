/**
 * Step 5 of a level: the edges between cells.
 * Reads: cell owners and heights, the bridge decks (BridgeRecords), the areas' wall modes and styles, the stair edges
 * that platform and stairs ops and inclined bridges asked for (the grid's `stairEdges`), and the level's explicit wall
 * runs. Writes: the edge arrays `hE` / `vE`: area walls (kind, style, height), ledges where floors differ in height,
 * stair edges (and the STEPS flag on the lower cell), and the walls a wall run adds or removes.
 */
import type { Side, Vec2 } from "../../contracts/plan";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { THEME_WALL_STYLE, isNaturalWallStyle } from "../../gen/wallStyles";
import type { BridgeRecords } from "./bridges";
import type { AreaInfo, EdgeArrays, ReadOnly, ResolveGrid } from "./grid";

export function stepEdges(work: ResolveGrid, bridges: ReadOnly<BridgeRecords>): void {
  const one = (orient: "h" | "v", e: EdgeArrays, i: number): void => {
    const [a, b] = work.edgeCells(orient, i);
    const ra = work.region(a);
    const rb = work.region(b);
    let demand = -1; // 0 = a, 1 = b, 2 = both
    // A bridge deck never gets area walls toward open cells (it has railings, added after the edges).
    const deckEdge = ra >= 0 && rb >= 0 && (bridges.deckOf[a] !== 0 || bridges.deckOf[b] !== 0);
    if (deckEdge) {
      /* no wall */
    } else if (ra >= 0 !== rb >= 0) {
      const r = ra >= 0 ? ra : rb;
      const m = work.modeOf(r);
      if (m === "auto" || m === "perimeter") demand = ra >= 0 ? 0 : 1;
    } else if (ra >= 0 && rb >= 0 && ra !== rb) {
      const da = work.modeOf(ra) === "auto";
      const db = work.modeOf(rb) === "auto";
      if (da && db) demand = 2;
      else if (da) demand = 0;
      else if (db) demand = 1;
    }
    if (demand >= 0) {
      // Style: between two demanding sides a thin style beats a full-cell (natural rock) style whatever the
      // area sizes; between two thin (or two full-cell) styles the host side wins.
      let side: number;
      if (demand === 2) {
        const fa = isNaturalWallStyle((work.areas[ra - 1] as AreaInfo).wallStyle);
        const fb = isNaturalWallStyle((work.areas[rb - 1] as AreaInfo).wallStyle);
        side = fa !== fb ? (fa ? 1 : 0) : work.hostOf(a, b, false);
      } else side = demand;
      const info = work.areas[(side === 0 ? ra : rb) - 1] as AreaInfo;
      // Natural rock walls are full-cell blocks in TaleSpire: there is no thin rock wall to stand between two
      // open cells. When every demanding side uses a full-cell style and both sides are open, the spaces merge.
      const fullCell = isNaturalWallStyle(info.wallStyle);
      if (!(fullCell && ra >= 0 && rb >= 0)) {
        e.kind[i] = EDGE.WALL;
        e.style[i] = info.wallStyle;
        e.height[i] = info.wallHeight;
        return;
      }
    }
    if (ra >= 0 && rb >= 0) {
      const dh = Math.abs((work.height[a] as number) - (work.height[b] as number));
      if (dh >= 1) {
        e.kind[i] = EDGE.LEDGE;
        e.height[i] = dh / 4;
      }
    }
  };
  for (let i = 0; i < work.hE.kind.length; i++) one("h", work.hE, i);
  for (let i = 0; i < work.vE.kind.length; i++) one("v", work.vE, i);
}

/** Stair edges become EDGE.STAIR (walkable whatever the height); the lower cell holds the stair asset. */
export function stepStairs(work: ResolveGrid): void {
  for (const key of work.stairEdges) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    if (work.state[a] !== CELL.OPEN || work.state[b] !== CELL.OPEN) continue;
    const ha = work.height[a] as number;
    const hb = work.height[b] as number;
    if (ha === hb) continue;
    const [ax, ay] = work.cellXY(a);
    const [bx, by] = work.cellXY(b);
    const side: Side = bx > ax ? "E" : bx < ax ? "W" : by > ay ? "S" : "N";
    const ed = work.sideEdge(ax, ay, side);
    if (!ed || ed.e.kind[ed.i] === EDGE.WALL || ed.e.kind[ed.i] === EDGE.OPENING) continue;
    ed.e.kind[ed.i] = EDGE.STAIR;
    ed.e.height[ed.i] = Math.abs(ha - hb) / 4;
    const lower = ha < hb ? a : b;
    work.flags[lower] = (work.flags[lower] as number) | CELL_FLAG.STEPS;
  }
}

export function stepWallRuns(work: ResolveGrid): void {
  work.level.walls.forEach((run, k) => {
    const path = `/levels/${work.li}/walls/${k}`;
    let clipped = 0;
    let removed = 0;
    const thinRock: Array<[number, number]> = [];
    for (let s = 0; s + 1 < run.points.length; s++) {
      const p = run.points[s] as Vec2;
      const q = run.points[s + 1] as Vec2;
      const edges: Array<{ e: EdgeArrays; i: number; orient: "h" | "v" } | null> = [];
      if (p[1] === q[1]) {
        for (let x = Math.min(p[0], q[0]); x < Math.max(p[0], q[0]); x++)
          edges.push(work.hIndex(x - work.bx, p[1] - work.by));
      } else if (p[0] === q[0]) {
        for (let y = Math.min(p[1], q[1]); y < Math.max(p[1], q[1]); y++)
          edges.push(work.vIndex(p[0] - work.bx, y - work.by));
      } else {
        work.issue("error", "shape_invalid", `wall run "${run.id}" segment ${s} is not axis-aligned`, {
          path: `${path}/points/${s + 1}`,
          elementId: run.id,
          hint: `use [${q[0]},${p[1]}] or [${p[0]},${q[1]}] as an intermediate point`,
        });
        continue;
      }
      for (const ed of edges) {
        if (!ed) {
          clipped++;
          continue;
        }
        if (run.op === "add") {
          const [ca, cb] = work.edgeCells(ed.orient, ed.i);
          if (
            isNaturalWallStyle(run.style ?? THEME_WALL_STYLE) &&
            work.region(ca) >= 0 &&
            work.region(cb) >= 0
          ) {
            thinRock.push(work.edgeStart(ed.orient, ed.i));
          }
          ed.e.kind[ed.i] = EDGE.WALL;
          ed.e.style[ed.i] = run.style ?? THEME_WALL_STYLE;
          ed.e.height[ed.i] = run.height ?? work.defaultWallHeight;
          ed.e.run[ed.i] = 1;
        } else if (ed.e.kind[ed.i] === EDGE.WALL) {
          removed++;
          ed.e.kind[ed.i] = EDGE.NONE;
          ed.e.style[ed.i] = null;
          ed.e.height[ed.i] = 0;
          ed.e.run[ed.i] = 0;
        }
      }
    }
    if (run.op === "remove" && removed === 0)
      work.issue(
        "warning",
        "no_effect",
        `wall run "${run.id}" (remove) removed nothing: there is no wall along it`,
        {
          path,
          elementId: run.id,
          hint: "wall runs follow grid VERTICES (cell corners): to remove the wall on the north side of cell x,y use points [[x,y],[x+1,y]]; check the walls with view_plan ascii",
        },
      );
    const firstThin = thinRock[0];
    if (firstThin)
      work.issue(
        "error",
        "shape_invalid",
        `wall run "${run.id}" asks for a ${run.style ?? THEME_WALL_STYLE} wall between two open cells at ${firstThin[0]},${firstThin[1]} (${thinRock.length} edges); natural rock is built as whole cells, so it cannot stand there as a thin wall`,
        {
          path: `${path}/style`,
          elementId: run.id,
          hint: "leave a solid (unclaimed) cell between the two areas, or use another wall style such as stone",
        },
      );
    if (clipped > 0)
      work.issue(
        "warning",
        "bounds_exceeded",
        `wall run "${run.id}" leaves the level bounds; ${clipped} edges clipped`,
        {
          path,
          elementId: run.id,
        },
      );
  });
}
