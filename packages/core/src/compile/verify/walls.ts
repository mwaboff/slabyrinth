/**
 * Structure: every floor cell has a floor tile under its top, and every wall edge is covered by wall pieces as realize
 * builds it (the faces of resolve/wallFaces.ts: style, theme, span and the cell its mass stands in).
 *
 * Emits, per level: `verify_floor_missing` (error; warning when realize already reported a missing floor role), then
 * `verify_wall_gap` (error). Each is one diagnostic per level naming the first cell and the count.
 */
import type { ResolvedLevel } from "../../contracts/resolved";
import type { Side } from "../../contracts/plan";
import { BUILD_CONSTANTS } from "../../contracts/plan";
import { EDGE } from "../../contracts/resolved";
import { SIDE_STEP } from "../../gen/gridGeometry";
import { sideOrient, type LevelGrid } from "../../resolve/levelGrid";
import { edgeWallHeight } from "../../resolve/wallspan";
import type { LevelWalls, VerifyCtx } from "./context";
import type { Solid, SolidIndex } from "./grid";
import { ROCK_WALL_CLOSED, RUINED_WALL_STANDS, WALL_SAMPLE_INSET } from "./limits";
import { fmt } from "./words";

/** Wall and opening pieces: what closes a wall edge (with raised fill). */
export const wallish = (s: Solid): boolean =>
  s.role === "wall" || s.role === "wall_post" || s.role === "opening";

export function checkFloorsAndWalls(ctx: VerifyCtx, solids: SolidIndex): void {
  for (const L of ctx.levels) {
    const g = ctx.grids.get(L.id);
    const walls = ctx.walls.get(L.id);
    if (!g || !walls) continue;
    checkFloorTiles(ctx, solids, L, g);
    checkWallCoverage(ctx, solids, L, g, walls);
  }
}

/** `verify_floor_missing`: a floor cell with no floor, fill, link or ledge piece just under its top. */
function checkFloorTiles(ctx: VerifyCtx, solids: SolidIndex, L: ResolvedLevel, g: LevelGrid): void {
  let missing = 0;
  let first: [number, number] | null = null;
  for (let ly = 0; ly < g.h; ly++)
    for (let lx = 0; lx < g.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      if (!g.cell(x, y).floor) continue;
      const top = g.top(x, y);
      const p = solids.toWorld(x + 0.5, y + 0.5);
      // the top 0.05 to 0.2 under the floor top: the upper part of a floor tile
      const has = solids
        .at(p.x, p.z, top - 0.2, top - 0.05)
        .some(
          (s) =>
            s.levelId === L.id &&
            (s.role === "floor" || s.role === "fill" || s.role === "link" || s.role === "ledge"),
        );
      if (!has) {
        missing++;
        first ??= [x, y];
      }
    }
  if (missing === 0 || !first) return;
  const mat = g.cell(first[0], first[1]).material ?? "?";
  ctx.report.add({
    severity: ctx.floorRoleMissing.has(L.id) ? "warning" : "error",
    code: "verify_floor_missing",
    levelId: L.id,
    cell: first,
    count: missing,
    message: `${missing} floor cell${missing > 1 ? "s have" : " has"} no floor tile on level ${L.id} (first at ${fmt(first)}, material ${mat}).`,
    hint: `Use a floor material the theme has assets for (e.g. flagstone, wood_plank, rock, grass) instead of "${mat}".`,
  });
}

interface WallGap {
  cell: [number, number];
  side: Side;
  style: string;
  /** A rock-block wall between two open cells: it needs a solid cell to stand in and has none. */
  blockBetweenOpen: boolean;
  mount: string;
}

/**
 * `verify_wall_gap`: a wall edge whose pieces do not cover it, sampled in the half cell (a block: the mass cell) the
 * wall is built in, at the foot and the top of its span. Edges are visited cell by cell (north and west edge of every
 * cell, plus the south and east border), which decides the first gap named.
 */
function checkWallCoverage(
  ctx: VerifyCtx,
  solids: SolidIndex,
  L: ResolvedLevel,
  g: LevelGrid,
  { claims, faces }: LevelWalls,
): void {
  let gaps = 0;
  let firstGap: WallGap | null = null;
  for (let ly = 0; ly < g.h; ly++)
    for (let lx = 0; lx < g.w; lx++) {
      const x = L.bounds.x + lx;
      const y = L.bounds.y + ly;
      const sides: Side[] = ["N", "W"];
      if (ly === g.h - 1) sides.push("S");
      if (lx === g.w - 1) sides.push("E");
      for (const side of sides) {
        const orient = sideOrient(side);
        const ei = g.edgeIndex(x, y, side);
        const face = faces.at(orient, ei);
        if (!face || face.kind !== EDGE.WALL) continue;
        const hostedHere = face.host.x === x && face.host.y === y;
        const { style } = face;
        const [dx, dy] = SIDE_STEP[side];
        const other = g.cell(x + dx, y + dy);
        const here = g.cell(x, y);
        // the theme realize builds the wall in (its mount decides how the wall is measured)
        const res = ctx.resolveRole(face.theme, `wall.${style}`).resolution;
        if (!res) continue; // role_missing already reported by realize
        const mount = res.def.mount ?? "half-cell";
        const base = face.base;
        const inside = hostedHere ? other : here; // shells host outside the footprint
        const floorTop = L.elevation + inside.height + BUILD_CONSTANTS.floorThickness;
        // a building's shell edge (compile/structure.ts) stands on the building's own floor: its storey height is
        // measured from there, not from higher ground outside; a ruin's walls only need to stand a tile above it
        const top = face.claimed
          ? claims.ruined.has(`${orient}${ei}`)
            ? floorTop + RUINED_WALL_STANDS
            : Math.min(face.top, floorTop + edgeWallHeight(g.edges(orient), ei))
          : face.top;
        // a rock block stands in the face's mass cell (realize: compile/realize/walls.ts gatherFullCells); with no
        // mass cell past the board edge (an exit) nothing stands there and the edge is not a gap
        if (mount === "full-cell" && !face.mass && !(face.host.open && face.other.open)) continue;
        const massHere = face.mass !== null && face.mass.x === x && face.mass.y === y;
        const intoHere = mount === "full-cell" && face.mass ? massHere : hostedHere;
        const pt = solids.toWorld(...wallSamplePoint(x, y, side, mount, intoHere));
        const heights =
          mount === "half-cell"
            ? [base + WALL_SAMPLE_INSET, top - WALL_SAMPLE_INSET]
            : mount === "full-cell"
              ? [base + WALL_SAMPLE_INSET, Math.min(top, base + ROCK_WALL_CLOSED) - WALL_SAMPLE_INSET]
              : [base + WALL_SAMPLE_INSET];
        const covered = heights.every((yy) =>
          solids
            .at(pt.x, pt.z, yy - 0.01, yy + 0.01, 0.005)
            .some((s) => s.levelId === L.id && (wallish(s) || s.role === "fill")),
        );
        if (covered) continue;
        gaps++;
        firstGap ??= {
          cell: [x, y],
          side,
          style,
          blockBetweenOpen: mount === "full-cell" && here.open && other.open,
          mount,
        };
      }
    }
  if (gaps === 0 || !firstGap) return;
  ctx.report.add({
    severity: "error",
    code: "verify_wall_gap",
    levelId: L.id,
    cell: firstGap.cell,
    side: firstGap.side,
    count: gaps,
    message: firstGap.blockBetweenOpen
      ? `${gaps} wall edge${gaps > 1 ? "s" : ""} on level ${L.id} cannot be built: the 2D map shows a ${firstGap.style} wall between two open areas at the ${firstGap.side} side of ${fmt(firstGap.cell)}, but rock-block walls need a solid cell, so the build leaves the gap open.`
      : `${gaps} wall edge${gaps > 1 ? "s are" : " is"} not fully covered by wall pieces on level ${L.id} (first: ${firstGap.side} side of ${fmt(firstGap.cell)}, style ${firstGap.style}).`,
    hint: firstGap.blockBetweenOpen
      ? `Natural rock is built as whole-cell blocks and needs a solid cell: leave one unclaimed (solid) cell between the two areas there, or merge them into one area. A thin built wall (wallStyle "wall") is the only other choice and looks like masonry, not rock.`
      : `The theme has no "${firstGap.style}" wall piece that fits this edge (${firstGap.mount} mount), so the build leaves it open. Use a wallStyle the theme has pieces for (list_catalog wall_styles), or leave a solid cell beside the area so a whole-cell block has somewhere to stand.`,
  });
}

/**
 * Where a wall on `side` of cell (x, y) is sampled (plan coordinates): the edge's midpoint moved into the wall's own
 * part of the cell (`intoHere`) or of its neighbour: a quarter tile for a half-cell piece, half a tile for a block, none
 * for a piece centred on the edge.
 */
function wallSamplePoint(
  x: number,
  y: number,
  side: Side,
  mount: string,
  intoHere: boolean,
): [number, number] {
  const mx = side === "W" ? x : side === "E" ? x + 1 : x + 0.5;
  const my = side === "N" ? y : side === "S" ? y + 1 : y + 0.5;
  const hostSign = intoHere ? 1 : -1; // +1 = into (x,y), -1 = into the neighbour
  const inward = mount === "edge-center" ? 0 : mount === "full-cell" ? 0.5 : 0.25;
  const ix = side === "W" ? inward * hostSign : side === "E" ? -inward * hostSign : 0;
  const iy = side === "N" ? inward * hostSign : side === "S" ? -inward * hostSign : 0;
  return [mx + ix, my + iy];
}
