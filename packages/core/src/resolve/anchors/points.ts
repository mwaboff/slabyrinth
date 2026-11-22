/**
 * Point-like anchors: tops of furniture (`@surface`), room centres, focal features and floor openings (`@point`),
 * lines between two points (`@path`), and the runs of edges where the floor changes (`@boundary`).
 * Reads: the resolved level (and, for a surface's height, the caller's `topOf`). Writes: nothing.
 */
import type { ResolvedFeature, ResolvedLevel } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import type { LevelGrid } from "../levelGrid";
import { runFrame } from "./frame";
import type { BoundaryAnchor, PathAnchor, PointAnchor, SurfaceAnchor } from "./types";

/** The absolute top a feature offers (the palette's piece it is built with), or null when unknown. */
export type TopOf = (f: ResolvedFeature) => number | null;

/** Tops of the level's furniture that things rest on (gen/catalog.ts `support`), seated ones flagged. */
export function surfaceAnchors(L: ResolvedLevel, g: LevelGrid, topOf: TopOf): SurfaceAnchor[] {
  const out: SurfaceAnchor[] = [];
  for (const f of L.features) {
    const info = featureInfo(f.type);
    if (info.support !== true) continue;
    const top = topOf(f);
    out.push({
      kind: "surface",
      key: `surface:${f.id}`,
      frame: {
        at: [f.at[0] + f.size[0] / 2 + (f.offset?.[0] ?? 0), f.at[1] + f.size[1] / 2 + (f.offset?.[1] ?? 0)],
        turn: (((f.rot + f.rotFine) % 360) + 360) % 360,
        base: top ?? g.top(f.at[0], f.at[1]),
      },
      theme: g.themeAt(f.theme, f.at[0], f.at[1]),
      element: f.id,
      structure: null,
      storey: 0,
      room: f.area ?? null,
      outside: false,
      seen: true,
      feature: f.id,
      type: f.type,
      size: [f.size[0], f.size[1]],
      top,
      seated: info.seatsAt === true,
    });
  }
  return out;
}

/** Room centres, focal features and floor openings, each with what is overhead. */
export function pointAnchors(
  L: ResolvedLevel,
  g: LevelGrid,
  ceilingOf: (x: number, y: number) => number | null,
): PointAnchor[] {
  const out: PointAnchor[] = [];
  const point = (
    key: string,
    what: PointAnchor["what"],
    at: readonly [number, number],
    element: string,
    room: string | null,
    theme: string,
  ): void => {
    const cx = Math.floor(at[0]);
    const cy = Math.floor(at[1]);
    out.push({
      kind: "point",
      key,
      frame: { at: [at[0], at[1]], turn: 0, base: g.top(cx, cy) },
      theme,
      element,
      structure: null,
      storey: 0,
      room,
      outside: false,
      seen: true,
      what,
      ceiling: ceilingOf(cx, cy),
    });
  };
  for (const a of L.areas)
    if (a.cellCount > 0)
      point(`point:room:${a.id}`, "room", [a.anchor[0] + 0.5, a.anchor[1] + 0.5], a.id, a.id, a.theme);
  for (const f of L.features)
    if (featureInfo(f.type).focusPiece === true)
      point(
        `point:focal:${f.id}`,
        "focal",
        [f.at[0] + f.size[0] / 2, f.at[1] + f.size[1] / 2],
        f.id,
        f.area ?? null,
        g.themeAt(f.theme, f.at[0], f.at[1]),
      );
  for (const fo of L.floorOpenings ?? []) {
    if (fo.cells.length === 0) continue;
    const cx = fo.cells.reduce((s, c) => s + c[0], 0) / fo.cells.length + 0.5;
    const cy = fo.cells.reduce((s, c) => s + c[1], 0) / fo.cells.length + 0.5;
    const c0 = fo.cells[0] as readonly [number, number];
    point(`point:hole:${fo.id}`, "floorOpening", [cx, cy], fo.id, null, g.cell(c0[0], c0[1]).theme);
  }
  return out;
}

/** Overhead lines and road axes. */
export function pathAnchors(L: ResolvedLevel, g: LevelGrid): PathAnchor[] {
  const out: PathAnchor[] = [];
  const path = (
    key: string,
    what: PathAnchor["what"],
    pts: ReadonlyArray<readonly [number, number]>,
    base: number,
    element: string,
  ): void => {
    const p0 = pts[0];
    if (!p0) return;
    out.push({
      kind: "path",
      key,
      frame: { at: [p0[0], p0[1]], turn: 0, base },
      theme: g.cell(Math.floor(p0[0]), Math.floor(p0[1])).theme,
      element,
      structure: null,
      storey: 0,
      room: null,
      outside: true,
      seen: true,
      what,
      points: pts.map((p) => [p[0], p[1]] as const),
    });
  };
  for (const ln of L.lines ?? [])
    path(
      `path:line:${ln.id}`,
      "line",
      [
        [ln.a[0] + 0.5, ln.a[1] + 0.5],
        [ln.b[0] + 0.5, ln.b[1] + 0.5],
      ],
      L.elevation + ln.height,
      ln.id,
    );
  for (const r of L.roads ?? []) {
    const a0 = r.axis[0];
    if (!a0) continue;
    path(
      `path:road:${r.id}`,
      "road",
      r.axis.map((p) => [p[0] + 0.5, p[1] + 0.5] as const),
      g.top(a0[0], a0[1]),
      r.id,
    );
  }
  return out;
}

/**
 * Runs of edges where the floor changes between two open floor cells with no wall: a ledge (EDGE.LEDGE), a step (a
 * height change), a change of floor material. Each run is one straight stretch along a grid line, its normal toward
 * the lower (or the second) side.
 */
export function boundaryAnchors(L: ResolvedLevel, g: LevelGrid): BoundaryAnchor[] {
  const out: BoundaryAnchor[] = [];
  type Edge = {
    what: BoundaryAnchor["what"];
    drop: number;
    lowSecond: boolean;
    theme: string;
    room: string | null;
    base: number;
  };
  const classify = (ax: number, ay: number, bx: number, by: number, kind: number): Edge | null => {
    const a = g.cell(ax, ay);
    const b = g.cell(bx, by);
    if (!a.floor || !b.floor || (L.cells.state[g.index(ax, ay)] ?? CELL.VOID) !== CELL.OPEN) return null;
    if (kind === EDGE.WALL || kind === EDGE.OPENING || kind === EDGE.STAIR) return null;
    const bridge = ((a.flags | b.flags) & CELL_FLAG.BRIDGE) !== 0;
    if (bridge) return null;
    const drop = Math.abs(a.height - b.height);
    const what: BoundaryAnchor["what"] | null =
      kind === EDGE.LEDGE ? "ledge" : drop > 0 ? "step" : a.material !== b.material ? "material" : null;
    if (what === null) return null;
    const lowSecond = b.height <= a.height;
    const low = lowSecond ? b : a;
    return {
      what,
      drop,
      lowSecond,
      theme: low.theme,
      room: low.area > 0 ? (L.areaIds[low.area - 1] ?? null) : null,
      base: lowSecond ? g.top(bx, by) : g.top(ax, ay),
    };
  };
  // horizontal lines (edges between a cell and the one south of it), then vertical
  for (const orient of ["h", "v"] as const) {
    const lines = orient === "h" ? g.h - 1 : g.w - 1;
    const len = orient === "h" ? g.w : g.h;
    for (let l = 1; l <= lines; l++) {
      let run: { start: number; e: Edge } | null = null;
      const flush = (end: number): void => {
        if (!run) return;
        const e = run.e;
        const line = orient === "h" ? g.y0 + l : g.x0 + l;
        const lo = (orient === "h" ? g.x0 : g.y0) + run.start;
        const hi = (orient === "h" ? g.x0 : g.y0) + end - 1;
        const n = orient === "h" ? (e.lowSecond ? "S" : "N") : e.lowSecond ? "E" : "W";
        out.push({
          kind: "boundary",
          key: `boundary:${orient}:${line}:${lo}`,
          frame: runFrame(n, line, lo, hi, 0, e.base),
          theme: e.theme,
          element: e.room ?? L.id,
          structure: null,
          storey: 0,
          room: e.room,
          outside: false,
          seen: true,
          what: e.what,
          length: hi - lo + 1,
          drop: e.drop,
        });
        run = null;
      };
      for (let p = 0; p < len; p++) {
        const [ax, ay, bx, by] =
          orient === "h"
            ? [g.x0 + p, g.y0 + l - 1, g.x0 + p, g.y0 + l]
            : [g.x0 + l - 1, g.y0 + p, g.x0 + l, g.y0 + p];
        const kind = g.edgeKind(bx, by, orient === "h" ? "N" : "W");
        const e = classify(ax, ay, bx, by, kind) ?? null;
        const same =
          run !== null &&
          e !== null &&
          run.e.what === e.what &&
          run.e.drop === e.drop &&
          run.e.lowSecond === e.lowSecond &&
          run.e.room === e.room;
        if (!same) flush(p);
        if (e && !run) run = { start: p, e };
      }
      flush(len);
    }
  }
  return out;
}
