/**
 * Realize, edge primitives: how a piece standing on a cell edge is placed. Shared by the wall, kerb and opening
 * passes; places only what a pass asks for.
 * Reads: the level's cells and wall spans (`refHeights`). Writes: placements (through `emit`) and `strips`.
 */
import type { Placement, PlacementRole, RoleName } from "../../contracts/compiler";
import type { Side } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import type { ResolvedVariant, VariantFilter } from "../../palette/resolve";
import { wallSpan } from "../../resolve/wallspan";
import { rotateXZ } from "../geometry";
import type { EdgeCtx, LevelWork, Strip } from "./work";

function addStrip(w: LevelWork, vx: number, vy: number, s: Strip, dir: Side): void {
  const { strips } = w;
  const k = `${vx},${vy}`;
  const arr = strips.get(k) ?? [];
  arr.push({ ...s, dir });
  strips.set(k, arr);
}

/** Registers a 1-long strip on the edge starting at vertex (vx,vy) running +x (h) or +y (v). */
export function registerEdgeStrip(w: LevelWork, orient: "h" | "v", vx: number, vy: number, s: Strip): void {
  if (orient === "h") {
    addStrip(w, vx, vy, s, "E");
    addStrip(w, vx + 1, vy, s, "W");
  } else {
    addStrip(w, vx, vy, s, "S");
    addStrip(w, vx, vy + 1, s, "N");
  }
}

/** Edge (x,y) = north edge of cell (x,y) for h, west edge for v. */
export function edgeCtx(
  w: LevelWork,
  orient: "h" | "v",
  x: number,
  y: number,
  grid: ResolvedLevel["hEdges"],
  e: number,
  wallHeight: number,
): EdgeCtx {
  const { V, elev, refHeights } = w;
  const { defaultTheme } = w.ctx;
  const a = orient === "h" ? V.cell(x, y - 1) : V.cell(x - 1, y);
  const b = V.cell(x, y);
  const hostFirst = (grid.host[e] ?? 1) === 0;
  const host = hostFirst ? a : b;
  const other = hostFirst ? b : a;
  const { base, top } = wallSpan(elev, a, b, hostFirst, wallHeight, refHeights);
  const theme = (other.open ? other.theme : host.open ? host.theme : other.theme) || defaultTheme;
  const hostX = orient === "h" ? x : hostFirst ? x - 1 : x;
  const hostY = orient === "h" ? (hostFirst ? y - 1 : y) : y;
  const otherX = orient === "h" ? x : hostFirst ? x : x - 1;
  const otherY = orient === "h" ? (hostFirst ? y : y - 1) : y;
  const planSide: Side = orient === "h" ? (hostFirst ? "S" : "N") : hostFirst ? "E" : "W";
  return {
    orient,
    x,
    y,
    hostFirst,
    hostX,
    hostY,
    otherX,
    otherY,
    otherOpen: other.open,
    planSide,
    base,
    top,
    theme,
    hostOpen: host.open,
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
  w: LevelWork,
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
  const { emit } = w;
  const { frame, facingOf } = w.ctx;
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
  w: LevelWork,
  v: ResolvedVariant,
  role: PlacementRole,
  first: EdgeCtx,
  len: number,
  source: Placement["source"],
): void {
  const { emit } = w;
  const { frame } = w.ctx;
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
