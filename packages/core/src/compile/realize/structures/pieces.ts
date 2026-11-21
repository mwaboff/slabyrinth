/**
 * Realize, how a building's pieces are placed: edge pieces on a footprint cell's face (through realize's edge
 * primitive, compile/realize/edges.ts), courses of them stacked up an edge, tiles over a cell set, props at a point and
 * on a wall face; and the cell sets the builders walk (face cells, runs, rings).
 * Reads: the structure context. Writes: placements (through `emit`).
 *
 * Cell sets are keyed "x,y" and walked in the keys' string order: the order is part of the released output (the seeded
 * picks and the emission order follow it), so it stays.
 */
import type { Placement, PlacementRole, RoleName } from "../../../contracts/compiler";
import type { Side } from "../../../contracts/plan";
import type { ResolvedVariant } from "../../../palette/resolve";
import type { Rect } from "../../../resolve/roof";
import { OPPOSITE, SIDE_STEP, SIDES } from "../../../gen/gridGeometry";
import { footprint, lenFilter, ONE_CELL } from "../../../palette/filters";
import { h32Utf16 } from "../../../util/hash";
import { rotateXZ } from "../../geometry";
import { outsideHost, placeEdgePiece } from "../edges";
import { EPS } from "../level";
import type { StructureCtx } from "./context";

/** What a piece belongs to: its element id (`Placement.source.elementId`) and paste layer (absent = the site). */
export interface Part {
  readonly id: string;
  readonly layer?: string | undefined;
}

/** One face of a footprint cell: the wall on it stands outside the cell, in the neighbour's half next to the edge. */
export interface FaceCell {
  x: number;
  y: number;
  face: Side;
}

export const key = (x: number, y: number): string => `${x},${y}`;
/** The cell of an "x,y" key. */
export const cellOfKey = (k: string): [number, number] => k.split(",").map(Number) as [number, number];
/** A face's key "x,y,face" (openings, ruin columns and arches are found by it). */
export const faceKey = (x: number, y: number, face: Side): string => `${x},${y},${face}`;

export const setOf = (cells: ReadonlyArray<readonly [number, number]>): Set<string> =>
  new Set(cells.map(([x, y]) => key(x, y)));

export function rectCellsOf(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

export function boundsOfCells(cells: ReadonlyArray<readonly [number, number]>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** The outer faces of a cell set: every side of a cell whose neighbour is not in the set. */
export function faceCells(cells: ReadonlySet<string>): FaceCell[] {
  const out: FaceCell[] = [];
  for (const k of [...cells].sort()) {
    const [x, y] = cellOfKey(k);
    for (const face of SIDES) {
      const [dx, dy] = SIDE_STEP[face];
      if (!cells.has(key(x + dx, y + dy))) out.push({ x, y, face });
    }
  }
  return out;
}

/** The step from a face cell `k` cells along its face (east for N/S faces, south for E/W faces). */
export const alongFace = (f: FaceCell, k: number): FaceCell =>
  f.face === "N" || f.face === "S"
    ? { x: f.x + k, y: f.y, face: f.face }
    : { x: f.x, y: f.y + k, face: f.face };

/** Runs of consecutive face cells on one line (for length-2 wall pieces). */
export function faceRunsOf(list: readonly FaceCell[]): FaceCell[][] {
  const byLine = new Map<string, FaceCell[]>();
  for (const f of list) {
    const line = f.face === "N" || f.face === "S" ? `${f.face}|${f.y}` : `${f.face}|${f.x}`;
    const arr = byLine.get(line) ?? [];
    arr.push(f);
    byLine.set(line, arr);
  }
  const runs: FaceCell[][] = [];
  for (const arr of [...byLine.values()]) {
    const along = (f: FaceCell): number => (f.face === "N" || f.face === "S" ? f.x : f.y);
    arr.sort((a, b) => along(a) - along(b));
    let cur: FaceCell[] = [];
    for (const f of arr) {
      const last = cur[cur.length - 1];
      if (last && along(f) !== along(last) + 1) {
        runs.push(cur);
        cur = [];
      }
      cur.push(f);
    }
    if (cur.length) runs.push(cur);
  }
  return runs;
}

/** The cells round a set, diagonals included. */
export function ringOf8(cells: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = cellOfKey(k);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (!cells.has(key(x + dx, y + dy))) out.add(key(x + dx, y + dy));
  }
  return out;
}

/**
 * A half-cell edge piece on the outside of face cell `f`, running `len` cells along the face, hosted in the outside cell
 * (realize's edge primitive). `door`: the role of a door leaf, whose facing turns the handle.
 */
export function edgePiece(
  b: StructureCtx,
  v: ResolvedVariant,
  role: PlacementRole,
  f: FaceCell,
  len: number,
  yBase: number,
  part: Part,
  door?: RoleName,
): void {
  const host = outsideHost(f.x, f.y, f.face);
  placeEdgePiece(b.lv, v, role, host, len, {
    yBase,
    count: 1,
    source: { cell: [Math.floor(host.hostX), Math.floor(host.hostY)], elementId: part.id },
    ...(part.layer !== undefined ? { layer: part.layer } : {}),
    ...(door !== undefined ? { door } : {}),
  });
}

/**
 * Covers [lo, hi] on one edge with a role's 1-long pieces: tall pieces from the bottom while they fit, then short
 * pieces (shortRoles, when shorter), and a last piece aligned to hi for the remainder. With allowBelow the last
 * piece may reach below lo (into the ground or the course below, same plane); without it a remainder that does not
 * fit is left open (never cover a window or door below).
 */
export function stackEdge(
  b: StructureCtx,
  roles: readonly RoleName[],
  role: PlacementRole,
  f: FaceCell,
  lo: number,
  hi: number,
  part: Part,
  opts: { shortRoles?: readonly RoleName[]; allowBelow?: boolean } = {},
): boolean {
  if (hi - lo < 0.05) return true;
  const pickV = (rs: readonly RoleName[] | undefined): ResolvedVariant | undefined => {
    if (!rs || rs.length === 0) return undefined;
    const r = b.lookup(rs, lenFilter(1), true);
    return r
      ? b.lv.ctx.pick(r.variants, `${b.lv.L.id}:${part.id}:${f.x},${f.y}${f.face}:${lo}:${rs[0] ?? ""}`)
      : undefined;
  };
  const tall = pickV(roles);
  const shortV = pickV(opts.shortRoles);
  const short = shortV && (!tall || shortV.unitHeight < tall.unitHeight - EPS) ? shortV : undefined;
  if (!tall && !short) return false;
  let yy = lo;
  if (tall)
    while (hi - yy >= tall.unitHeight - EPS) {
      edgePiece(b, tall, role, f, 1, yy, part);
      yy += tall.unitHeight;
    }
  if (short)
    while (hi - yy >= short.unitHeight - EPS) {
      edgePiece(b, short, role, f, 1, yy, part);
      yy += short.unitHeight;
    }
  if (hi - yy > 0.2) {
    const fin = short ?? tall;
    if (fin && (hi - fin.unitHeight >= lo - EPS || opts.allowBelow))
      edgePiece(b, fin, role, f, 1, hi - fin.unitHeight, part);
  }
  return true;
}

/**
 * Tiles over a cell set with their bottom at y, greedy 2×2 then 1×1, from a role chain: the first role of the chain
 * that has any piece supplies both sizes (a kit's own 1×1 beats another role's 2×2).
 */
export function layTiles(
  b: StructureCtx,
  roles: readonly RoleName[],
  cells: ReadonlySet<string>,
  y: number,
  role: PlacementRole,
  part: Part,
): void {
  const { lv } = b;
  const { L, emit } = lv;
  const { seed, frame, pick } = lv.ctx;
  const used = new Set<string>();
  const list = [...cells].map(cellOfKey).sort((a, c) => a[1] - c[1] || a[0] - c[0]);
  const own = roles.find((r) => b.lookup([r], undefined, true) !== null);
  const chain = own ? [own] : roles;
  const big = b.lookup(chain, footprint(2, 2), true);
  const small = b.lookup(chain, ONE_CELL, true);
  const layer = part.layer;
  for (const [x, y0] of list) {
    if (used.has(key(x, y0))) continue;
    const quad = [key(x, y0), key(x + 1, y0), key(x, y0 + 1), key(x + 1, y0 + 1)];
    const bv = big ? pick(big.variants, `${L.id}:${part.id}:${x},${y0}`) : undefined;
    if (bv && quad.every((k) => cells.has(k) && !used.has(k))) {
      quad.forEach((k) => used.add(k));
      const m = frame.rectMin(x, y0, 2, 2);
      emit(
        bv,
        role,
        m.x,
        y,
        m.z,
        bv.rot + (h32Utf16(`${seed}:${part.id}:${x},${y0}`) % 4) * 90,
        { cell: [x, y0], elementId: part.id },
        layer,
      );
      continue;
    }
    used.add(key(x, y0));
    const sv = small ? pick(small.variants, `${L.id}:${part.id}:${x},${y0}`) : undefined;
    if (!sv) continue;
    const m = frame.rectMin(x, y0, 1, 1);
    emit(sv, role, m.x, y, m.z, sv.rot, { cell: [x, y0], elementId: part.id }, layer);
  }
}

/** A prop centred on a plan point at height y, with its palette assembly pieces (same anchor, rotated offsets). */
export function placeProp(
  b: StructureCtx,
  v: ResolvedVariant,
  px: number,
  py: number,
  y: number,
  deg: number,
  part: Part,
  role: PlacementRole = "feature",
): void {
  const { emit } = b.lv;
  const { frame } = b.lv.ctx;
  const c = frame.point(px, py);
  const src: Placement["source"] = { cell: [Math.floor(px), Math.floor(py)], elementId: part.id };
  const one = (
    vv: ResolvedVariant,
    geom: ResolvedVariant["geom"],
    ox: number,
    oy: number,
    oz: number,
  ): void => {
    const o = rotateXZ(ox, oz, deg * frame.o.rotSense);
    if (geom.originAt === "minCorner") {
      const swap = Math.round(deg / 90) % 2 === 1;
      const hx = (swap ? geom.size.z : geom.size.x) / 2;
      const hz = (swap ? geom.size.x : geom.size.z) / 2;
      emit(vv, role, c.x + o.x - hx, y + oy, c.z + o.z - hz, deg + vv.rot, src, part.layer);
    } else {
      const off = rotateXZ(geom.boundsCenter.x, geom.boundsCenter.z, deg * frame.o.rotSense);
      emit(vv, role, c.x + o.x - off.x, y + oy, c.z + o.z - off.z, deg + vv.rot, src, part.layer);
    }
  };
  one(v, v.geom, 0, 0, 0);
  for (const piece of v.parts ?? []) {
    const pv: ResolvedVariant = {
      ...v,
      uuid: piece.asset,
      wanted: piece.asset,
      geom: piece.geom,
      name: piece.name ?? v.name,
      offset: { x: 0, y: 0, z: 0 },
    };
    delete pv.parts;
    one(pv, piece.geom, piece.offset?.x ?? 0, v.offset.y + (piece.offset?.y ?? 0), piece.offset?.z ?? 0);
  }
}

/** A wall-mounted prop on the outside of face cell `f`: `out` cells from the cell centre, `along` the face. */
export function wallProp(
  b: StructureCtx,
  v: ResolvedVariant,
  roleName: RoleName,
  f: FaceCell,
  out: number,
  h: number,
  part: Part,
  along = 0,
): void {
  const { emit } = b.lv;
  const { frame, facingOf } = b.lv.ctx;
  const { x, y, face: side } = f;
  const [dx, dy] = SIDE_STEP[side];
  const along2 = side === "N" || side === "S" ? [along, 0] : [0, along];
  const px = x + 0.5 + dx * out + (along2[0] ?? 0);
  const py = y + 0.5 + dy * out + (along2[1] ?? 0);
  const c = frame.point(px, py);
  const fct = facingOf(v, "feature", roleName);
  const wallDir = frame.worldSide(OPPOSITE[side]);
  const steps = frame.stepsToFace(fct.mountsOn ?? "S", wallDir);
  const deg = steps * 15 + v.rot;
  const off =
    v.geom.originAt === "minCorner"
      ? { x: 0, z: 0 }
      : rotateXZ(v.geom.boundsCenter.x, v.geom.boundsCenter.z, deg * frame.o.rotSense);
  emit(
    v,
    "wall_post",
    c.x - off.x,
    h,
    c.z - off.z,
    deg,
    { cell: [x + dx, y + dy], elementId: part.id },
    part.layer,
  );
}
