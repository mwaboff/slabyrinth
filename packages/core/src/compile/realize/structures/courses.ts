/**
 * Realize, a building storey's walls: the footing course, the main course (length-2 pieces along runs), the openings
 * with their fillers above, and the outer corner posts.
 *   walls      facade.<style> → wall.<style> → wall.wall
 *   footing    footing.<style> → facade.<style> → wall.<style>
 *   posts      facade_post.<style> → wall_post.<style> → wall_post.wall
 *   doors      opening.<kind>.<use family> (designed ground storeys) → opening.<kind>.<style> → opening.<kind>;
 *              over the leaf over_door.<style> → footing.<footing style> → the wall chain
 *   windows    window.<style> → opening.window.<style> → opening.window
 * Reads: the storey (`CourseArgs`). Writes: wall, opening and post placements; `LitWindow`s (the windows built, read by
 * the window lights); role_missing info for an opening with no piece.
 */
import type { RoleName } from "../../../contracts/compiler";
import type { Side, WallStyle } from "../../../contracts/plan";
import type { ResolvedVariant } from "../../../palette/resolve";
import { SIDE_STEP } from "../../../gen/gridGeometry";
import { hasLeaf, isGap, isOpenWithoutPiece, isWindow } from "../../../gen/openingKinds";
import { lenFilter } from "../../../palette/filters";
import {
  THEME_POST_ROLE,
  THEME_WALL_ROLE,
  openingRole,
  partRole,
  postRole,
  styledOpeningRole,
  wallRole,
} from "../../../palette/roles";
import { EPS } from "../level";
import { groundTop, info, type StructureCtx } from "./context";
import type { StoreyOpening } from "./openings";
import {
  alongFace,
  cellOfKey,
  edgePiece,
  faceKey,
  faceRunsOf,
  key,
  stackEdge,
  type FaceCell,
  type Part,
} from "./pieces";
import { pushAll } from "../../../util/lists";

/** A window built on a storey: the window lights (attachments.ts) light a share of them. */
export interface LitWindow {
  x: number;
  y: number;
  face: Side;
  floorTop: number;
  layer: string;
  walls: WallStyle;
}

export interface CourseArgs {
  s: number;
  /** Weathered or ruined: the surviving top of each wall column ("x,y,face"), absolute; the walls stop there. */
  caps?: ReadonlyMap<string, number>;
  /** A ruin: open doorways and breaches get no filler above them. */
  openTop?: boolean;
  /** Ruins (generator 3): openings whose frame and arch stand on ("x,y,face" of the first cell). */
  arches?: ReadonlySet<string>;
  faces: FaceCell[];
  own: ReadonlySet<string>;
  ops: ReadonlyMap<string, StoreyOpening>;
  floorTop: number;
  top: number;
  footing: { style: WallStyle; height: number } | null;
  walls: WallStyle;
  ground: boolean;
  layer: string;
  chimneyWall: ReadonlySet<string>;
  tag: string;
  windows: LitWindow[];
  /** Door family for the building's use (resolve/building/parts.ts), tried before the wall style's doors. */
  doorUse?: string;
  /**
   * Generator 5 (postsAtBuildingCorners): the cells filled at this storey (resolve/structureFaces.ts `storeyFill`): a
   * corner post stands only where none round the corner is. Absent, the storey's own cells alone are asked.
   */
  filled?: (x: number, y: number) => boolean;
}

/** The wall chain of a style: its facade, its wall, the theme's wall. */
const wallChain = (style: WallStyle): RoleName[] => [
  partRole("facade", style),
  wallRole(style),
  THEME_WALL_ROLE,
];

/** The post chain of a style. */
const postChain = (style: WallStyle): RoleName[] => [
  partRole("facade_post", style),
  postRole(style),
  THEME_POST_ROLE,
];

/** One storey's walls: footing course, main course, openings with fillers, corner posts. */
export function layCourses(b: StructureCtx, a: CourseArgs): void {
  const { faces, ops, floorTop, top, footing, chimneyWall } = a;
  const mainBase = floorTop + (footing?.height ?? 0);
  // a window whose column has broken off below the storey's top is gone: its cells are built as broken wall
  const brokenOps = new Set<string>();
  if (a.caps)
    for (const [k, op] of ops)
      if (isWindow(op.kind) && (a.caps.get(k) ?? Infinity) < top - EPS) brokenOps.add(op.id);
  // ruins break cell by cell: one-cell pieces where the style has them (asked first: lookups are recorded in order)
  const single =
    a.openTop === true && a.caps !== undefined && b.lookup(wallChain(a.walls), lenFilter(1), true) !== null;
  // ground storey walls reach down to the ground outside when the pad is higher than its surroundings
  const lowAt = (f: FaceCell): number => {
    if (!a.ground) return floorTop;
    const [dx, dy] = SIDE_STEP[f.face];
    return Math.min(floorTop, groundTop(b.lv, f.x + dx, f.y + dy));
  };
  // footing course (ground storey)
  if (footing) {
    const fs = footing.style;
    for (const f of faces) {
      const op = ops.get(faceKey(f.x, f.y, f.face));
      if (chimneyWall.has(faceKey(f.x, f.y, f.face))) continue;
      if (op && !isWindow(op.kind)) continue;
      stackEdge(
        b,
        [partRole("footing", fs), partRole("facade", fs), wallRole(fs)],
        "wall",
        f,
        lowAt(f),
        mainBase,
        { id: `${a.tag}~footing`, layer: a.layer },
        { allowBelow: true },
      );
    }
  }
  layMainCourse(b, a, mainBase, brokenOps, single, lowAt);
  layOpenings(b, a, mainBase, brokenOps);
  layCornerPosts(b, a, mainBase);
}

/** A broken column's surviving top ("x,y,face"), or no limit. */
const capOf =
  (a: CourseArgs) =>
  (x: number, y: number, face: Side): number =>
    a.caps?.get(faceKey(x, y, face)) ?? Infinity;

/** The main course: plain wall runs, length-2 pieces where they fit. */
function layMainCourse(
  b: StructureCtx,
  a: CourseArgs,
  mainBase: number,
  brokenOps: ReadonlySet<string>,
  single: boolean,
  lowAt: (f: FaceCell) => number,
): void {
  const { s, faces, ops, floorTop, top, footing, chimneyWall, tag } = a;
  const { L } = b.lv;
  const { pick } = b.lv.ctx;
  const mainRoles = wallChain(a.walls);
  const capAt = capOf(a);
  const part: Part = { id: `${tag}~wall`, layer: a.layer };
  const plain = faces.filter((f) => {
    const op = ops.get(faceKey(f.x, f.y, f.face));
    return (!op || brokenOps.has(op.id)) && !chimneyWall.has(faceKey(f.x, f.y, f.face));
  });
  for (const run of faceRunsOf(plain)) {
    let i = 0;
    while (i < run.length) {
      const f = run[i] as FaceCell;
      const lo = a.ground && !footing ? lowAt(f) : mainBase;
      const flatBase = a.ground && !footing ? Math.abs(lo - mainBase) < EPS : true;
      let placed = 0;
      for (const n of [2, 1]) {
        if (n > run.length - i) continue;
        if (n === 2 && single) continue;
        if (n === 2) {
          const g = run[i + 1] as FaceCell;
          const lo2 = a.ground && !footing ? lowAt(g) : mainBase;
          if (!flatBase || Math.abs(lo2 - lo) > EPS) continue;
        }
        const r = b.lookup(mainRoles, lenFilter(n), n !== 1);
        const v = r ? pick(r.variants, `${L.id}:${tag}:w${s}:${f.x},${f.y}${f.face}`) : undefined;
        if (!v) continue;
        const next = alongFace(f, 1);
        // a broken column stops at its surviving top
        const capped = Math.min(
          top,
          capAt(f.x, f.y, f.face),
          n === 2 ? capAt(next.x, next.y, next.face) : Infinity,
        );
        if (a.ground) {
          // from the top down: the lowest piece may reach into the ground outside (a broken one below the floor)
          const count = Math.max(1, Math.ceil((capped - lo) / v.unitHeight - EPS));
          for (let k = 0; k < count; k++)
            edgePiece(b, v, "wall", f, n, capped - (count - k) * v.unitHeight, part);
        } else if (capped > floorTop + 0.2) upperCourse(b, v, f, n, floorTop - 0.5, capped, a.walls, part);
        placed = n;
        break;
      }
      i += Math.max(1, placed);
    }
  }
}

/** The openings on this storey's faces, each with the filler above a leaf shorter than the wall. */
function layOpenings(b: StructureCtx, a: CourseArgs, mainBase: number, brokenOps: ReadonlySet<string>): void {
  const { faces, ops, floorTop, top, footing } = a;
  const { L } = b.lv;
  const { pick } = b.lv.ctx;
  const style = a.walls;
  const capAt = capOf(a);
  const faceKeys = new Set(faces.map((f) => faceKey(f.x, f.y, f.face)));
  const done = new Set<string>();
  for (const op of ops.values()) {
    if (done.has(op.id) || brokenOps.has(op.id)) continue;
    done.add(op.id);
    const f = op.first;
    if (!faceKeys.has(faceKey(f.x, f.y, f.face))) continue;
    const windowed = isWindow(op.kind);
    const part: Part = { id: op.id, layer: a.layer };
    // upper-storey windows sit on the wall top below (the floor band is wall), ground ones on the footing
    const base = windowed ? (a.ground ? mainBase : floorTop - 0.5) : floorTop;
    const roles = windowed
      ? [partRole("window", style), styledOpeningRole(op.kind, style), openingRole(op.kind)]
      : [
          ...(a.ground && a.doorUse ? [styledOpeningRole(op.kind, a.doorUse)] : []),
          styledOpeningRole(op.kind, style),
          openingRole(op.kind),
        ];
    let i = 0;
    let leafTop = base;
    while (i < op.width) {
      const c = alongFace(f, i);
      let n = 0;
      if (!isGap(op.kind))
        // the style's own role first in every length, before a broader role (no 2-wide window of another kit
        // where the style has 1-wide ones)
        for (const [role, len] of roles.flatMap((ro) =>
          [op.width - i, 2, 1]
            .filter((l, j, arr) => l >= 1 && l <= op.width - i && arr.indexOf(l) === j)
            .map((l) => [ro, l] as const),
        )) {
          const r = b.lookup([role], lenFilter(len), true);
          const v = r ? pick(r.variants, `${L.id}:${op.id}:${i}`) : undefined;
          if (!v || !r) continue;
          edgePiece(b, v, "opening", c, len, base, part, hasLeaf(op.kind) ? r.role : undefined);
          leafTop = base + v.unitHeight;
          n = len;
          break;
        }
      if (n === 0) {
        if (!isOpenWithoutPiece(op.kind))
          info(
            b.lv,
            "role_missing",
            `No "${roles[roles.length - 1] ?? ""}" piece for ${op.id}; left open`,
            roles[0],
          );
        n = 1;
        leafTop = base + 2;
      }
      // filler above a door shorter than the wall (lintel), down to nothing when the door fills the course
      for (let k = 0; k < n; k++) {
        const e = alongFace(c, k);
        if (windowed)
          a.windows.push({ x: e.x, y: e.y, face: f.face, floorTop, layer: a.layer, walls: style });
        // (a ruin's empty doorways and breaches stay open to the top: broken wall stubs either side)
        const tc = Math.min(top, capAt(e.x, e.y, f.face));
        const standing = a.arches?.has(faceKey(f.x, f.y, f.face)) === true;
        if (tc - leafTop > 0.2 && !(a.openTop && isGap(op.kind) && !standing)) {
          const lintel = [partRole("over_door", style)];
          if (footing) lintel.push(partRole("footing", footing.style));
          pushAll(lintel, wallChain(style));
          // (over an empty doorway the grid has no opening edge, so the lintel is a wall piece, not a door piece)
          stackEdge(b, lintel, isGap(op.kind) ? "wall" : "opening", e, leafTop, tc, part, {
            shortRoles: [partRole("over_door", style)],
          });
        }
      }
      i += n;
    }
  }
}

/** The outer corner posts of the storey's cells (footing course and wall course). */
function layCornerPosts(b: StructureCtx, a: CourseArgs, mainBase: number): void {
  const { floorTop, top, footing, tag } = a;
  const { L, emit } = b.lv;
  const { frame, pick } = b.lv.ctx;
  const style = a.walls;
  const capAt = capOf(a);
  const filled = a.filled ?? ((x: number, y: number): boolean => a.own.has(key(x, y)));
  for (const k of a.own) {
    const [cx, cy] = cellOfKey(k);
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      if (filled(cx + dx, cy) || filled(cx, cy + dy) || filled(cx + dx, cy + dy)) continue;
      const px = dx < 0 ? cx - 0.5 : cx + 1;
      const py = dy < 0 ? cy - 0.5 : cy + 1;
      // upper courses close the floor band
      const lo = a.ground ? Math.min(floorTop, groundTop(b.lv, cx + dx, cy + dy)) : floorTop - 0.5;
      // a broken corner stands no higher than the lower of its two walls
      const ptop = Math.min(top, capAt(cx, cy, dx < 0 ? "W" : "E"), capAt(cx, cy, dy < 0 ? "N" : "S"));
      const courses: Array<[RoleName[], number, number]> = [];
      if (footing) {
        courses.push([postChain(footing.style), lo, Math.min(mainBase, ptop)]);
        courses.push([postChain(style), mainBase, ptop]);
      } else courses.push([postChain(style), lo, ptop]);
      for (const [roles, ya, yb] of courses) {
        const r = b.lookup(roles, undefined, true);
        const v = r ? pick(r.variants, `${L.id}:${tag}:post:${px},${py}`) : undefined;
        // a post taller than its course would poke into the ground or past the wall: leave the corner open
        // (a ruin's ground corner stub is built top-down like its walls, reaching below the floor)
        if (!v || yb - ya < 0.05 || (v.unitHeight > yb - ya + 0.3 && !(a.caps && a.ground))) continue;
        const m = frame.rectMin(px, py, 0.5, 0.5);
        const n = Math.max(1, Math.ceil((yb - ya) / v.unitHeight - EPS));
        for (let j = 0; j < n; j++)
          emit(
            v,
            "wall_post",
            m.x,
            // ground: from the top down (into the ground); upper storeys: from the floor up, the last one top-aligned
            a.ground ? yb - (n - j) * v.unitHeight : Math.min(ya + j * v.unitHeight, yb - v.unitHeight),
            m.z,
            v.rot,
            { cell: [Math.floor(px), Math.floor(py)], elementId: `${tag}~post` },
            a.layer,
          );
      }
    }
  }
}

/**
 * An upper storey's wall course on one run of n face cells: full pieces from the floor up, then short pieces
 * (wall_short / over_door / footing of the style) for a remainder, else one more full piece aligned to the top
 * (overlapping its own course, never the storey below).
 */
function upperCourse(
  b: StructureCtx,
  v: ResolvedVariant,
  f: FaceCell,
  n: number,
  lo: number,
  top: number,
  style: WallStyle,
  part: Part,
): void {
  const u = v.unitHeight;
  const full = Math.max(0, Math.floor((top - lo) / u + EPS));
  for (let k = 0; k < full; k++) edgePiece(b, v, "wall", f, n, lo + k * u, part);
  let y = lo + full * u;
  if (top - y <= 0.2) return;
  const shortRoles = [
    partRole("wall_short", style),
    partRole("over_door", style),
    partRole("footing", style),
  ];
  for (const len of n === 2 ? [2, 1] : [1]) {
    const r = b.lookup(shortRoles, lenFilter(len), true);
    const sv = r
      ? b.lv.ctx.pick(r.variants, `${b.lv.L.id}:${part.id}:short:${f.x},${f.y}${f.face}`)
      : undefined;
    if (!sv || sv.unitHeight > top - y + EPS || sv.unitHeight >= u - EPS) continue;
    while (top - y >= sv.unitHeight - EPS) {
      for (let c = 0; c < n; c += len) edgePiece(b, sv, "wall", alongFace(f, c), len, y, part);
      y += sv.unitHeight;
    }
    break;
  }
  if (top - y > 0.2) edgePiece(b, v, "wall", f, n, Math.max(lo, top - u), part);
}
