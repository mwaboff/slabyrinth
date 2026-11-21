/**
 * Step 6 of a level: openings (doors, windows, arches, open gaps) in the walls.
 * Reads: the level's openings (`between` two areas or `at` an edge), the corridors the areas drew between them (the
 * routes stepAreas returned), the edge arrays and cell owners. Writes: the level's openings (one ResolvedOpening each,
 * the list it is handed; read-only to every later stage) and the edges they take: an opening edge (kind, ref, height,
 * style) or, for kind "open", a cleared edge marked `opened`.
 */
import type { OpeningKind } from "../../contracts/plan";
import type { ResolvedOpening } from "../../contracts/resolved";
import { EDGE } from "../../contracts/resolved";
import { isGap, isSecret, openingWidth } from "../../gen/openingKinds";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import { edgeCol, edgeRow } from "../levelGrid";
import type { RouteRecord } from "./areas";
import type { AreaInfo, ResolveGrid } from "./grid";

function areaIdOf(work: ResolveGrid, region: number): string | null {
  return region > 0 ? (work.areas[region - 1] as AreaInfo).area.id : null;
}

/** Maximal straight runs of the given edges. */
function runsOf(
  work: ResolveGrid,
  edges: Array<{ orient: "h" | "v"; i: number }>,
): Array<{ orient: "h" | "v"; idx: number[]; start: [number, number] }> {
  const runs: Array<{ orient: "h" | "v"; idx: number[]; start: [number, number] }> = [];
  for (const orient of ["h", "v"] as const) {
    const list = edges
      .filter((e) => e.orient === orient)
      .map((e) => {
        const [x, y] = work.edgeStart(orient, e.i);
        return { i: e.i, line: orient === "h" ? y : x, pos: orient === "h" ? x : y };
      })
      .sort((p, q) => p.line - q.line || p.pos - q.pos);
    let cur: { line: number; last: number; idx: number[] } | null = null;
    for (const e of list) {
      if (cur && cur.line === e.line && e.pos === cur.last + 1) {
        cur.idx.push(e.i);
        cur.last = e.pos;
      } else {
        if (cur) runs.push({ orient, idx: cur.idx, start: work.edgeStart(orient, cur.idx[0] as number) });
        cur = { line: e.line, last: e.pos, idx: [e.i] };
      }
    }
    if (cur) runs.push({ orient, idx: cur.idx, start: work.edgeStart(orient, cur.idx[0] as number) });
  }
  return runs;
}

/** Longest run; ties → smallest start y, then x, then horizontal before vertical. */
function pickRun<T extends { orient: "h" | "v"; idx: number[]; start: [number, number] }>(
  runs: T[],
): T | null {
  let best: T | null = null;
  for (const r of runs) {
    if (
      !best ||
      r.idx.length > best.idx.length ||
      (r.idx.length === best.idx.length &&
        (r.start[1] < best.start[1] ||
          (r.start[1] === best.start[1] &&
            (r.start[0] < best.start[0] ||
              (r.start[0] === best.start[0] && r.orient === "h" && best.orient === "v")))))
    )
      best = r;
  }
  return best;
}

function placeOpening(
  work: ResolveGrid,
  out: ResolvedOpening[],
  o: { id: string; kind: OpeningKind; label?: string; gmOnly?: boolean },
  orient: "h" | "v",
  idx: number[],
  path: string,
  explicitAt: boolean,
  silentOverlap: boolean,
): boolean {
  const e = orient === "h" ? work.hE : work.vE;
  for (const i of idx) {
    if (e.kind[i] === EDGE.OPENING || e.opened[i] === 1) {
      if (!silentOverlap) {
        const [x, y] = work.edgeStart(orient, i);
        work.issue(
          "error",
          "opening_overlap",
          `opening "${o.id}" overlaps another opening at edge ${orient} ${x},${y}`,
          {
            path,
            elementId: o.id,
            hint: "move it with position (0..1) or remove the other opening",
          },
        );
      }
      return false;
    }
  }
  const first = idx[0] as number;
  const [a, b] = work.edgeCells(orient, first);
  const anyWall = idx.some((i) => e.kind[i] === EDGE.WALL);
  if (explicitAt && !anyWall && !isGap(o.kind)) {
    const [x, y] = work.edgeStart(orient, first);
    work.issue(
      "warning",
      "opening_no_boundary",
      `opening "${o.id}" is not on a wall (edge ${orient} ${x},${y}); it is placed anyway`,
      {
        path,
        elementId: o.id,
        hint: "use between: [areaA, areaB] to snap it onto a shared wall",
      },
    );
  } else if (!explicitAt && !silentOverlap && !anyWall && !isGap(o.kind)) {
    const [x, y] = work.edgeStart(orient, first);
    work.issue(
      "warning",
      "opening_no_boundary",
      `opening "${o.id}" (${o.kind}) stands where there is no wall between its two areas (edge ${orient} ${x},${y}), so it is a free-standing ${o.kind.replace("_", " ")} in the open`,
      {
        path,
        elementId: o.id,
        hint: 'use kind "open" (or remove it), or give one of the areas walls "auto" so a wall separates them (natural cave rock never stands between two open areas)',
      },
    );
  }
  const style = e.style[first] ?? THEME_WALL_STYLE;
  const k = out.length;
  const rec: ResolvedOpening = {
    id: o.id,
    kind: o.kind,
    orientation: orient,
    start: work.edgeStart(orient, first),
    width: idx.length,
    sides: [areaIdOf(work, work.owner(a)), areaIdOf(work, work.owner(b))],
    wallStyle: style,
    theme: work.themeAt(b >= 0 ? b : a),
  };
  if (o.label !== undefined) rec.label = o.label;
  if (o.gmOnly === true || isSecret(o.kind)) rec.gmOnly = true;
  out.push(rec);
  for (const i of idx) {
    const wasWall = e.kind[i] === EDGE.WALL;
    if (isGap(o.kind)) {
      e.kind[i] = EDGE.NONE;
      e.style[i] = null;
      e.height[i] = 0;
      e.opened[i] = 1;
    } else {
      e.kind[i] = EDGE.OPENING;
      e.ref[i] = k;
      if (!wasWall) e.height[i] = work.defaultWallHeight;
      if (e.style[i] === null) e.style[i] = style;
    }
  }
  return true;
}

export function stepOpenings(
  work: ResolveGrid,
  routes: readonly RouteRecord[],
  out: ResolvedOpening[],
): void {
  work.level.openings.forEach((o, k) => {
    const path = `/levels/${work.li}/openings/${k}`;
    const width0 = openingWidth(o);
    if (o.between) {
      const ids = o.between;
      const res = ids.map((id) => (id === "@outside" ? 0 : (work.areaIndexById.get(id) ?? -1) + 1));
      const [ra, rb] = res as [number, number];
      const unknown = ids.filter((id, j) => id !== "@outside" && (res[j] as number) === 0);
      if (unknown.length > 0) {
        work.issue("error", "ref_unknown", `opening "${o.id}" names unknown area(s) ${unknown.join(", ")}`, {
          path: `${path}/between`,
          elementId: o.id,
          hint: `areas on ${work.level.id}: ${work.level.areas.map((a) => a.id).join(", ")}`,
        });
        return;
      }
      if (ra === rb) {
        work.issue("error", "opening_no_boundary", `opening "${o.id}" needs two different sides`, {
          path: `${path}/between`,
          elementId: o.id,
        });
        return;
      }
      const matches: Array<{ orient: "h" | "v"; i: number }> = [];
      const test = (orient: "h" | "v", i: number): void => {
        const [a, b] = work.edgeCells(orient, i);
        const oa = work.owner(a);
        const ob = work.owner(b);
        if ((oa === ra && ob === rb) || (oa === rb && ob === ra)) matches.push({ orient, i });
      };
      for (let i = 0; i < work.hE.kind.length; i++) test("h", i);
      for (let i = 0; i < work.vE.kind.length; i++) test("v", i);
      const run = pickRun(runsOf(work, matches));
      if (!run) {
        work.issue(
          "error",
          "opening_no_boundary",
          `areas ${ids[0]} and ${ids[1]} share no edge, so "${o.id}" has nowhere to go`,
          {
            path: `${path}/between`,
            elementId: o.id,
            hint: nearestHint(work, ra, rb),
          },
        );
        return;
      }
      const len = run.idx.length;
      const wd = Math.min(width0, len);
      const pos = Math.min(1, Math.max(0, o.position ?? 0.5));
      const off = Math.min(len - wd, Math.max(0, Math.floor((len - wd) * pos)));
      placeOpening(work, out, o, run.orient, run.idx.slice(off, off + wd), path, false, false);
      return;
    }
    if (o.at) {
      const ed = work.sideEdge(o.at.x, o.at.y, o.at.side);
      if (!ed) {
        work.issue("error", "bounds_exceeded", `opening "${o.id}" is outside the level bounds`, {
          path: `${path}/at`,
          elementId: o.id,
        });
        return;
      }
      const idx: number[] = [];
      const col = edgeCol(work, ed.orient, ed.i);
      const row = edgeRow(work, ed.orient, ed.i);
      for (let j = 0; j < width0; j++) {
        const next = ed.orient === "h" ? work.hIndex(col + j, row) : work.vIndex(col, row + j);
        if (!next) {
          work.issue(
            "error",
            "bounds_exceeded",
            `opening "${o.id}" (width ${width0}) runs past the level bounds`,
            {
              path: `${path}/width`,
              elementId: o.id,
            },
          );
          return;
        }
        idx.push(next.i);
      }
      placeOpening(work, out, o, ed.orient, idx, path, true, false);
    }
  });
  for (const r of routes) {
    const info = work.areas[r.ai] as AreaInfo;
    const make = (
      target: number,
      square: Array<[number, number]>,
      suffix: "a" | "b",
      prefer: "h" | "v" | null,
    ): void => {
      if (target < 0) return;
      const routeCells = new Set(
        square.map(([x, y]) => work.idx(x, y)).filter((i) => i >= 0 && work.struct[i] === r.ai + 1),
      );
      let matches = meetingEdges(work, r.ai + 1, target + 1, routeCells);
      if (matches.length === 0) matches = meetingEdges(work, r.ai + 1, target + 1, null);
      if (prefer && matches.some((m) => m.orient === prefer))
        matches = matches.filter((m) => m.orient === prefer);
      const run = pickRun(runsOf(work, matches));
      if (!run) return;
      const len = run.idx.length;
      const wd = Math.min(len, r.width, 3);
      const off = Math.floor((len - wd) * 0.5);
      placeOpening(
        work,
        out,
        { id: `${info.area.id}~${suffix}`, kind: r.kind },
        run.orient,
        run.idx.slice(off, off + wd),
        `/levels/${work.li}/areas/${r.ai}`,
        false,
        true,
      );
    };
    make(r.from, r.startSquare, "a", r.orientA);
    make(r.to, r.endSquare, "b", r.orientB);
  }
}

function meetingEdges(
  work: ResolveGrid,
  routeRegion: number,
  targetRegion: number,
  only: Set<number> | null,
): Array<{ orient: "h" | "v"; i: number }> {
  const out: Array<{ orient: "h" | "v"; i: number }> = [];
  const test = (orient: "h" | "v", i: number): void => {
    const [a, b] = work.edgeCells(orient, i);
    if (a < 0 || b < 0) return;
    const oa = work.struct[a] as number;
    const ob = work.struct[b] as number;
    if (oa === routeRegion && ob === targetRegion && (!only || only.has(a))) out.push({ orient, i });
    else if (ob === routeRegion && oa === targetRegion && (!only || only.has(b))) out.push({ orient, i });
  };
  for (let i = 0; i < work.hE.kind.length; i++) test("h", i);
  for (let i = 0; i < work.vE.kind.length; i++) test("v", i);
  return out;
}

function nearestHint(work: ResolveGrid, ra: number, rb: number): string {
  const cellsOf = (r: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < work.n; i++) {
      if (r === 0 ? work.struct[i] === 0 : work.struct[i] === r) out.push(i);
    }
    return out;
  };
  // multi-source BFS from every cell of A (Manhattan distance on the full grid): O(cells)
  const A = cellsOf(ra);
  const inB = new Uint8Array(work.n);
  for (const j of cellsOf(rb)) inB[j] = 1;
  const dist = new Int32Array(work.n).fill(-1);
  const src = new Int32Array(work.n);
  const queue: number[] = [];
  for (const i of A) {
    dist[i] = 0;
    src[i] = i;
    queue.push(i);
  }
  let best = Infinity;
  let pa: [number, number] = [0, 0];
  let pb: [number, number] = [0, 0];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    if (inB[i] === 1) {
      best = dist[i] as number;
      pa = work.cellXY(src[i] as number);
      pb = work.cellXY(i);
      break;
    }
    const lx = i % work.w;
    for (const j of [i - work.w, lx < work.w - 1 ? i + 1 : -1, i + work.w, lx > 0 ? i - 1 : -1]) {
      if (j < 0 || j >= work.n || dist[j] !== -1) continue;
      dist[j] = (dist[i] as number) + 1;
      src[j] = src[i] as number;
      queue.push(j);
    }
  }
  if (!Number.isFinite(best)) return "one of the areas has no cells";
  return `nearest cells are ${pa[0]},${pa[1]} and ${pb[0]},${pb[1]} (${best - 1} cells apart); connect them with a corridor (route) or use at:{x,y,side}`;
}
