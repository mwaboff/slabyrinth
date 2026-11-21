/**
 * Wall height beside a raised floor, generator 4. `stepRoomFloors` raises a room a quarter or half a tile above its
 * corridor; the span of a wall between two floors (resolve/wallspan.ts) is the wall height ABOVE THE HIGHER floor, so
 * one 2-tall piece stood on the lower floor would overshoot by the step (and two stacked pieces by 1.75 tiles). Here
 * the edge is shortened by the step so the wall's top lands on `base + the wall height`.
 *
 * This is a correction the room floors REQUIRE, not a cosmetic choice: it runs for every built interior whose rooms
 * can be raised, whether or not the wall tops are then roughened (resolve/wallTops.ts, which runs first and leaves the
 * correction to this pass). Edits `L.hEdges.height` / `L.vEdges.height` in place; returns how many edges it set.
 *
 * Applies to a wall or doorway of any style on a step of up to half a tile, up to 2.5 tall, not on a bridge deck.
 */
import type { ResolvedLevel } from "../contracts/resolved";
import { CELL_FLAG, EDGE } from "../contracts/resolved";
import { edgeLineLength, edgeLines, edgeOnLine } from "./levelGrid";
import { areaReferenceHeights, spanCellOf, wallRise } from "./wallspan";

const EPS = 1e-6;

export function settleWallHeights(L: ResolvedLevel): number {
  const ref = areaReferenceHeights(L);
  const cellAt = spanCellOf(L);
  let changed = 0;
  for (const orient of ["h", "v"] as const) {
    const grid = orient === "h" ? L.hEdges : L.vEdges;
    const lines = edgeLines(L.bounds, orient);
    const along = edgeLineLength(L.bounds, orient);
    for (let line = 0; line < lines; line++)
      for (let pos = 0; pos < along; pos++) {
        const idx = edgeOnLine(L.bounds, orient, line, pos);
        const kind = grid.kind[idx];
        if (kind !== EDGE.WALL && kind !== EDGE.OPENING) continue;
        const h0 = (grid.height[idx] ?? 0) > 0 ? (grid.height[idx] ?? 2) : 2;
        if (h0 > 2.5 + EPS) continue;
        const a = orient === "h" ? cellAt(pos, line - 1) : cellAt(line - 1, pos);
        const b = orient === "h" ? cellAt(pos, line) : cellAt(line, pos);
        const host = grid.host[idx] ?? 1;
        if (((host === 0 ? a : b).flags & CELL_FLAG.BRIDGE) !== 0) continue;
        const rise = wallRise(L.elevation, a, b, host === 0, h0, ref);
        if (rise <= EPS || rise > 0.5 + EPS) continue;
        grid.height[idx] = h0 - rise;
        changed++;
      }
  }
  return changed;
}
