/**
 * Wall anchors: faces, the openings in them, the corners where they meet, and a building's storey lines. Built from the
 * shared walks only: the level's walls from resolve/wallFaces.ts (each WALL and OPENING edge, its host, style, theme and
 * span), a building's walls from resolve/structureFaces.ts (the faces its storeys build, as the building realizer lays
 * them), opening kinds from gen/openingKinds.ts.
 *
 * Where the surface is: a building's wall stands in the half cell outside its footprint, so its outside surface is 0.5
 * out from the footprint edge and its inside surface on the edge. A level wall's surface depends on how its theme mounts
 * it (`WallMount`, asked of the palette by the caller): a half-cell strip in the viewer's cell stands 0.5 into it, one in
 * the far cell is flush with the edge, an edge-centred piece 0.25, a full-cell block flush with the edge.
 * Reads: the resolved level. Writes: nothing.
 */
import type { AreaId, Side, ThemeId } from "../../contracts/plan";
import type { ResolvedLevel, ResolvedStructure, ResolvedVolume } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { OPPOSITE, SIDE_STEP } from "../../gen/gridGeometry";
import { isPassage, isWindow } from "../../gen/openingKinds";
import type { LevelGrid } from "../levelGrid";
import {
  chimneyWalls,
  faceKey,
  faceRunsOf,
  foreignCells,
  GROUND_FACES,
  key,
  mainVolumeId,
  openingsByStorey,
  storeyFaces,
  storeyWallFaces,
  structureNeighbours,
  volumeTag,
  volumesOf,
  type FaceCell,
  type StoreyOpening,
} from "../structureFaces";
import type { WallFace, WallFaces } from "../wallFaces";
import { maxOf, minOf } from "../../util/lists";
import { framePoint, frameDir, runFrame, runOffset, shiftFrame, type AnchorFrame } from "./frame";
import type { CornerAnchor, FaceAnchor, FaceEnd, FaceGap, OpeningAnchor, StoreyLineAnchor } from "./types";

/** How a theme mounts a wall style (palette `PaletteRole.mount`). */
export type WallMount = "half-cell" | "full-cell" | "edge-center";

/** The mount of a level wall's pieces in a theme (the caller asks the palette; default half-cell). */
export type MountOf = (theme: ThemeId, style: string) => WallMount;

const EPS = 1e-6;

/** A face or a storey line before its ends are known. */
type FaceDraft = Omit<FaceAnchor, "ends" | "beyond"> & { ends: [FaceEnd, FaceEnd]; beyond: [number, number] };
type LineDraft = Omit<StoreyLineAnchor, "ends" | "beyond"> & {
  ends: [FaceEnd, FaceEnd];
  beyond: [number, number];
  outside: boolean;
};

export interface WallAnchors {
  readonly faces: FaceAnchor[];
  readonly openings: OpeningAnchor[];
  readonly corners: CornerAnchor[];
  readonly storeyLines: StoreyLineAnchor[];
}

/** The coordinate of a cell along the line of a face on `side` (x for N/S faces, y for E/W). */
const alongOf = (side: Side, x: number, y: number): number => (side === "N" || side === "S" ? x : y);

/** The grid line of the edge on `side` of cell (x, y). */
function edgeLine(side: Side, x: number, y: number): number {
  switch (side) {
    case "N":
      return y;
    case "S":
      return y + 1;
    case "W":
      return x;
    case "E":
      return x + 1;
  }
}

/** Every wall anchor of the level. */
export function wallAnchors(L: ResolvedLevel, g: LevelGrid, walls: WallFaces, mountOf: MountOf): WallAnchors {
  const faces: FaceDraft[] = [];
  const openings: OpeningAnchor[] = [];
  const storeyLines: LineDraft[] = [];
  levelFaces(L, g, walls, mountOf, faces, openings);
  for (const st of L.structures ?? []) buildingFaces(L, st, faces, openings, storeyLines);
  const corners = cornersOf(faces);
  meetings(storeyLines, () => undefined);
  return { faces, openings, corners, storeyLines };
}

// ───────────────────────────── the level's own walls ─────────────────────────────

/** One viewer cell's side of a level face. */
interface LevelSeen {
  readonly f: WallFace;
  /** The open cell the face is seen from, and the side of it the edge is on. */
  readonly x: number;
  readonly y: number;
  readonly w: Side;
  readonly plane: number;
  readonly base: number;
  readonly room: AreaId | null;
  readonly theme: ThemeId;
}

function levelFaces(
  L: ResolvedLevel,
  g: LevelGrid,
  walls: WallFaces,
  mountOf: MountOf,
  faces: FaceDraft[],
  openings: OpeningAnchor[],
): void {
  const byLine = new Map<string, LevelSeen[]>();
  for (const f of walls.list) {
    if (f.claimed) continue;
    for (const [cell, hostSide] of [
      [f.host, true],
      [f.other, false],
    ] as const) {
      if (!cell.open || cell.index < 0) continue;
      // the side of the viewer cell the edge lies on
      const w: Side = hostSide ? f.hostSide : OPPOSITE[f.hostSide];
      const c = g.cell(cell.x, cell.y);
      if (!c.floor) continue;
      const mount = mountOf(f.theme, f.style);
      const plane =
        mount === "edge-center" ? 0.25 : mount === "full-cell" || f.natural ? 0 : hostSide ? 0.5 : 0;
      const n = OPPOSITE[w];
      const seen: LevelSeen = {
        f,
        x: cell.x,
        y: cell.y,
        w,
        plane,
        base: g.top(cell.x, cell.y),
        room: c.area > 0 ? (L.areaIds[c.area - 1] ?? null) : null,
        theme: f.theme,
      };
      const line = `${n}|${edgeLine(w, cell.x, cell.y)}`;
      const list = byLine.get(line) ?? [];
      list.push(seen);
      byLine.set(line, list);
    }
  }
  for (const [line, list] of byLine) {
    const n = line.slice(0, 1) as Side;
    list.sort((a, b) => alongOf(n, a.x, a.y) - alongOf(n, b.x, b.y));
    let run: LevelSeen[] = [];
    const flush = (): void => {
      if (run.length > 0) levelRun(L, n, run, faces, openings);
      run = [];
    };
    for (const s of list) {
      const last = run[run.length - 1];
      if (
        last &&
        (alongOf(n, s.x, s.y) !== alongOf(n, last.x, last.y) + 1 ||
          Math.abs(s.plane - last.plane) > EPS ||
          Math.abs(s.base - last.base) > EPS ||
          s.f.style !== last.f.style ||
          s.f.natural !== last.f.natural ||
          s.room !== last.room ||
          s.theme !== last.theme)
      )
        flush();
      run.push(s);
    }
    flush();
  }
}

/** One straight run of a level face seen from one side, and the openings in it. */
function levelRun(
  L: ResolvedLevel,
  n: Side,
  run: readonly LevelSeen[],
  faces: FaceDraft[],
  openings: OpeningAnchor[],
): void {
  const first = run[0] as LevelSeen;
  const last = run[run.length - 1] as LevelSeen;
  const lo = alongOf(n, first.x, first.y);
  const hi = alongOf(n, last.x, last.y);
  const frame = runFrame(n, edgeLine(first.w, first.x, first.y), lo, hi, first.plane, first.base);
  const faceKeyText = `face:L:${n}:${edgeLine(first.w, first.x, first.y)}:${lo}`;
  // openings: consecutive edges of one opening make one gap
  const gaps: FaceGap[] = [];
  for (const s of run) {
    if (s.f.kind !== EDGE.OPENING) continue;
    const grid = s.f.orient === "h" ? L.hEdges : L.vEdges;
    const op = L.openings[grid.ref[s.f.edge] ?? -1];
    if (!op) continue;
    const a = runOffset(n, lo, hi, alongOf(n, s.x, s.y));
    const prev = gaps.find((q) => q.id === op.id);
    if (prev)
      gaps[gaps.indexOf(prev)] = { ...prev, from: Math.min(prev.from, a), to: Math.max(prev.to, a + 1) };
    else gaps.push({ id: op.id, kind: op.kind, from: a, to: a + 1 });
  }
  gaps.sort((p, q) => p.from - q.from);
  const face: FaceDraft = {
    kind: "face",
    key: faceKeyText,
    frame,
    theme: first.theme,
    element: first.room ?? L.id,
    structure: null,
    storey: 0,
    room: first.room,
    outside: false,
    seen: true,
    length: hi - lo + 1,
    // the lowest top of the run (a rough interior's walls vary edge by edge)
    height: minOf(run.map((q) => q.f.top)) - first.base,
    style: first.f.style,
    natural: first.f.natural,
    plane: first.plane,
    gaps,
    ends: ["open", "open"],
    beyond: [0, 0],
    footed: false,
  };
  faces.push(face);
  for (const gap of gaps) openings.push(openingAnchor(face, gap, 0, face.height));
}

// ───────────────────────────── buildings ─────────────────────────────

function buildingFaces(
  L: ResolvedLevel,
  st: ResolvedStructure,
  faces: FaceDraft[],
  openings: OpeningAnchor[],
  storeyLines: LineDraft[],
): void {
  // a ruin's walls break off column by column: nothing is dressed on them; a ruin that lost bays (generator 5,
  // ruin.bays) stands sound elsewhere, and its standing walls are faces like any other (a cut column is none)
  if (st.kind !== "building" || (st.condition === "ruined" && !st.ruin?.bays)) return;
  const vols = volumesOf(st);
  const mainId = mainVolumeId(vols);
  const tagOf = (vid: string): string => volumeTag(st, mainId, vid);
  const opsBy = openingsByStorey(st, L.openings, vols, mainId, tagOf);
  const nb = structureNeighbours(L, st, vols);
  const chimney = chimneyWalls(st);
  const foreign = foreignCells(L, st);
  const caps = new Map((st.ruin?.columns ?? []).map((c) => [faceKey(c.at[0], c.at[1], c.side), c.top]));
  const boarded = new Set(st.ruin?.weather?.boarded ?? []);
  const groundRoom = L.areaIds.includes(st.id) ? st.id : null;
  for (const v of vols) {
    const wallsOf = v.storeys.map((sp) =>
      sp.walls === null
        ? []
        : storeyWallFaces(st, nb, v, sp).filter((f) => !chimney.has(faceKey(f.x, f.y, f.face))),
    );
    v.storeys.forEach((sp, s) => {
      if (sp.walls === null) return;
      const ground = s === 0 && v.on === null;
      const ops = opsBy.get(ground ? GROUND_FACES : storeyFaces(v.id, s)) ?? new Map<string, StoreyOpening>();
      // a weathered wall column broken off below the storey's top is no face to dress
      const standing = (f: FaceCell, top: number): boolean =>
        (caps.get(faceKey(f.x, f.y, f.face)) ?? Infinity) >= top - EPS;
      const own = (wallsOf[s] ?? []).filter((f) => standing(f, sp.wallTop));
      const ctx: StoreyCtx = { st, v, s, sp, ops, boarded, ground, foreign, tag: tagOf(v.id) };
      for (const run of faceRunsOf(own)) {
        const outside = buildingRun(ctx, run, true, groundRoom);
        faces.push(outside.face);
        for (const o of outside.openings) openings.push(o);
        if (ground && groundRoom !== null) {
          const inside = buildingRun(ctx, run, false, groundRoom);
          faces.push(inside.face);
          for (const o of inside.openings) openings.push(o);
        }
      }
      // the storey line under this storey's walls: where the wall below runs up through it (s > 0), or the ground line
      const below = s > 0 ? new Set((wallsOf[s - 1] ?? []).map((f) => faceKey(f.x, f.y, f.face))) : null;
      const line = own.filter((f) => below === null || below.has(faceKey(f.x, f.y, f.face)));
      for (const run of faceRunsOf(line)) storeyLines.push(storeyLine(ctx, run));
    });
  }
}

interface StoreyCtx {
  readonly st: ResolvedStructure;
  readonly v: ResolvedVolume;
  readonly s: number;
  readonly sp: ResolvedVolume["storeys"][number];
  readonly ops: ReadonlyMap<string, StoreyOpening>;
  readonly boarded: ReadonlySet<string>;
  readonly ground: boolean;
  readonly foreign: ReadonlySet<string>;
  readonly tag: string;
}

/** The frame of a run of a building's face cells: outside (0.5 out, normal out) or inside (on the edge, normal in). */
function buildingRunFrame(
  run: readonly FaceCell[],
  outside: boolean,
  base: number,
): {
  frame: AnchorFrame;
  n: Side;
  lo: number;
  hi: number;
} {
  const first = run[0] as FaceCell;
  const last = run[run.length - 1] as FaceCell;
  const side = first.face;
  const lo = alongOf(side, first.x, first.y);
  const hi = alongOf(side, last.x, last.y);
  const n = outside ? side : OPPOSITE[side];
  return { frame: runFrame(n, edgeLine(side, first.x, first.y), lo, hi, outside ? 0.5 : 0, base), n, lo, hi };
}

/** The openings of a storey along a run of its face cells, as gaps in local x (boarded windows are plain wall). */
function storeyGaps(c: StoreyCtx, run: readonly FaceCell[], n: Side, lo: number, hi: number): FaceGap[] {
  const gaps: FaceGap[] = [];
  for (const f of run) {
    const op = c.ops.get(faceKey(f.x, f.y, f.face));
    if (!op) continue;
    if (c.boarded.has(faceKey(op.first.x, op.first.y, op.first.face))) continue;
    const a = runOffset(n, lo, hi, alongOf(f.face, f.x, f.y));
    const prev = gaps.findIndex((q) => q.id === op.id);
    const p = gaps[prev];
    if (p) gaps[prev] = { ...p, from: Math.min(p.from, a), to: Math.max(p.to, a + 1) };
    else gaps.push({ id: op.id, kind: op.kind, from: a, to: a + 1 });
  }
  return gaps.sort((p, q) => p.from - q.from);
}

function buildingRun(
  c: StoreyCtx,
  run: readonly FaceCell[],
  outside: boolean,
  groundRoom: AreaId | null,
): { face: FaceDraft; openings: OpeningAnchor[] } {
  const { st, sp, s } = c;
  const first = run[0] as FaceCell;
  const { frame, n, lo, hi } = buildingRunFrame(run, outside, sp.floorTop);
  const [dx, dy] = SIDE_STEP[first.face];
  // a face against another building's cells is the far side of a party wall: no one sees it
  const seen = !outside || run.some((f) => !c.foreign.has(key(f.x + dx, f.y + dy)));
  const gaps = storeyGaps(c, run, n, lo, hi);
  const face: FaceDraft = {
    kind: "face",
    key: `face:B:${st.id}:${c.v.id}:${s}:${outside ? "out" : "in"}:${first.face}:${edgeLine(first.face, first.x, first.y)}:${lo}`,
    frame,
    theme: st.theme,
    element: st.id,
    structure: st.id,
    storey: s,
    room: outside ? null : groundRoom,
    outside,
    seen,
    layer: `storey:${s}`,
    length: hi - lo + 1,
    height: sp.wallTop - sp.floorTop,
    style: sp.walls ?? "",
    natural: false,
    plane: outside ? 0.5 : 0,
    gaps,
    ends: ["open", "open"],
    beyond: [0, 0],
    footed: c.ground && outside && (sp.footing !== null || st.plinth !== undefined),
  };
  // a window sits on the footing (ground) or on the wall top below (upper storeys); a door on the floor
  const footing = c.ground ? (sp.footing?.height ?? 0) : -0.5;
  const ops = gaps.map((gap) => openingAnchor(face, gap, isWindow(gap.kind) ? footing : 0, face.height));
  return { face, openings: ops };
}

/** A storey line along a run of a storey's outside faces (frame base: the storey's floor top). */
function storeyLine(c: StoreyCtx, run: readonly FaceCell[]): LineDraft {
  const { st, sp, s } = c;
  const first = run[0] as FaceCell;
  const { frame, n, lo, hi } = buildingRunFrame(run, true, sp.floorTop);
  const [dx, dy] = SIDE_STEP[first.face];
  const seen = run.some((f) => !c.foreign.has(key(f.x + dx, f.y + dy)));
  const base = s === 0 && c.v.on === null;
  const gaps = base ? storeyGaps(c, run, n, lo, hi).filter((q) => isPassage(q.kind)) : [];
  return {
    kind: "storeyLine",
    key: `line:${st.id}:${c.v.id}:${s}:${first.face}:${edgeLine(first.face, first.x, first.y)}:${lo}`,
    frame,
    theme: st.theme,
    element: st.id,
    structure: st.id,
    storey: s,
    room: null,
    outside: true,
    seen,
    layer: `storey:${s}`,
    line: base ? "base" : "floor",
    length: hi - lo + 1,
    band: base ? 0 : 0.5,
    gaps,
    ends: ["open", "open"],
    beyond: [0, 0],
    style: sp.walls ?? "",
    floor: sp.floor,
    footed: base && (sp.footing !== null || st.plinth !== undefined),
  };
}

// ───────────────────────────── openings and corners ─────────────────────────────

/** The anchor of an opening along a face: centred on its gap at the face's surface, jambs paired. */
function openingAnchor(face: FaceDraft, gap: FaceGap, sill: number, head: number): OpeningAnchor {
  const width = gap.to - gap.from;
  const before = face.gaps.filter((q) => q.to <= gap.from + EPS);
  const after = face.gaps.filter((q) => q.from >= gap.to - EPS);
  const left = before.length > 0 ? maxOf(before.map((q) => q.to)) : 0;
  const right = after.length > 0 ? minOf(after.map((q) => q.from)) : face.length;
  const frame = shiftFrame(face.frame, (gap.from + gap.to) / 2);
  return {
    kind: "opening",
    key: `${face.key}:op:${gap.id}`,
    frame,
    theme: face.theme,
    element: face.element,
    structure: face.structure,
    storey: face.storey,
    room: face.room,
    outside: face.outside,
    seen: face.seen,
    ...(face.layer !== undefined ? { layer: face.layer } : {}),
    id: gap.id,
    openingKind: gap.kind,
    width,
    sill,
    head,
    jambs: [shiftFrame(face.frame, gap.to), { ...shiftFrame(face.frame, gap.from), mirror: true }],
    face: face.key,
    style: face.style,
    natural: face.natural,
    clear: [gap.from - left, right - gap.to],
    between: [before.length > 0, after.length > 0],
  };
}

/** A straight run along a wall (a face or a storey line) as the corner walk reads it. */
interface Run {
  readonly frame: AnchorFrame;
  readonly length: number;
  readonly structure: string | null;
  readonly outside: boolean;
  readonly storey: number;
  readonly ends: [FaceEnd, FaceEnd];
  readonly beyond: [number, number];
}

/**
 * Where runs meet: the end of one run and the start of another on the same side of the walls, their surfaces meeting at
 * a right angle within half a tile of both. Convex when the second turns clockwise from the first (seen from above,
 * plan y south: the walls turn away from the viewer, an outer corner), concave when it turns the other way. Both runs'
 * `ends` are set; `meet` is told every meeting, in run order.
 */
function meetings<R extends Run>(
  runs: readonly R[],
  meet: (a: R, b: R, p: [number, number], convex: boolean) => void,
): void {
  const starts = new Map<string, R[]>();
  const cellOf = (p: readonly [number, number]): string => `${Math.round(p[0])},${Math.round(p[1])}`;
  for (const r of runs) {
    const k = cellOf(r.frame.at);
    const list = starts.get(k) ?? [];
    list.push(r);
    starts.set(k, list);
  }
  for (const a of runs) {
    const end = framePoint(a.frame, a.length, 0);
    const [ux, uy] = frameDir(a.frame);
    const near = new Set<R>();
    for (const dx of [-1, 0, 1])
      for (const dy of [-1, 0, 1])
        for (const r of starts.get(`${Math.round(end[0]) + dx},${Math.round(end[1]) + dy}`) ?? [])
          near.add(r);
    for (const b of near) {
      if (b === a || b.structure !== a.structure || b.outside !== a.outside || b.storey !== a.storey)
        continue;
      const [vx, vy] = frameDir(b.frame);
      // clockwise quarter turn of (ux, uy) with y south is (-uy, ux)
      const cw = Math.abs(vx + uy) < EPS && Math.abs(vy - ux) < EPS;
      const ccw = Math.abs(vx - uy) < EPS && Math.abs(vy + ux) < EPS;
      if (!cw && !ccw) continue;
      // where the two surfaces' lines cross
      const p = crossing(end, [ux, uy], b.frame.at, [vx, vy]);
      if (!p) continue;
      const da = Math.hypot(p[0] - end[0], p[1] - end[1]);
      const db = Math.hypot(p[0] - b.frame.at[0], p[1] - b.frame.at[1]);
      if (da > 0.5 + EPS || db > 0.5 + EPS) continue;
      a.ends[1] = cw ? "convex" : "concave";
      b.ends[0] = cw ? "convex" : "concave";
      // signed: past a's end along u, and before b's start against v
      a.beyond[1] = (p[0] - end[0]) * ux + (p[1] - end[1]) * uy;
      b.beyond[0] = (b.frame.at[0] - p[0]) * vx + (b.frame.at[1] - p[1]) * vy;
      meet(a, b, p, cw);
    }
  }
}

/** The corners where faces meet (both faces' `ends` set). */
function cornersOf(faces: FaceDraft[]): CornerAnchor[] {
  const out: CornerAnchor[] = [];
  meetings(faces, (a, b, p, convex) => {
    const base = Math.min(a.frame.base, b.frame.base);
    out.push({
      kind: "corner",
      key: `corner:${a.key}|${b.key}`,
      frame: { at: p, turn: b.frame.turn, base },
      theme: a.theme,
      element: a.element,
      structure: a.structure,
      storey: a.storey,
      room: a.room,
      outside: a.outside,
      seen: a.seen && b.seen,
      ...(a.layer !== undefined ? { layer: a.layer } : {}),
      convex,
      height: Math.min(a.height + a.frame.base, b.height + b.frame.base) - base,
      faces: [
        { at: p, turn: a.frame.turn, base: a.frame.base, mirror: true },
        { at: p, turn: b.frame.turn, base: b.frame.base },
      ],
      faceKeys: [a.key, b.key],
      style: a.style,
      natural: a.natural || b.natural,
    });
  });
  return out;
}

/** Where the line through `a` along `u` crosses the line through `b` along `v` (null when parallel). */
function crossing(
  a: readonly [number, number],
  u: readonly [number, number],
  b: readonly [number, number],
  v: readonly [number, number],
): [number, number] | null {
  const det = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(det) < EPS) return null;
  const t = ((b[0] - a[0]) * v[1] - (b[1] - a[1]) * v[0]) / det;
  return [a[0] + u[0] * t, a[1] + u[1] * t];
}
