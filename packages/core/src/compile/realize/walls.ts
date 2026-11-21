/**
 * Realize, wall passes: wall runs along every wall edge and shell skirt edge (half-cell and edge-centre pieces, with
 * the generator-4 broken tops of a rough interior), and the corner posts where strips meet.
 * Reads: the level's edges, `claimed`, the solid shell's skirt edges and style (solidShell.ts); the corner strips (the
 * wall and opening passes register them) for the corner posts. Writes: wall and wall_post placements, `CornerStrips`;
 * returns the full-cell columns its runs gathered (built by the rock wall pass).
 */
import type { ThemeId } from "../../contracts/plan";
import { EDGE } from "../../contracts/resolved";
import type { ResolvedVariant, RoleResolution } from "../../palette/resolve";
import { roughCells } from "../../resolve/wallTops";
import { h32 } from "../geometry";
import { isCarvedLevel } from "../shell";
import {
  edgeCtx,
  lenFilter,
  lengthOf,
  placeEdgeCenterPiece,
  placeEdgePiece,
  type CornerStrips,
  type EdgeCtx,
  type Strip,
} from "./edges";
import { OPPOSITE, cellKey } from "../../gen/gridGeometry";
import { edgeLineLength, edgeLines } from "../../resolve/levelGrid";
import { EPS, type RealizeLevel } from "./level";
import type { SolidShellPlan } from "./solidShell";

/** A full-cell wall column: one per rock cell, spanning every wall edge it closes. */
export interface FullCellColumn {
  x: number;
  y: number;
  base: number;
  top: number;
  theme: ThemeId;
  roleName: string;
}
/**
 * The full-cell columns by cell (gen/gridGeometry.ts `cellKey` of the plan cell: a column may stand outside the level),
 * in the order the wall runs met them.
 */
export type FullCellColumns = ReadonlyMap<number, FullCellColumn>;

/** Edge reference meaning "no wall style". */
const NONE = 0xffff;

/** One run of wall edges along a row (h) or column (v) of edges that one piece kind can tile. */
interface WallRun {
  orient: "h" | "v";
  style: string;
  edges: EdgeCtx[];
}

/** What every run of one layWalls call shares. */
interface WallPass {
  lv: RealizeLevel;
  strips: CornerStrips;
  /** Rough interior cells (1) that get broken wall tops; null when the level has none. */
  rough: Uint8Array | null;
  fullCells: Map<number, FullCellColumn>;
  /** Open cells (`cellKey`) already warned about as the host of a full-cell wall (one thick_wall_conflict each). */
  conflictNoted: Set<number>;
}

// ── walls ──
export function layWalls(lv: RealizeLevel, shellPlan: SolidShellPlan, strips: CornerStrips): FullCellColumns {
  const { L } = lv;
  const { profile } = lv.ctx;
  const pass: WallPass = {
    lv,
    strips,
    // generator 4 (`interiorWallTops`): only a rough interior of a carved level gets broken wall tops (a kept-up
    // timber inn keeps clean walls)
    rough: profile.interiorWallTops && isCarvedLevel(L) ? roughCells(L) : null,
    fullCells: new Map(),
    conflictNoted: new Set(),
  };
  for (const orient of ["h", "v"] as const)
    for (const run of wallRunsAlong(lv, shellPlan, orient)) placeWallRun(pass, run);
  return pass.fullCells;
}

/**
 * The wall runs of one orientation, row by row: unclaimed WALL edges and the shell's skirt edges, split where the host
 * side, style, theme, base or top changes.
 */
function wallRunsAlong(lv: RealizeLevel, shellPlan: SolidShellPlan, orient: "h" | "v"): WallRun[] {
  const { L, V, claimed } = lv;
  const { shell, skirtEdges } = shellPlan;
  const grid = V.edges(orient);
  const outer = edgeLines(V, orient);
  const inner = edgeLineLength(V, orient);
  const wallStyleOf = (ref: number): string => (ref === NONE ? "wall" : (L.wallStyles[ref] ?? "wall"));
  const runs: WallRun[] = [];
  for (let o = 0; o < outer; o++) {
    let run: WallRun | null = null;
    let runKey = "";
    for (let i = 0; i < inner; i++) {
      const x = orient === "h" ? L.bounds.x + i : L.bounds.x + o;
      const y = orient === "h" ? L.bounds.y + o : L.bounds.y + i;
      const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
      const skirt = e >= 0 ? skirtEdges.get(`${orient}${e}`) : undefined;
      if (
        skirt === undefined &&
        (e < 0 || grid.kind[e] !== EDGE.WALL || claimed.edges.has(`${orient}${e}`))
      ) {
        run = null;
        runKey = "";
        continue;
      }
      const style = skirt && shell ? shell.style : wallStyleOf(grid.ref[e] ?? NONE);
      const height = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
      const ctx = skirt ?? edgeCtx(lv, orient, x, y, grid, e, height);
      const key = [ctx.hostFirst, style, ctx.theme, ctx.base, ctx.top].join("|");
      if (run === null || key !== runKey) {
        run = { orient, style, edges: [] };
        runs.push(run);
      }
      runKey = key;
      run.edges.push(ctx);
    }
  }
  return runs;
}

function placeWallRun(pass: WallPass, run: WallRun): void {
  const { L } = pass.lv;
  const { lookup } = pass.lv.ctx;
  const first = run.edges[0];
  if (!first) return;
  const roleName = `wall.${run.style}`;
  const res = lookup(L.id, first.theme, [roleName]);
  if (!res) return;
  const mount = res.def.mount ?? "half-cell";
  if (mount === "full-cell") gatherFullCells(pass, run.edges, roleName);
  else tileWallRun(pass, run, res, mount === "edge-center", roleName);
}

/**
 * The columns a run of full-cell wall pieces (rock) needs, merged per cell: one column per rock cell, spanning every edge
 * it closes (a cell beside a chasm and its rim gets one column from the chasm floor to the rim wall top). The rock wall
 * pass builds them.
 *
 * This is the rock walls' own way of finding wall faces, and it differs from the solid shell's (compile/shell.ts
 * `wallFaces`) on purpose, so the two are not one routine: it takes WALL edges only (an opening is a piece of its
 * own), and only those the palette mounts full-cell (role data, not the wall-style trait); the face cell is the edge's
 * host or, when the host is open and the other side is not, the other cell, which may be VOID or outside the bounds
 * (dropped only under `boardEdgeExits`); spans merge as the lowest base and the highest top. The shell keeps the
 * tallest top of in-bounds SOLID cells behind WALL and OPENING edges and splits natural from built by the style trait.
 */
function gatherFullCells(pass: WallPass, edges: readonly EdgeCtx[], roleName: string): void {
  const { lv, fullCells, conflictNoted } = pass;
  const { L } = lv;
  const { profile, addDiag } = lv.ctx;
  for (const c of edges) {
    // A rock block cannot stand in an open host cell; put it in the other cell when that one is rock, void or
    // outside the level (a cave touching the level bounds), otherwise skip it with a warning.
    const flip = c.hostOpen && !c.otherOpen;
    const bx = flip ? c.otherX : c.hostX;
    const by = flip ? c.otherY : c.hostY;
    const k = cellKey(bx, by);
    // generator 3: a passage that reaches the board edge is an exit; no rock column stands outside the bounds
    if (
      profile.boardEdgeExits &&
      (bx < L.bounds.x || bx >= L.bounds.x + L.bounds.w || by < L.bounds.y || by >= L.bounds.y + L.bounds.h)
    )
      continue;
    if (c.hostOpen && !flip) {
      if (conflictNoted.has(k)) continue;
      conflictNoted.add(k);
      addDiag({
        severity: "warning",
        code: "thick_wall_conflict",
        message: `Full-cell wall "${roleName}" would fill an open cell; skipped`,
        levelId: L.id,
        role: roleName,
        cell: [c.hostX, c.hostY],
      });
      continue;
    }
    const prev = fullCells.get(k);
    if (prev) {
      prev.base = Math.min(prev.base, c.base);
      prev.top = Math.max(prev.top, c.top);
    } else fullCells.set(k, { x: bx, y: by, base: c.base, top: c.top, theme: c.theme, roleName });
  }
}

/** Tiles a run with the longest pieces that fit (half-cell pieces on the edge, or edge-centre pieces over it). */
function tileWallRun(
  pass: WallPass,
  run: WallRun,
  res: RoleResolution,
  edgeCenter: boolean,
  roleName: string,
): void {
  const { lv, strips } = pass;
  const { L } = lv;
  const { profile, lookup, pick } = lv.ctx;
  const { orient, style, edges } = run;
  const theme = edges[0]?.theme ?? "";
  const lengths = [...new Set(res.variants.filter((v) => v.weight > 0).map(lengthOf))].sort((a, b) => b - a);
  const greedy = res.def.greedyTiling !== false;
  const pickKey = (c: EdgeCtx | undefined): string => `${L.id}:${orient}wall:${c?.x ?? 0}:${c?.y ?? 0}`;
  let i = 0;
  while (i < edges.length) {
    const remaining = edges.length - i;
    const cands = (greedy ? lengths : [1]).filter((n) => n <= remaining);
    const shortest = lengths.length > 0 ? Math.min(...lengths) : 1;
    if (edgeCenter && remaining < shortest) {
      // free-standing low walls/fences/railings: a run shorter than the shortest piece gets that piece centred over
      // it (it overhangs a little), rather than a gap
      const r = lookup(L.id, theme, [roleName], lenFilter(shortest), true);
      const v = r ? pick(r.variants, pickKey(edges[i])) : undefined;
      const c = edges[i];
      if (v && c) {
        placeEdgeCenterPiece(lv, v, "wall", c, remaining, { cell: [c.hostX, c.hostY], elementId: roleName });
        i += remaining;
        continue;
      }
    }
    let done = false;
    for (const n of [...cands, 1]) {
      let r = lookup(L.id, theme, [roleName], lenFilter(n), n !== 1);
      let v = r ? pick(r.variants, pickKey(edges[i])) : undefined;
      const c = edges[i];
      if (!v || !c) continue;
      const broken = style === "wall" && n >= 2 ? brokenTop(pass, orient, c, n, theme) : null;
      if (broken) ({ r, v } = broken);
      if (edgeCenter)
        placeEdgeCenterPiece(lv, v, "wall", c, n, { cell: [c.hostX, c.hostY], elementId: roleName });
      else {
        const count = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
        // generator 4: a wall a quarter or half a tile short of whole pieces sinks into the floor slab so its top
        // lands where the edge says (rough tops, resolve/wallTops.ts); the piece never lifts off the floor
        const yBase = profile.exactWallTops
          ? Math.max(c.base - 0.5, Math.min(c.base, c.top - count * v.unitHeight))
          : c.base;
        const source = { cell: [c.hostX, c.hostY] as [number, number], elementId: roleName };
        placeEdgePiece(lv, v, "wall", r?.role ?? roleName, c, n, yBase, count, source, false);
        for (let k = 0; k < n; k++) {
          const ck = edges[i + k];
          if (ck) strips.register(orient, ck.x, ck.y, stripOf(ck, style));
        }
      }
      i += n;
      done = true;
      break;
    }
    if (!done) i++;
  }
}

/**
 * Generator 4, rough interiors: about one piece in five of a run is a broken-top variant (wall.ruined), when the
 * palette has a half-cell one of that length. Null keeps the piece chosen.
 */
function brokenTop(
  pass: WallPass,
  orient: "h" | "v",
  c: EdgeCtx,
  n: number,
  theme: ThemeId,
): { r: RoleResolution; v: ResolvedVariant } | null {
  const { lv, rough } = pass;
  const { L, V } = lv;
  const { seed, lookup, pick } = lv.ctx;
  if (rough === null || !c.hostOpen) return null;
  const host = V.index(c.hostX, c.hostY);
  const roughHost = host >= 0 && rough[host] === 1;
  if (!roughHost || h32(`${seed}:${L.id}:brokentop:${orient}:${c.x}:${c.y}`) % 5 !== 0) return null;
  const rr = lookup(L.id, theme, ["wall.ruined"], lenFilter(n), true);
  const rv = rr ? pick(rr.variants, `${L.id}:${orient}broken:${c.x}:${c.y}`) : undefined;
  return rr && rv && (rr.def.mount ?? "half-cell") === "half-cell" ? { r: rr, v: rv } : null;
}

/** The strip a wall piece leaves on its edge, for the corner posts. */
const stripOf = (c: EdgeCtx, style: string): Strip => ({
  orient: c.orient,
  side: OPPOSITE[c.planSide],
  style,
  theme: c.theme,
  base: c.base,
  top: c.top,
});

// corner posts: quadrants around a vertex left uncovered where an h strip and a v strip meet
export function layCornerPosts(lv: RealizeLevel, strips: CornerStrips): void {
  const { L, emit } = lv;
  const { profile, frame, lookup, pick } = lv.ctx;
  for (const [k, list] of strips.byVertex) {
    const [vx, vy] = k.split(",").map(Number) as [number, number];
    const covered = new Set(list.map((s) => (s.orient === "h" ? `${s.side}${s.dir}` : `${s.dir}${s.side}`)));
    const gaps = new Map<string, { a: Strip; b: Strip }>();
    for (const a of list.filter((s) => s.orient === "h")) {
      for (const b of list.filter((s) => s.orient === "v")) {
        if (a.dir === b.side || b.dir === a.side) continue;
        const q = `${a.side}${b.side}`;
        if (covered.has(q) || gaps.has(q)) continue;
        gaps.set(q, { a, b });
      }
    }
    for (const [q, { a, b }] of gaps) {
      const qy = q[0] as "N" | "S";
      const qx = q[1] as "W" | "E";
      const style = a.style;
      const res = lookup(L.id, a.theme, [`wall_post.${style}`, "wall_post.wall"]);
      const v = res ? pick(res.variants, `${L.id}:post:${k}:${q}`) : undefined;
      if (!v) continue;
      const px = qx === "W" ? vx - 0.5 : vx;
      const py0 = qy === "N" ? vy - 0.5 : vy;
      const m = frame.rectMin(px, py0, 0.5, 0.5);
      const base = Math.min(a.base, b.base);
      const top = Math.max(a.top, b.top);
      // generator 4: a post up to half a tile (a quarter for a 1-tall piece) short of whole pieces stops there; walls
      // beside a room raised a quarter tile stand that much taller than the post's own course, which would otherwise
      // stack a second 2-tall piece through the floor above
      const slack = profile.exactWallTops ? Math.min(0.5, v.unitHeight / 4) : 0;
      const n = Math.max(1, Math.ceil((top - base - slack) / v.unitHeight - EPS));
      const cellX = Math.floor(px);
      const cellY = Math.floor(py0);
      for (let s = 0; s < n; s++)
        emit(v, "wall_post", m.x, base + s * v.unitHeight, m.z, v.rot, {
          cell: [cellX, cellY],
          elementId: `post:${k}`,
        });
    }
  }
}
