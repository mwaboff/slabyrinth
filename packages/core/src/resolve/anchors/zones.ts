/**
 * Floor zones (`@zone`), one anchor per area with open floor: each cell's zone bits and focal score, the room's doors
 * and focal point. What the interior recipes (furniture groups, floor groups, station rows, lights) and the recipe
 * engine's keep-clear rule read.
 *
 *   band     distance (4-neighbour steps inside the room) to a cell that touches a boundary: a wall, an opening, a ledge
 *            or the room's edge. BAND1 touches one, BAND2 is within two cells.
 *   doors    the room's side of every passage opening between it and somewhere (ResolvedOpening.sides). DOOR is the
 *            apron: the cell at the opening and the one straight in front of it.
 *   focal    the room's focal feature (gen/catalog.ts `focusPiece`, the largest), else the floor cell farthest from its
 *            doors (the far end a visitor looks at), else its anchor.
 *   lanes    shortest walkable paths (no blocking feature on the way) from every door and every stair or link cell to
 *            the focal point, and between every two doors (the first four doors), one cell wide.
 *   shape    the room's centroid and long axis (for rows along it, a gathering table on it).
 *   edge     steps to where the ground meets something (a wall, a step, another material, water, another area, a
 *            blocking feature), the board's own edge excepted: where ground cover gathers.
 *   place    indoor (a room or corridor), mostly natural ground, and wear (a rough finish, abandoned, a ruin).
 *   middle   room floor that is neither band, lane nor apron; END the fifth of a long room's length at each end.
 *   score    1 at a door or the focal point, falling linearly to 0 four cells from a door and five from the focal point.
 * Pure over the resolved level; breadth-first walks over the room's own cells (linear in its size per door).
 */
import type { Side, Vec2 } from "../../contracts/plan";
import type { ResolvedArea, ResolvedFeature, ResolvedLevel } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import { NEIGHBOURS4, OPPOSITE, SIDE_STEP, SIDES } from "../../gen/gridGeometry";
import { isPassage } from "../../gen/openingKinds";
import { MATERIAL_INFO } from "../materials";
import type { LevelGrid } from "../levelGrid";
import { ZONE, type ZoneAnchor, type ZoneDoor } from "./types";

/** Door aprons reach this many cells straight into the room (the cell at the opening counts as the first). */
const APRON = 2;
/** Lanes between doors are traced for at most this many doors of a room (each pair is one walk). */
const LANE_DOORS = 4;
/** Focal score falls to 0 this many cells from a door, and from the focal point. */
const DOOR_REACH = 4;
const FOCAL_REACH = 5;
/** A room this much longer than wide has ends. */
const LONG_ROOM = 1.6;

export function zoneAnchors(L: ResolvedLevel, g: LevelGrid): ZoneAnchor[] {
  const n = g.w * g.h;
  const bits = new Uint8Array(n);
  const score = new Float32Array(n);
  const edge = new Float32Array(n).fill(Infinity);
  const cellsBy = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const a = L.cells.area[i] ?? 0;
    if (a === 0 || (L.cells.state[i] ?? CELL.VOID) !== CELL.OPEN) continue;
    const list = cellsBy.get(a) ?? [];
    list.push(i);
    cellsBy.set(a, list);
  }
  const out: ZoneAnchor[] = [];
  const index = (x: number, y: number): number => g.index(x, y);
  for (const [a, cells] of [...cellsBy].sort((p, q) => p[0] - q[0])) {
    const area = L.areas[a - 1];
    if (!area) continue;
    const z = roomZones(L, g, area, a, cells, bits, score, edge);
    if (!z) continue;
    out.push({
      kind: "zone",
      key: `zone:${area.id}`,
      frame: { at: [z.focal[0] + 0.5, z.focal[1] + 0.5], turn: 0, base: g.top(z.focal[0], z.focal[1]) },
      theme: area.theme,
      element: area.id,
      structure: null,
      storey: 0,
      room: area.id,
      outside: area.kind === "courtyard" || area.kind === "zone" || area.kind === "bridge",
      seen: true,
      area: area.id,
      ...(area.purpose !== undefined ? { purpose: area.purpose } : {}),
      cells: cells.map((i) => [g.x0 + (i % g.w), g.y0 + Math.floor(i / g.w)] as Vec2),
      doors: z.doors,
      focalFeature: z.focalFeature,
      centroid: z.centroid,
      longAxis: z.longAxis,
      indoor: area.kind === "room" || area.kind === "corridor",
      natural: z.natural,
      wear: area.abandoned === true || area.purpose === "ruin" ? 2 : area.finish === "rough" ? 1 : 0,
      edgeAt: (x, y) => {
        const i = index(x, y);
        return i >= 0 && (L.cells.area[i] ?? 0) === a ? (edge[i] ?? Infinity) : Infinity;
      },
      classAt: (x, y) => {
        const i = index(x, y);
        return i >= 0 && (L.cells.area[i] ?? 0) === a ? (bits[i] ?? 0) : 0;
      },
      focalAt: (x, y) => {
        const i = index(x, y);
        return i >= 0 && (L.cells.area[i] ?? 0) === a ? (score[i] ?? 0) : 0;
      },
    });
  }
  return out;
}

interface RoomZones {
  centroid: [number, number];
  longAxis: "x" | "y";
  natural: boolean;
  focal: [number, number];
  focalFeature: string | null;
  doors: ZoneDoor[];
}

function roomZones(
  L: ResolvedLevel,
  g: LevelGrid,
  area: ResolvedArea,
  a: number,
  cells: readonly number[],
  bits: Uint8Array,
  score: Float32Array,
  edge: Float32Array,
): RoomZones | null {
  const w = g.w;
  const mine = (i: number): boolean =>
    i >= 0 && (L.cells.area[i] ?? 0) === a && L.cells.state[i] === CELL.OPEN;
  const xy = (i: number): [number, number] => [g.x0 + (i % w), g.y0 + Math.floor(i / w)];
  // features of the room: blocking footprints, and the focal one
  const blocked = new Set<number>();
  let focalFeature: ResolvedFeature | null = null;
  for (const f of L.features) {
    if (f.area !== area.id) continue;
    if (f.blocking && !f.wall)
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) blocked.add(g.index(f.at[0] + dx, f.at[1] + dy));
    if (featureInfo(f.type).focusPiece !== true) continue;
    const size = f.size[0] * f.size[1];
    if (!focalFeature || size > focalFeature.size[0] * focalFeature.size[1]) focalFeature = f;
  }
  const passable = (i: number): boolean =>
    mine(i) && !blocked.has(i) && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0;

  // band: steps to a cell touching a boundary
  const touch: number[] = [];
  for (const i of cells) {
    const [x, y] = xy(i);
    const touches = SIDES.some((s) => {
      const k = g.edgeKind(x, y, s);
      if (k === EDGE.WALL || k === EDGE.OPENING || k === EDGE.LEDGE) return true;
      const [dx, dy] = SIDE_STEP[s];
      return !mine(g.index(x + dx, y + dy));
    });
    if (touches) touch.push(i);
  }
  const band = walk(g, touch, mine);

  // where the ground meets something (the board's own edge is nothing): ground cover gathers there
  const meets: number[] = [];
  let natural = 0;
  for (const i of cells) {
    const [x, y] = xy(i);
    const c = g.cell(x, y);
    if (c.material !== null && MATERIAL_INFO[c.material].natural) natural++;
    const at = SIDES.some((s) => {
      if (g.edgeKind(x, y, s) !== EDGE.NONE) return true;
      const [dx, dy] = SIDE_STEP[s];
      const o = g.cell(x + dx, y + dy);
      if (!o.inBounds) return false;
      const j = g.index(x + dx, y + dy);
      return (
        !mine(j) ||
        blocked.has(j) ||
        o.material !== c.material ||
        o.height !== c.height ||
        ((o.flags | c.flags) & CELL_FLAG.WATER) !== 0
      );
    });
    if (at) meets.push(i);
  }
  for (const [i, d] of walk(g, meets, mine)) edge[i] = d;

  // doors: the room's side of every passage opening it has
  const doors: ZoneDoor[] = [];
  for (const op of L.openings) {
    if (!isPassage(op.kind) || (op.sides[0] !== area.id && op.sides[1] !== area.id)) continue;
    const doorCells: Vec2[] = [];
    let side: Side = "N";
    for (let k = 0; k < op.width; k++) {
      const [ex, ey] =
        op.orientation === "h" ? [op.start[0] + k, op.start[1]] : [op.start[0], op.start[1] + k];
      // the two cells of the edge: north and south of an h edge, west and east of a v edge
      const pair: Array<[number, number, Side]> =
        op.orientation === "h"
          ? [
              [ex, ey - 1, "S"],
              [ex, ey, "N"],
            ]
          : [
              [ex - 1, ey, "E"],
              [ex, ey, "W"],
            ];
      for (const [cx, cy, s] of pair)
        if (mine(g.index(cx, cy))) {
          doorCells.push([cx, cy]);
          side = s;
        }
    }
    if (doorCells.length > 0) doors.push({ id: op.id, kind: op.kind, cells: doorCells, side });
  }
  const doorIdx = doors.flatMap((d) => d.cells.map(([x, y]) => g.index(x, y)));
  // the apron: from each door cell straight into the room
  const apron = new Set<number>();
  for (const d of doors) {
    const [dx, dy] = SIDE_STEP[OPPOSITE[d.side]];
    for (const [x, y] of d.cells)
      for (let k = 0; k < APRON; k++) {
        const i = g.index(x + dx * k, y + dy * k);
        if (!mine(i)) break;
        apron.add(i);
      }
  }
  const fromDoors = walk(g, doorIdx, mine);

  // focal point
  let focal: [number, number];
  let focalIdx: number[];
  if (focalFeature) {
    const f = focalFeature;
    focal = [f.at[0] + Math.floor((f.size[0] - 1) / 2), f.at[1] + Math.floor((f.size[1] - 1) / 2)];
    focalIdx = [];
    for (let dy = 0; dy < f.size[1]; dy++)
      for (let dx = 0; dx < f.size[0]; dx++) {
        const i = g.index(f.at[0] + dx, f.at[1] + dy);
        if (mine(i)) focalIdx.push(i);
      }
  } else if (doorIdx.length > 0) {
    let best = -1;
    let bestD = -1;
    for (const i of cells) {
      const d = fromDoors.get(i) ?? -1;
      if (d > bestD && passable(i)) {
        bestD = d;
        best = i;
      }
    }
    focal = best >= 0 ? xy(best) : [area.anchor[0], area.anchor[1]];
    focalIdx = best >= 0 ? [best] : [];
  } else {
    focal = [area.anchor[0], area.anchor[1]];
    focalIdx = [g.index(focal[0], focal[1])].filter(mine);
  }
  const fromFocal = walk(g, focalIdx, mine);

  // lanes: door to focal point, door to door
  const lane = new Set<number>();
  const traceTo = (sources: readonly number[], targets: readonly number[]): void => {
    const parent = walkPassable(g, sources, (i) => passable(i) || sources.includes(i));
    for (const t of targets) {
      let cur: number | undefined = t;
      if (!parent.has(t)) continue;
      while (cur !== undefined && cur >= 0) {
        lane.add(cur);
        const p = parent.get(cur);
        cur = p === -1 ? undefined : p;
      }
    }
  };
  // stairs and links into the room are ways in too: door → focal point → stair
  const ways = cells.filter((i) => ((L.cells.flags[i] ?? 0) & (CELL_FLAG.LINK | CELL_FLAG.STEPS)) !== 0);
  if (focalIdx.length > 0) traceTo(focalIdx, [...doorIdx, ...ways]);
  const firstDoors = doors.slice(0, LANE_DOORS);
  for (let i = 0; i < firstDoors.length; i++)
    for (let j = i + 1; j < firstDoors.length; j++) {
      const from = (firstDoors[i] as ZoneDoor).cells.map(([x, y]) => g.index(x, y));
      const to = (firstDoors[j] as ZoneDoor).cells.map(([x, y]) => g.index(x, y));
      traceTo(from, to);
    }
  // the focal feature's own cells are its, not the lane's
  for (const i of focalFeature ? focalIdx : []) lane.delete(i);

  // ends of a long room
  const bb = area.bbox;
  const long = Math.max(bb.w, bb.h) >= LONG_ROOM * Math.min(bb.w, bb.h) && Math.max(bb.w, bb.h) >= 5;
  const endDepth = Math.ceil(Math.max(bb.w, bb.h) / 5);

  for (const i of cells) {
    const [x, y] = xy(i);
    const d = band.get(i) ?? Infinity;
    let b = 0;
    if (d === 0) b |= ZONE.BAND1;
    if (d <= 1) b |= ZONE.BAND2;
    if (lane.has(i)) b |= ZONE.LANE;
    if (apron.has(i)) b |= ZONE.DOOR;
    if ((b & (ZONE.BAND2 | ZONE.LANE | ZONE.DOOR)) === 0) b |= ZONE.MIDDLE;
    if (long) {
      const along = bb.w >= bb.h ? x - bb.x : y - bb.y;
      const len = Math.max(bb.w, bb.h);
      if (along < endDepth || along >= len - endDepth) b |= ZONE.END;
    }
    bits[i] = b;
    const sd = 1 - (fromDoors.get(i) ?? Infinity) / DOOR_REACH;
    const sf = 1 - (fromFocal.get(i) ?? Infinity) / FOCAL_REACH;
    score[i] = Math.max(0, sd, sf);
  }
  const cx = cells.reduce((s, i) => s + xy(i)[0], 0) / cells.length + 0.5;
  const cy = cells.reduce((s, i) => s + xy(i)[1], 0) / cells.length + 0.5;
  return {
    focal,
    focalFeature: focalFeature?.id ?? null,
    doors,
    centroid: [cx, cy],
    natural: natural * 2 >= cells.length,
    longAxis: area.bbox.w >= area.bbox.h ? "x" : "y",
  };
}

/** Steps (4-neighbour) from the nearest source to every cell `ok` admits, sources at 0. */
function walk(g: LevelGrid, sources: readonly number[], ok: (i: number) => boolean): Map<number, number> {
  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (const s of sources)
    if (s >= 0 && !dist.has(s)) {
      dist.set(s, 0);
      frontier.push(s);
    }
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % g.w;
      const y = Math.floor(i / g.w);
      for (const [dx, dy] of NEIGHBOURS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const j = ny * g.w + nx;
        if (dist.has(j) || !ok(j)) continue;
        dist.set(j, d);
        next.push(j);
      }
    }
    frontier = next;
  }
  return dist;
}

/** Breadth-first parents (source: -1) over the cells `ok` admits, for tracing shortest paths back to the sources. */
function walkPassable(
  g: LevelGrid,
  sources: readonly number[],
  ok: (i: number) => boolean,
): Map<number, number> {
  const parent = new Map<number, number>();
  let frontier: number[] = [];
  for (const s of sources)
    if (s >= 0 && !parent.has(s)) {
      parent.set(s, -1);
      frontier.push(s);
    }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % g.w;
      const y = Math.floor(i / g.w);
      for (const [dx, dy] of NEIGHBOURS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const j = ny * g.w + nx;
        if (parent.has(j) || !ok(j)) continue;
        parent.set(j, i);
        next.push(j);
      }
    }
    frontier = next;
  }
  return parent;
}
