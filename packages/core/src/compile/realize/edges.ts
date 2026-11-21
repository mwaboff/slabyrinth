/**
 * Realize, edge primitives: how a piece standing on a cell edge is placed, and the strips such pieces leave at the
 * vertices for the corner posts. Shared by the wall, kerb and opening passes; places only what a pass asks for.
 * Reads: the edge as the caller describes it (`EdgeCtx`). Writes: placements (through `emit`); `CornerStrips`.
 */
import type { Placement, PlacementRole, RoleName } from "../../contracts/compiler";
import type { Side, ThemeId } from "../../contracts/plan";
import type { ResolvedVariant } from "../../palette/resolve";
import { OPPOSITE, SIDE_STEP } from "../../gen/gridGeometry";
import { sideOrient } from "../../resolve/levelGrid";
import type { WallFace } from "../../resolve/wallFaces";
import { rotateXZ } from "../geometry";
import type { RealizeLevel } from "./level";

/** One edge strip (a wall or door piece occupying the half-cell next to an edge), for corner posts. */
export interface Strip {
  orient: "h" | "v";
  /** Plan side of the edge line the strip lies on: h → "N"|"S", v → "W"|"E". */
  side: Side;
  style: string;
  theme: ThemeId;
  base: number;
  top: number;
}

/**
 * One wall edge as a piece standing on it sees it (`faceEdgeCtx` for a wall or opening face; the shell's skirt and kerbs
 * build their own).
 */
export interface EdgeCtx {
  orient: "h" | "v";
  x: number;
  y: number;
  hostFirst: boolean;
  hostX: number;
  hostY: number;
  /** The cell on the other side of the edge (full-cell blocks go there when the host cell is open). */
  otherX: number;
  otherY: number;
  otherOpen: boolean;
  planSide: Side;
  base: number;
  top: number;
  theme: ThemeId;
  hostOpen: boolean;
}

/**
 * The edge strips ending at each vertex of a level. The wall and opening passes register the strips their pieces
 * occupy; the corner-post pass reads `byVertex` once both are done.
 */
export class CornerStrips {
  private readonly map = new Map<string, Array<Strip & { dir: Side }>>();

  /** Strips ending at each vertex ("x,y"), each with the direction it leaves the vertex in. */
  get byVertex(): ReadonlyMap<string, ReadonlyArray<Strip & { dir: Side }>> {
    return this.map;
  }

  /** Registers a 1-long strip on the edge starting at vertex (vx,vy) running +x (h) or +y (v). */
  register(orient: "h" | "v", vx: number, vy: number, s: Strip): void {
    if (orient === "h") {
      this.add(vx, vy, s, "E");
      this.add(vx + 1, vy, s, "W");
    } else {
      this.add(vx, vy, s, "S");
      this.add(vx, vy + 1, s, "N");
    }
  }

  private add(vx: number, vy: number, s: Strip, dir: Side): void {
    const k = `${vx},${vy}`;
    const arr = this.map.get(k) ?? [];
    arr.push({ ...s, dir });
    this.map.set(k, arr);
  }
}

/** A wall face (resolve/wallFaces.ts) as a piece standing on its edge sees it. */
export function faceEdgeCtx(f: WallFace): EdgeCtx {
  return {
    orient: f.orient,
    x: f.x,
    y: f.y,
    hostFirst: f.hostFirst,
    hostX: f.host.x,
    hostY: f.host.y,
    otherX: f.other.x,
    otherY: f.other.y,
    otherOpen: f.other.open,
    planSide: f.hostSide,
    base: f.base,
    top: f.top,
    theme: f.theme,
    hostOpen: f.host.open,
  };
}

/** A piece's length in edges, and the filter of pieces of one length (palette/filters.ts owns them). */
export { lengthOf, lenFilter } from "../../palette/filters";

/**
 * Where a half-cell edge piece stands: the edge's orientation, the cell that hosts the piece (it stands in that cell's
 * half next to the edge) and the side of the host cell the edge is on. A wall face's `EdgeCtx` is one; a building's
 * face cell gives one too (compile/realize/structures/pieces.ts `faceHost`).
 */
export type EdgeHost = Pick<EdgeCtx, "orient" | "hostX" | "hostY" | "planSide">;

/** Where a piece centred over edges stands: the first vertex of the edge line, its orientation and the floor under it. */
export type EdgeLine = Pick<EdgeCtx, "orient" | "x" | "y" | "base">;

/**
 * The host of a piece standing outside cell (x, y) on its `side`: the neighbour across that edge holds it, in its half
 * next to the edge (a kerb on the verge beside a path cell, a building's wall outside its footprint).
 */
export function outsideHost(x: number, y: number, side: Side): EdgeHost {
  const [dx, dy] = SIDE_STEP[side];
  return { orient: sideOrient(side), hostX: x + dx, hostY: y + dy, planSide: OPPOSITE[side] };
}

/** The line of the edge on `side` of cell (x, y) as a centred piece sees it, the floor under it at `base`. */
export function sideLine(x: number, y: number, side: Side, base: number): EdgeLine {
  return {
    orient: sideOrient(side),
    x: side === "E" ? x + 1 : x,
    y: side === "S" ? y + 1 : y,
    base,
  };
}

/** How many pieces of an edge piece stand where, and what they belong to. */
export interface EdgePieceAt {
  /** Bottom of the first piece; `count` pieces stack up from it, one unit height apart. */
  yBase: number;
  count: number;
  source: Placement["source"];
  /** A door leaf: the role that supplied it, whose facing names the handle end the leaf is turned by. */
  door?: RoleName;
  /** Paste layer of the pieces (Placement.layer: a building's "storey:<n>" or "roof"); absent = the site. */
  layer?: string;
}

/** Places a half-cell edge piece covering `len` edges from the run's first edge, stacked `at.count` high. */
export function placeEdgePiece(
  lv: RealizeLevel,
  v: ResolvedVariant,
  role: PlacementRole,
  first: EdgeHost,
  len: number,
  at: EdgePieceAt,
): void {
  const { emit } = lv;
  const { frame, facingOf } = lv.ctx;
  // host cell whose world min corner anchors the piece: west-most (h run) or south-most in world (v run)
  const hx = first.hostX;
  const hy = first.orient === "v" && frame.o.flipZ ? first.hostY + len - 1 : first.hostY;
  const ws = frame.worldSide(first.planSide);
  const ep = frame.o.edgePlacement[ws];
  const m = frame.rectMin(hx, hy, 1, 1);
  const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
  let steps = (ep.rotSteps[0] + axisFix) % 24;
  if (at.door !== undefined) {
    const f = facingOf(v, "opening", at.door);
    if (f.handleEnd) {
      const pref = frame.o.doorHandlePreference;
      const want: Side =
        ws === "N" || ws === "S" ? (pref?.eastWestEdge ?? "W") : (pref?.northSouthEdge ?? "N");
      const cand = ep.rotSteps.map((r) => (r + axisFix) % 24);
      steps = cand.find((r) => frame.dirAfter(f.handleEnd ?? "W", r) === want) ?? cand[0] ?? steps;
    }
  }
  const unit = v.unitHeight;
  for (let k = 0; k < at.count; k++) {
    emit(
      v,
      role,
      m.x + ep.offset.x,
      at.yBase + k * unit,
      m.z + ep.offset.z,
      steps * 15 + v.rot,
      at.source,
      at.layer,
    );
  }
}

/** Places one piece centred over `len` edges (free-standing low walls, fences, railings, gates). */
export function placeEdgeCenterPiece(
  lv: RealizeLevel,
  v: ResolvedVariant,
  role: PlacementRole,
  first: EdgeLine,
  len: number,
  source: Placement["source"],
): void {
  const { emit } = lv;
  const { frame } = lv.ctx;
  const along =
    first.orient === "h" ? { x: first.x + len / 2, y: first.y } : { x: first.x, y: first.y + len / 2 };
  const c = frame.point(along.x, along.y);
  const runsEW = first.orient === "h";
  const axisFix = v.geom.lengthAxis === "z" ? 6 : 0;
  const steps = ((runsEW ? 0 : frame.stepsForQuarters(1)) + axisFix) % 24;
  const deg = steps * 15 + v.rot;
  const off =
    v.geom.originAt === "minCorner"
      ? { x: 0, z: 0 }
      : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
  emit(v, role, c.x - off.x, first.base, c.z - off.z, deg, source);
}
