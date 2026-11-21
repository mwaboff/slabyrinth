/**
 * Realize, wall passes: wall runs along every wall edge and shell skirt edge (half-cell and edge-centre pieces, with
 * the generator-4 broken tops of a rough interior), and the corner posts where strips meet.
 * Reads: the level's edges, `claimed`, `shell`, `shellEdges`, `roughMap` (solidShell.ts); `strips` (written by this
 * pass and the opening pass) for the corner posts. Writes: wall and wall_post placements, `strips`, and `fullCells`
 * (full-cell columns, built by the rock wall pass).
 */
import { EDGE } from "../../contracts/resolved";
import { h32 } from "../geometry";
import { edgeCtx, lenFilter, lengthOf, placeEdgeCenterPiece, placeEdgePiece, registerEdgeStrip } from "./edges";
import { EPS, opposite, type EdgeCtx, type LevelWork, type Strip } from "./work";

const NONE = 0xffff;

// ── 3. walls, openings, posts ──
export function layWalls(w: LevelWork): void {
  const { L, V, claimed, shell, shellEdges, roughMap, fullCells } = w;
  const { seed, gen, lookup, pick, addDiag } = w.ctx;
  const fullCellDone = new Set<string>();
  const wallStyleOf = (ref: number): string => (ref === NONE ? "wall" : (L.wallStyles[ref] ?? "wall"));
  const roughCellAt = (x: number, y: number): boolean => {
    if (!roughMap || !V.inBounds(x, y)) return false;
    return roughMap[(y - L.bounds.y) * L.bounds.w + (x - L.bounds.x)] === 1;
  };
  const doRuns = (orient: "h" | "v"): void => {
    const grid = orient === "h" ? L.hEdges : L.vEdges;
    const outer = orient === "h" ? V.h + 1 : V.w + 1;
    const inner = orient === "h" ? V.w : V.h;
    for (let o = 0; o < outer; o++) {
      let run: EdgeCtx[] = [];
      let runKey = "";
      let runStyle = "wall";
      const flush = (): void => {
        if (run.length) placeWallRun(run, runStyle);
        run = [];
        runKey = "";
      };
      for (let i = 0; i < inner; i++) {
        const x = orient === "h" ? L.bounds.x + i : L.bounds.x + o;
        const y = orient === "h" ? L.bounds.y + o : L.bounds.y + i;
        const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
        const skirt = e >= 0 ? shellEdges.get(`${orient}${e}`) : undefined;
        if (skirt === undefined && (e < 0 || grid.kind[e] !== EDGE.WALL || claimed.edges.has(`${orient}${e}`))) {
          flush();
          continue;
        }
        const style = skirt && shell ? shell.style : wallStyleOf(grid.ref[e] ?? NONE);
        const height = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
        const ctx = skirt ?? edgeCtx(w, orient, x, y, grid, e, height);
        const key = [ctx.hostFirst, style, ctx.theme, ctx.base, ctx.top].join("|");
        if (key !== runKey) flush();
        runKey = key;
        runStyle = style;
        run.push(ctx);
      }
      flush();
    }

    function placeWallRun(run: EdgeCtx[], style: string): void {
      const first = run[0];
      if (!first) return;
      const roleName = `wall.${style}`;
      const res = lookup(L.id, first.theme, [roleName]);
      if (!res) return;
      const mount = res.def.mount ?? "half-cell";
      if (mount === "full-cell") {
        for (const c of run) {
          // A rock block cannot stand in an open host cell; put it in the other cell when that one is rock, void or
          // outside the level (a cave touching the level bounds), otherwise skip it with a warning.
          const flip = c.hostOpen && !c.otherOpen;
          const bx = flip ? c.otherX : c.hostX;
          const by = flip ? c.otherY : c.hostY;
          const k = `${bx},${by}`;
          // generator 3: a passage that reaches the board edge is an exit; no rock column stands outside the bounds
          if (
            gen.boardEdgeExits &&
            (bx < L.bounds.x || bx >= L.bounds.x + L.bounds.w || by < L.bounds.y || by >= L.bounds.y + L.bounds.h)
          )
            continue;
          if (c.hostOpen && !flip) {
            if (fullCellDone.has(`x${k}`)) continue;
            fullCellDone.add(`x${k}`);
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
          // one column per rock cell, spanning every edge it closes (a cell beside a chasm and its rim gets one
          // column from the chasm floor to the rim wall top)
          const prev = fullCells.get(k);
          if (prev) {
            prev.base = Math.min(prev.base, c.base);
            prev.top = Math.max(prev.top, c.top);
          } else fullCells.set(k, { x: bx, y: by, base: c.base, top: c.top, theme: c.theme, roleName });
        }
        return;
      }
      const lengths = [...new Set(res.variants.filter((v) => v.weight > 0).map(lengthOf))].sort(
        (a, b) => b - a,
      );
      const greedy = res.def.greedyTiling !== false;
      let i = 0;
      while (i < run.length) {
        const remaining = run.length - i;
        const cands = (greedy ? lengths : [1]).filter((n) => n <= remaining);
        const shortest = lengths.length > 0 ? Math.min(...lengths) : 1;
        if (mount === "edge-center" && remaining < shortest) {
          // free-standing low walls/fences/railings: a run shorter than the shortest piece gets that piece centred
          // over it (it overhangs a little), rather than a gap
          const r = lookup(L.id, first.theme, [roleName], lenFilter(shortest), true);
          const v = r
            ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
            : undefined;
          const c = run[i];
          if (v && c) {
            placeEdgeCenterPiece(w, v, "wall", c, remaining, {
              cell: [c.hostX, c.hostY],
              elementId: roleName,
            });
            i += remaining;
            continue;
          }
        }
        let done = false;
        for (const n of [...cands, 1]) {
          let r = lookup(L.id, first.theme, [roleName], lenFilter(n), n !== 1);
          let v = r
            ? pick(r.variants, `${L.id}:${orient}wall:${run[i]?.x ?? 0}:${run[i]?.y ?? 0}`)
            : undefined;
          const c = run[i];
          if (!v || !c) continue;
          // generator 4, rough interiors: about one piece in five of a run is a broken-top variant (wall.ruined)
          if (
            roughMap !== null &&
            style === "wall" &&
            n >= 2 &&
            c.hostOpen &&
            roughCellAt(c.hostX, c.hostY) &&
            h32(`${seed}:${L.id}:brokentop:${orient}:${c.x}:${c.y}`) % 5 === 0
          ) {
            const rr = lookup(L.id, first.theme, ["wall.ruined"], lenFilter(n), true);
            const rv = rr ? pick(rr.variants, `${L.id}:${orient}broken:${c.x}:${c.y}`) : undefined;
            if (rr && rv && (rr.def.mount ?? "half-cell") === "half-cell") {
              r = rr;
              v = rv;
            }
          }
          if (mount === "edge-center")
            placeEdgeCenterPiece(w, v, "wall", c, n, { cell: [c.hostX, c.hostY], elementId: roleName });
          else {
            const count = Math.max(1, Math.ceil((c.top - c.base) / v.unitHeight - EPS));
            // generator 4: a wall a quarter or half a tile short of whole pieces sinks into the floor slab so its top
            // lands where the edge says (rough tops, resolve/wallTops.ts); the piece never lifts off the floor
            const yBase = gen.exactWallTops
              ? Math.max(c.base - 0.5, Math.min(c.base, c.top - count * v.unitHeight))
              : c.base;
            placeEdgePiece(
              w,
              v,
              "wall",
              r?.role ?? roleName,
              c,
              n,
              yBase,
              count,
              { cell: [c.hostX, c.hostY], elementId: roleName },
              false,
            );
            for (let k = 0; k < n; k++) {
              const ck = run[i + k];
              if (ck)
                registerEdgeStrip(w, orient, ck.x, ck.y, {
                  orient,
                  side: opposite(ck.planSide),
                  style,
                  theme: ck.theme,
                  base: ck.base,
                  top: ck.top,
                });
            }
          }
          i += n;
          done = true;
          break;
        }
        if (!done) i++;
      }
    }
  };
  doRuns("h");
  doRuns("v");
}

// corner posts: quadrants around a vertex left uncovered where an h strip and a v strip meet
export function layCornerPosts(w: LevelWork): void {
  const { L, strips, emit } = w;
  const { gen, frame, lookup, pick } = w.ctx;
  for (const [k, list] of strips) {
    const [vx, vy] = k.split(",").map(Number) as [number, number];
    const covered = new Set(
      list.map((s) => (s.orient === "h" ? `${s.side}${s.dir}` : `${s.dir}${s.side}`)),
    );
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
      const slack = gen.exactWallTops ? Math.min(0.5, v.unitHeight / 4) : 0;
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
