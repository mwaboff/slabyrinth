/**
 * Realize, edge primitives: how a piece standing on a cell edge is placed, and the strips such pieces leave at the
 * vertices for the corner posts. Shared by the wall, kerb and opening passes; places only what a pass asks for.
 * Reads: the edge as the caller describes it (`EdgeCtx`). Writes: placements (through `emit`); `CornerStrips`.
 */
import type { Placement, PlacementRole, RoleName } from "../../contracts/compiler";
import type { Side, ThemeId } from "../../contracts/plan";
import type { ResolvedVariant, VariantFilter } from "../../palette/resolve";
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

/** A piece's length in edges along its length axis (at least 1). */
export const lengthOf = (v: ResolvedVariant): number =>
  v.geom.lengthAxis === "square" || v.geom.lengthAxis === undefined
    ? Math.max(1, Math.round(Math.max(v.geom.size.x, v.geom.size.z)))
    : Math.max(1, Math.round(v.geom.lengthAxis === "x" ? v.geom.size.x : v.geom.size.z));
export const lenFilter = (n: number): VariantFilter => ({ key: `len${n}`, test: (v) => lengthOf(v) === n });

/** Places one half-cell edge piece covering `len` edges starting at the run's first edge ctx. */
export function placeEdgePiece(
  lv: RealizeLevel,
  v: ResolvedVariant,
  role: PlacementRole,
  roleName: RoleName,
  first: EdgeCtx,
  len: number,
  yBase: number,
  count: number,
  source: Placement["source"],
  isDoor: boolean,
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
  if (isDoor) {
    const f = facingOf(v, "opening", roleName);
    if (f.handleEnd) {
      const pref = frame.o.doorHandlePreference;
      const want: Side =
        ws === "N" || ws === "S" ? (pref?.eastWestEdge ?? "W") : (pref?.northSouthEdge ?? "N");
      const cand = ep.rotSteps.map((r) => (r + axisFix) % 24);
      steps = cand.find((r) => frame.dirAfter(f.handleEnd ?? "W", r) === want) ?? cand[0] ?? steps;
    }
  }
  const unit = v.unitHeight;
  for (let k = 0; k < count; k++) {
    emit(v, role, m.x + ep.offset.x, yBase + k * unit, m.z + ep.offset.z, steps * 15 + v.rot, source);
  }
}

/** Places one piece centred over `len` edges (free-standing low walls, fences, railings). */
export function placeEdgeCenterPiece(
  lv: RealizeLevel,
  v: ResolvedVariant,
  role: PlacementRole,
  first: EdgeCtx,
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
