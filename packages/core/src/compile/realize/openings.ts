/**
 * Realize, opening pass: doors, arches, windows and secret doors in their wall line, the wall pieces or lintel above
 * a door shorter than its wall, and the strips the corner posts need.
 * Reads: the level's openings and edges, `claimed` (openings a building builds itself). Writes: opening and wall
 * placements, `strips`; secret-door and missing-piece diagnostics.
 */
import { EPS, opposite, type EdgeCtx, type LevelWork } from "./work";
import { edgeCtx, lenFilter, lengthOf, placeEdgePiece, registerEdgeStrip } from "./edges";

/** Opening roles whose asset is a full-height wall piece (no lintel above them). */
const NO_LINTEL = new Set(["opening.archway", "opening.window", "opening.arrow_slit"]);

// openings
export function layOpenings(w: LevelWork): void {
  const { L, V, claimed } = w;
  const { gen, lookup, pick, addDiag } = w.ctx;
  for (const op of L.openings) {
    if (op.kind === "open" || claimed.openings.has(op.id)) continue;
    const orient = op.orientation;
    const grid = orient === "h" ? L.hEdges : L.vEdges;
    const ctxs: EdgeCtx[] = [];
    for (let k = 0; k < op.width; k++) {
      const x = orient === "h" ? op.start[0] + k : op.start[0];
      const y = orient === "h" ? op.start[1] : op.start[1] + k;
      const e = orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y);
      if (e < 0) continue;
      ctxs.push(edgeCtx(w, orient, x, y, grid, e, (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2));
    }
    const first = ctxs[0];
    if (!first) continue;
    // all edges of one opening use the first edge's host side
    for (const c of ctxs) {
      if (c.hostFirst !== first.hostFirst) {
        const e = orient === "h" ? V.hEdge(c.x, c.y) : V.vEdge(c.x, c.y);
        // keep the edge's real wall height (was hard-coded to 2, leaving a gap above doors in taller walls)
        const h = (grid.height[e] ?? 0) > 0 ? (grid.height[e] ?? 2) : 2;
        Object.assign(
          c,
          edgeCtx(
            w,
            orient,
            c.x,
            c.y,
            { ...grid, host: grid.host.map(() => (first.hostFirst ? 0 : 1)) },
            e,
            h,
          ),
        );
      }
    }
    const roleName = `opening.${op.kind}`;
    const res = lookup(L.id, op.theme || first.theme, [roleName]);
    if (!res) continue;
    const lengths = [
      ...new Set(res.variants.filter((v) => v.weight > 0 || res.variants.length === 1).map(lengthOf)),
    ].sort((a, b) => b - a);
    let i = 0;
    while (i < ctxs.length) {
      const remaining = ctxs.length - i;
      const c = ctxs[i];
      if (!c) break;
      let placed = 0;
      for (const n of lengths.filter((l) => l <= remaining)) {
        const r = lookup(L.id, op.theme || first.theme, [roleName], lenFilter(n), true);
        const pool = r ? r.variants.filter((v) => v.weight > 0) : [];
        const v = r
          ? pool.length
            ? pick(pool, `${L.id}:opening:${op.id}:${i}`)
            : r.variants[0]
          : undefined;
        if (!v || !r) continue;
        const isDoor = r.role.startsWith("opening.");
        placeEdgePiece(
          w,
          v,
          r.role.startsWith("wall.") ? "wall" : "opening",
          r.role,
          c,
          n,
          c.base,
          1,
          { cell: [c.hostX, c.hostY], elementId: op.id },
          isDoor,
        );
        // generator 4: a secret door is ONE removable plug in the wall line (the palette's `opening.secret_door` piece, else
        // the wall style's own piece); the build report says where it stands so a GM can find and delete it
        if (op.kind === "secret_door" && gen.secretDoorPlug && i === 0) {
          const sideName = { N: "north", S: "south", E: "east", W: "west" }[c.planSide];
          const [a, b] = op.sides;
          addDiag({
            severity: "info",
            code: "secret_door_plug",
            message: `Secret door ${op.id} between ${a ?? "?"} and ${b ?? "?"} on level ${L.id} at cell ${c.hostX},${c.hostY} (${sideName} wall, floor level ${c.base}): delete the ${v.name} standing in that wall to open the way.`,
            levelId: L.id,
            elementId: op.id,
            role: r.role,
          });
        }
        // wall pieces above a door shorter than the wall
        const leafTop = c.base + v.unitHeight;
        const wallTop = Math.max(...ctxs.slice(i, i + n).map((q) => q.top));
        for (let k = 0; k < n; k++) {
          const ck = ctxs[i + k];
          if (!ck) continue;
          registerEdgeStrip(w, orient, ck.x, ck.y, {
            orient,
            side: opposite(ck.planSide),
            style: op.wallStyle,
            theme: ck.theme,
            base: ck.base,
            top: wallTop,
          });
          if (wallTop > leafTop + 0.25 - EPS) {
            const wr = lookup(L.id, ck.theme, [`wall.${op.wallStyle}`], lenFilter(1), true);
            const wv = wr ? pick(wr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
            if (wv && (wr?.def.mount ?? "half-cell") === "half-cell") {
              const cnt = Math.ceil((wallTop - leafTop) / wv.unitHeight - EPS);
              placeEdgePiece(
                w,
                wv,
                "wall",
                `wall.${op.wallStyle}`,
                ck,
                1,
                leafTop,
                cnt,
                { cell: [ck.hostX, ck.hostY], elementId: op.id },
                false,
              );
            }
          } else if (isDoor && !NO_LINTEL.has(r.role)) {
            // Kit walls are visually taller than their doors (in-game 2026-11-18): close the notch with the
            // kit's lintel piece when the palette has one (data-driven; absent role = no lintel, no warning).
            const lr = lookup(
              L.id,
              op.theme || ck.theme,
              [`lintel.${op.wallStyle}`, "lintel.wall"],
              lenFilter(1),
              true,
            );
            const lv = lr ? pick(lr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
            if (lv) {
              placeEdgePiece(
                w,
                lv,
                "opening",
                lr?.role ?? "lintel.wall",
                ck,
                1,
                leafTop,
                1,
                { cell: [ck.hostX, ck.hostY], elementId: op.id },
                false,
              );
            }
          }
        }
        placed = n;
        break;
      }
      if (!placed) {
        // An archway left as a plain gap is still a correct, passable opening: info, not a warning.
        const isArch = op.kind === "archway";
        addDiag({
          severity: isArch ? "info" : "warning",
          code: "role_missing",
          message: isArch
            ? `No ${remaining}-wide arch piece in the palette for archway ${op.id}; it is built as a plain opening`
            : `No "${roleName}" piece fits the remaining ${remaining}-edge span; left open`,
          levelId: L.id,
          role: roleName,
          elementId: op.id,
        });
        break;
      }
      i += placed;
    }
  }
}
