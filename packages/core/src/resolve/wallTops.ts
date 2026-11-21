/**
 * Rough wall tops, generator 4 (interior round, item 8, 2026-11-20). A built dungeon or cellar has every wall at one
 * height, a ruled line from above. The reference interior's wall bases sit a quarter tile apart, so its tops vary
 * (2.0 / 2.25 / 2.5 above the floor, 41 / 16 / 32%) and runs break into shorter stubs at openings.
 *
 * A wall piece is 2 tall and cannot grow, so the tops here only come DOWN: a run of 2 to 6 edges is dropped by 0,
 * a quarter or half a tile (the piece sinks into the floor slab, compile/realize.ts), the level's flat cap and the
 * unlowered runs stay at the full height. Nothing is raised, so a wall never lifts off its floor and roofs, caps and
 * the floor of the level above are unaffected.
 *
 * This pass is cosmetic only. The height correction for a wall between floors a quarter or half a tile apart is
 * resolve/wallSettle.ts and runs after it; the drops here are chosen knowing that correction will take the step off
 * too (a wall never ends below 1.25 tall), and a wall beside a bigger step is left alone.
 *
 * Left alone: edges within a cell of an opening, of a wall-mounted feature or of an overhead line's anchor (they need
 * their full height), walls taller than 2.5 or shorter than 1.5, walls on rises of more than half a tile (a pit or a
 * platform beside the wall is a deliberate step), styles that cannot stand uneven (gen/wallStyles.ts `uneven`: the plain
 * wall and old masonry may; dressed, timber, plaster and the low or open styles may not).
 */
import type { ResolvedLevel } from "../contracts/resolved";
import { CELL_FLAG, EDGE } from "../contracts/resolved";
import { cellIndex, edgeLineLength, edgeLines, edgeOnLine } from "./levelGrid";
import { areaReferenceHeights, spanCellOf, wallRise } from "./wallspan";
import { h32 } from "../util/hash";
import { isUnevenWallStyle } from "../gen/wallStyles";

/**
 * Is each cell of a resolved level part of a rough interior (wall-foot rubble, broken wall tops, uneven tops)? Read
 * from the finish the resolver gave its area (ResolvedArea.finish: the theme's interior character, rough when the room
 * is abandoned). A cell outside every area is not a room and is not rough. Row-major, local index.
 */
export function roughCells(L: ResolvedLevel): Uint8Array {
  const out = new Uint8Array(L.bounds.w * L.bounds.h);
  const rough = L.areas.map((a) => a.finish !== "tidy");
  for (let i = 0; i < out.length; i++) {
    const aid = L.cells.area[i] ?? 0;
    out[i] = aid > 0 && rough[aid - 1] === true ? 1 : 0;
  }
  return out;
}

/** Tiles a segment of wall may drop: weights of 0, 0.25, 0.5. */
const DROPS: ReadonlyArray<readonly [number, number]> = [
  [0, 40],
  [0.25, 32],
  [0.5, 28],
];

const EPS = 1e-6;

/** Edits `L.hEdges.height` / `L.vEdges.height` in place; returns how many edges it set. */
export function roughWallTops(L: ResolvedLevel, seedKey: string): number {
  const ref = areaReferenceHeights(L);
  const cellAt = spanCellOf(L);
  // protected edges: "h|line|pos" / "v|line|pos" in local coordinates
  const protect = new Set<string>();
  const hold = (orient: "h" | "v", line: number, pos: number): void => {
    protect.add(`${orient}|${line}|${pos}`);
  };
  for (const op of L.openings) {
    const lx = op.start[0] - L.bounds.x;
    const ly = op.start[1] - L.bounds.y;
    for (let k = -1; k <= op.width; k++) {
      if (op.orientation === "h") hold("h", ly, lx + k);
      else hold("v", lx, ly + k);
    }
  }
  const aroundCell = (cx: number, cy: number): void => {
    const lx = cx - L.bounds.x;
    const ly = cy - L.bounds.y;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        hold("h", ly + dy, lx + dx);
        hold("h", ly + dy + 1, lx + dx);
        hold("v", lx + dx, ly + dy);
        hold("v", lx + dx + 1, ly + dy);
      }
  };
  for (const f of L.features) if (f.wall !== undefined) aroundCell(f.at[0], f.at[1]);
  for (const ln of L.lines ?? []) for (const an of ln.anchors) aroundCell(an.at[0], an.at[1]);

  const rough = roughCells(L);
  const roughAt = (lx: number, ly: number): boolean => rough[cellIndex(L.bounds, lx, ly)] === 1;

  let changed = 0;
  for (const orient of ["h", "v"] as const) {
    const grid = orient === "h" ? L.hEdges : L.vEdges;
    const lines = edgeLines(L.bounds, orient);
    const along = edgeLineLength(L.bounds, orient);
    for (let line = 0; line < lines; line++) {
      // candidates along this line: position -> new height basis
      type Cand = { pos: number; e: number; h0: number; rise: number; host: number; style: string };
      let run: Cand[] = [];
      const flush = (): void => {
        if (run.length >= 3) {
          let k = 0;
          while (k < run.length) {
            const first = run[k] as Cand;
            const len = 2 + (h32(`${seedKey}:${orient}:${line}:${first.pos}:len`) % 5);
            const u = h32(`${seedKey}:${orient}:${line}:${first.pos}:drop`) % 100;
            let acc = 0;
            let drop = 0;
            for (const [d, wt] of DROPS) {
              acc += wt;
              if (u < acc) {
                drop = d;
                break;
              }
            }
            for (let j = k; j < Math.min(run.length, k + len); j++) {
              const c = run[j] as Cand;
              // the wall's final top is h0 - drop - rise once the step correction runs (resolve/wallSettle.ts); never
              // drop a wall below 1.25 tall (a low stub reads as rubble, not as a wall)
              if (drop > 0 && c.h0 - drop - c.rise >= 1.25) {
                grid.height[c.e] = c.h0 - drop;
                changed++;
              }
            }
            k += len;
          }
        }
        run = [];
      };
      for (let pos = 0; pos < along; pos++) {
        const idx = edgeOnLine(L.bounds, orient, line, pos);
        const kind = grid.kind[idx];
        if (kind !== EDGE.WALL && kind !== EDGE.OPENING) {
          flush();
          continue;
        }
        const style = kind === EDGE.WALL ? (L.wallStyles[grid.ref[idx] ?? 0] ?? "wall") : "";
        const h0 = (grid.height[idx] ?? 0) > 0 ? (grid.height[idx] ?? 2) : 2;
        const a = orient === "h" ? cellAt(pos, line - 1) : cellAt(line - 1, pos);
        const b = orient === "h" ? cellAt(pos, line) : cellAt(line, pos);
        const host = grid.host[idx] ?? 1;
        const bridge = (host === 0 ? a : b).flags & CELL_FLAG.BRIDGE;
        const rise = wallRise(L.elevation, a, b, host === 0, h0, ref);
        // a tidy (timber, plaster) interior keeps clean walls: a side that is open and rough makes the edge rough
        const roughSide =
          (a.open && roughAt(orient === "h" ? pos : line - 1, orient === "h" ? line - 1 : pos)) ||
          (b.open && roughAt(orient === "h" ? pos : line, orient === "h" ? line : pos));
        const candidate =
          kind === EDGE.WALL &&
          roughSide &&
          bridge === 0 &&
          isUnevenWallStyle(style) &&
          h0 <= 2.5 + EPS &&
          h0 >= 1.5 - EPS &&
          rise <= 0.5 + EPS &&
          !protect.has(`${orient}|${line}|${pos}`);
        if (!candidate) {
          flush();
          continue;
        }
        const prev = run[run.length - 1];
        if (prev && (prev.host !== host || prev.style !== style || Math.abs(prev.h0 - h0) > EPS)) flush();
        run.push({ pos, e: idx, h0, rise: Math.max(0, rise), host, style });
      }
      flush();
    }
  }
  return changed;
}
