/**
 * The wall faces of a resolved level: every WALL and OPENING edge, described once, read-only. The solid shell
 * (compile/shell.ts), the wall pass and its rock columns (compile/realize/walls.ts) and verify's wall check
 * (compile/verify/verify.ts) all read their walls from here, so they agree on which cell a wall's mass stands in, its
 * style, its theme and its span.
 *
 * A face is one edge: its two cells (the host, whose half cell holds a thin wall's strip, and the other), the wall
 * style (an opening's is the wall it is cut in), whether that style is natural rock (gen/wallStyles.ts trait), whether a
 * building builds the edge itself, its theme and its vertical span (resolve/wallspan.ts), and its MASS cell: the cell
 * the solid behind the wall stands in, which is where a whole-cell (rock block) piece goes and which solid cell the
 * shell dresses behind it.
 *
 * The mass rule: the side that is not open; when neither side is open, the host; none when both sides are open (a
 * block between two rooms has nowhere to stand). The mass cell may be VOID or outside the level (a cave touching the
 * bounds), unless the board edge is an exit (`boardEdgeIsExit`, generator 3 on): then a mass outside the level is none.
 *
 * What a face does NOT answer, because it is a question of the reader:
 *  - how a palette builds the wall (half-cell, edge-centre, full-cell mount): role data per theme, asked by the passes
 *    that place or measure pieces. The `natural` trait is a different question (does the cave rock own the solid
 *    behind it); a theme without rock pieces builds a natural wall as a thin wall, so the two are kept apart;
 *  - how faces sharing a mass cell merge: the shell's cap sits flush with the tallest wall it backs onto, a rock column
 *    spans every edge it closes (lowest base to highest top). Each reader reduces `list` its own way.
 *
 * Order: `list` walks the edges line by line (resolve/levelGrid.ts `edgeLines`/`edgeOnLine`): rows of horizontal edges
 * north to south, each west to east, then columns of vertical edges west to east, each north to south. That is the
 * order the wall runs tile them in, so a reader that keeps the first face of a cell, or seeds noise in list order,
 * sees the walls as the build lays them. `at` finds the face of one edge; `hostedOn` describes it from its other side
 * (the opening pass stands a wide opening on one side of all its edges).
 */
import type { Side, ThemeId } from "../contracts/plan";
import { CELL, EDGE } from "../contracts/resolved";
import { THEME_WALL_STYLE, isNaturalWallStyle } from "../gen/wallStyles";
import {
  edgeCount,
  edgeLineLength,
  edgeLines,
  edgeOnLine,
  type EdgeOrient,
  type LevelGrid,
} from "./levelGrid";
import { areaReferenceHeights, edgeWallHeight, wallSpan } from "./wallspan";

/** One cell beside a wall edge, in plan coordinates. */
export interface FaceCell {
  readonly x: number;
  readonly y: number;
  /** Cell index in the level (resolve/levelGrid.ts `cellIndex`), -1 outside the level. */
  readonly index: number;
  readonly open: boolean;
  /** A SOLID cell of the level (rock the level is carved into); false for VOID and outside the level. */
  readonly solid: boolean;
}

export interface WallFace {
  readonly orient: EdgeOrient;
  /** Index into the level's edges of this orientation. */
  readonly edge: number;
  /** Start vertex of the edge (plan coordinates): the N edge of cell (x, y) for "h", its W edge for "v". */
  readonly x: number;
  readonly y: number;
  /** EDGE.WALL or EDGE.OPENING. */
  readonly kind: number;
  /** Wall style (an opening's: the wall it is cut in). */
  readonly style: string;
  /** Natural rock (gen/wallStyles.ts trait): the cave rock owns the solid behind it. */
  readonly natural: boolean;
  /** A building builds this edge itself (resolve/structureFaces.ts `structureClaims`). */
  readonly claimed: boolean;
  /** The host is the edge's first cell (north of an "h" edge, west of a "v" edge). */
  readonly hostFirst: boolean;
  readonly host: FaceCell;
  readonly other: FaceCell;
  /** The side of the host cell the edge lies on. */
  readonly hostSide: Side;
  /** Where the solid behind the wall stands (see the file header); null when it has nowhere to stand. */
  readonly mass: FaceCell | null;
  /** The theme the wall is built in: the open side's (the other cell's first), else the other cell's. */
  readonly theme: ThemeId;
  /** Absolute span (resolve/wallspan.ts). */
  readonly base: number;
  readonly top: number;
}

export interface WallFaceOptions {
  /** Edges buildings build themselves, as "<orient><edge index>" (resolve/structureFaces.ts `structureClaims().edges`). */
  readonly claimed?: ReadonlySet<string>;
  /** Reference floor heights of the level's areas (resolve/wallspan.ts); computed when left out. */
  readonly refHeights?: ReadonlyMap<number, number>;
  /**
   * A passage that reaches the board edge is an exit (generator 3, `boardEdgeExits`): slabs are tiled beside other
   * slabs, so nothing stands outside the level and a face whose mass would be there has none.
   */
  readonly boardEdgeIsExit: boolean;
}

/** Describes the face on edge `e` (start vertex x, y) with its host on the given side. */
type DescribeFace = (orient: EdgeOrient, e: number, x: number, y: number, hostFirst: boolean) => WallFace;

/** The wall faces of one level: `list` in line order (see the file header), `at` by edge. */
export class WallFaces {
  private readonly byEdge: Record<EdgeOrient, Int32Array>;

  constructor(
    readonly list: readonly WallFace[],
    size: { w: number; h: number },
    private readonly describe: DescribeFace,
  ) {
    this.byEdge = {
      h: new Int32Array(edgeCount(size, "h")).fill(-1),
      v: new Int32Array(edgeCount(size, "v")).fill(-1),
    };
    list.forEach((f, i) => {
      this.byEdge[f.orient][f.edge] = i;
    });
  }

  /** The face on edge `edge` of orientation `orient`, undefined when that edge is neither a wall nor an opening. */
  at(orient: EdgeOrient, edge: number): WallFace | undefined {
    const i = edge < 0 ? -1 : (this.byEdge[orient][edge] ?? -1);
    return i < 0 ? undefined : this.list[i];
  }

  /**
   * The same face hosted on the given side: host and other swapped, with the span, theme, side and mass that follow
   * from the host. A piece wider than one edge stands on one side of all its edges (realize/openings.ts: an opening keeps
   * its first edge's host).
   */
  hostedOn(f: WallFace, hostFirst: boolean): WallFace {
    return f.hostFirst === hostFirst ? f : this.describe(f.orient, f.edge, f.x, f.y, hostFirst);
  }
}

/** Finds the wall faces of the level `V` reads. */
export function findWallFaces(V: LevelGrid, opts: WallFaceOptions): WallFaces {
  const L = V.level;
  const ref = opts.refHeights ?? areaReferenceHeights(L);
  const claimed = opts.claimed;
  const faceCell = (x: number, y: number): FaceCell => {
    const index = V.index(x, y);
    const state = index < 0 ? -1 : (L.cells.state[index] ?? CELL.VOID);
    return { x, y, index, open: state === CELL.OPEN, solid: state === CELL.SOLID };
  };
  const describe: DescribeFace = (orient, e, x, y, hostFirst) => {
    const grid = V.edges(orient);
    const kind = grid.kind[e] ?? EDGE.NONE;
    // the edge's first cell (north / west) and second cell (x, y)
    const ax = orient === "h" ? x : x - 1;
    const ay = orient === "h" ? y - 1 : y;
    const a = V.cell(ax, ay);
    const b = V.cell(x, y);
    const host = hostFirst ? faceCell(ax, ay) : faceCell(x, y);
    const other = hostFirst ? faceCell(x, y) : faceCell(ax, ay);
    const style =
      kind === EDGE.WALL
        ? (L.wallStyles[grid.ref[e] ?? 0] ?? THEME_WALL_STYLE)
        : (L.openings[grid.ref[e] ?? -1]?.wallStyle ?? THEME_WALL_STYLE);
    const span = wallSpan(L.elevation, a, b, hostFirst, edgeWallHeight(grid, e), ref);
    const hostCell = hostFirst ? a : b;
    const otherCell = hostFirst ? b : a;
    const theme =
      (otherCell.open ? otherCell.theme : hostCell.open ? hostCell.theme : otherCell.theme) || V.defaultTheme;
    let mass: FaceCell | null = host.open && other.open ? null : host.open ? other : host;
    if (mass && opts.boardEdgeIsExit && mass.index < 0) mass = null;
    return {
      orient,
      edge: e,
      x,
      y,
      kind,
      style,
      natural: isNaturalWallStyle(style),
      claimed: claimed?.has(`${orient}${e}`) ?? false,
      hostFirst,
      host,
      other,
      hostSide: orient === "h" ? (hostFirst ? "S" : "N") : hostFirst ? "E" : "W",
      mass,
      theme,
      base: span.base,
      top: span.top,
    };
  };
  const list: WallFace[] = [];
  for (const orient of ["h", "v"] as const) {
    const grid = V.edges(orient);
    const lines = edgeLines(V, orient);
    const length = edgeLineLength(V, orient);
    for (let line = 0; line < lines; line++)
      for (let pos = 0; pos < length; pos++) {
        const e = edgeOnLine(V, orient, line, pos);
        const kind = grid.kind[e] ?? EDGE.NONE;
        if (kind !== EDGE.WALL && kind !== EDGE.OPENING) continue;
        const x = V.x0 + (orient === "h" ? pos : line);
        const y = V.y0 + (orient === "h" ? line : pos);
        list.push(describe(orient, e, x, y, (grid.host[e] ?? 1) === 0));
      }
  }
  return new WallFaces(list, V, describe);
}
