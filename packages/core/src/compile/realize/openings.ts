/**
 * Realize, opening pass: doors, arches, windows and secret doors in their wall line, the wall pieces or lintel above
 * a door shorter than its wall, and the strips the corner posts need.
 * Reads: the level's openings, their wall faces (`faces`), `claimed` (openings a building builds itself).
 * Writes: opening and wall placements, `CornerStrips`; secret-door and missing-piece diagnostics.
 */
import type { ResolvedOpening } from "../../contracts/resolved";
import type { ResolvedVariant } from "../../palette/resolve";
import { elementTheme } from "../../resolve/levelGrid";
import type { WallFace } from "../../resolve/wallFaces";
import { faceEdgeCtx, lenFilter, lengthOf, placeEdgePiece, type CornerStrips, type EdgeCtx } from "./edges";
import { OPPOSITE } from "../../gen/gridGeometry";
import { isFullHeightOpeningRole, isGap, isOpenWithoutPiece, isSecret } from "../../gen/openingKinds";
import {
  THEME_LINTEL_ROLE,
  THEME_WALL_ROLE,
  lintelRole,
  openingRole,
  roleFamily,
  wallRole,
} from "../../palette/roles";
import { EPS, type RealizeLevel } from "./level";
import { maxOf } from "../../util/lists";

// openings
export function layOpenings(lv: RealizeLevel, strips: CornerStrips): void {
  for (const op of lv.L.openings) {
    if (isGap(op.kind) || lv.claimed.openings.has(op.id)) continue;
    layOpening(lv, strips, op);
  }
}

/** One opening: its edges tiled with the longest opening pieces that fit, each closed above up to its wall top. */
function layOpening(lv: RealizeLevel, strips: CornerStrips, op: ResolvedOpening): void {
  const { L } = lv;
  const { lookup, pick, addDiag } = lv.ctx;
  const ctxs = openingEdges(lv, op);
  const first = ctxs[0];
  if (!first) return;
  const roleName = openingRole(op.kind);
  const theme = elementTheme(op.theme, first.theme);
  const res = lookup(L.id, theme, [roleName]);
  if (!res) return;
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
      const r = lookup(L.id, theme, [roleName], lenFilter(n), true);
      const pool = r ? r.variants.filter((v) => v.weight > 0) : [];
      const v = r ? (pool.length ? pick(pool, `${L.id}:opening:${op.id}:${i}`) : r.variants[0]) : undefined;
      if (!v || !r) continue;
      // the role that supplied the piece: an opening's own, or (a kit without one) its wall style's
      const family = roleFamily(r.role);
      const isDoor = family === roleFamily(roleName);
      const source = { cell: [c.hostX, c.hostY] as [number, number], elementId: op.id };
      placeEdgePiece(lv, v, family === roleFamily(THEME_WALL_ROLE) ? "wall" : "opening", c, n, {
        yBase: c.base,
        count: 1,
        source,
        ...(isDoor ? { door: r.role } : {}),
      });
      if (isSecret(op.kind) && i === 0) noteSecretDoorPlug(lv, op, c, v, r.role);
      // wall pieces above a door shorter than the wall
      const leafTop = c.base + v.unitHeight;
      const wallTop = maxOf(ctxs.slice(i, i + n).map((q) => q.top));
      for (let k = 0; k < n; k++) {
        const ck = ctxs[i + k];
        if (!ck) continue;
        strips.register(op.orientation, ck.x, ck.y, {
          orient: op.orientation,
          side: OPPOSITE[ck.planSide],
          style: op.wallStyle,
          theme: ck.theme,
          base: ck.base,
          top: wallTop,
        });
        // a whole-wall piece (an arch, a window) has nothing above it (gen/openingKinds.ts `fullHeight`)
        closeAboveLeaf(lv, op, ck, leafTop, wallTop, isDoor && !isFullHeightOpeningRole(r.role));
      }
      placed = n;
      break;
    }
    if (!placed) {
      // A passage with no leaf (an archway) left as a plain gap is still a correct, passable opening: info, not a warning.
      const isArch = isOpenWithoutPiece(op.kind);
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

/**
 * The opening's edges (its wall faces, resolve/wallFaces.ts) as pieces standing on them see them, all hosted on the
 * first edge's side: one piece spans several edges, so it stands on one side of all of them (each edge keeps its own
 * wall height and span).
 */
function openingEdges(lv: RealizeLevel, op: ResolvedOpening): EdgeCtx[] {
  const { V, faces } = lv;
  const orient = op.orientation;
  const found: WallFace[] = [];
  for (let k = 0; k < op.width; k++) {
    const x = orient === "h" ? op.start[0] + k : op.start[0];
    const y = orient === "h" ? op.start[1] : op.start[1] + k;
    const f = faces.at(orient, orient === "h" ? V.hEdge(x, y) : V.vEdge(x, y));
    if (f) found.push(f);
  }
  const hostFirst = found[0]?.hostFirst ?? true;
  return found.map((f) => faceEdgeCtx(faces.hostedOn(f, hostFirst)));
}

/**
 * Generator 4 (`secretDoorPlug`): a secret door is ONE removable plug in the wall line (the palette's
 * `opening.secret_door` piece, else the wall style's own piece); the build report says where it stands so a GM can find
 * and delete it.
 */
function noteSecretDoorPlug(
  lv: RealizeLevel,
  op: ResolvedOpening,
  c: EdgeCtx,
  v: ResolvedVariant,
  role: string,
): void {
  const { L } = lv;
  if (!lv.ctx.profile.secretDoorPlug) return;
  const sideName = { N: "north", S: "south", E: "east", W: "west" }[c.planSide];
  const [a, b] = op.sides;
  lv.ctx.addDiag({
    severity: "info",
    code: "secret_door_plug",
    message: `Secret door ${op.id} between ${a ?? "?"} and ${b ?? "?"} on level ${L.id} at cell ${c.hostX},${c.hostY} (${sideName} wall, floor level ${c.base}): delete the ${v.name} standing in that wall to open the way.`,
    levelId: L.id,
    elementId: op.id,
    role,
  });
}

/**
 * Above the leaf on one edge: wall pieces up to the wall top when the wall stands a quarter tile or more over the leaf,
 * else (a door that takes one) the kit's lintel piece.
 */
function closeAboveLeaf(
  lv: RealizeLevel,
  op: ResolvedOpening,
  ck: EdgeCtx,
  leafTop: number,
  wallTop: number,
  takesLintel: boolean,
): void {
  const { L } = lv;
  const { lookup, pick } = lv.ctx;
  const source = { cell: [ck.hostX, ck.hostY] as [number, number], elementId: op.id };
  if (wallTop > leafTop + 0.25 - EPS) {
    const wr = lookup(L.id, ck.theme, [wallRole(op.wallStyle)], lenFilter(1), true);
    const wv = wr ? pick(wr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
    if (wv && (wr?.def.mount ?? "half-cell") === "half-cell") {
      const cnt = Math.ceil((wallTop - leafTop) / wv.unitHeight - EPS);
      placeEdgePiece(lv, wv, "wall", ck, 1, { yBase: leafTop, count: cnt, source });
    }
  } else if (takesLintel) {
    // Kit walls are visually taller than their doors (in-game 2026-11-18): close the notch with the kit's lintel piece
    // when the palette has one (data-driven; absent role = no lintel, no warning).
    const lr = lookup(
      L.id,
      elementTheme(op.theme, ck.theme),
      [lintelRole(op.wallStyle), THEME_LINTEL_ROLE],
      lenFilter(1),
      true,
    );
    const lintel = lr ? pick(lr.variants, `${L.id}:lintel:${ck.x}:${ck.y}`) : undefined;
    if (lintel) placeEdgePiece(lv, lintel, "opening", ck, 1, { yBase: leafTop, count: 1, source });
  }
}
