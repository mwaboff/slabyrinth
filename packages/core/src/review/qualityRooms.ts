/**
 * The quality meter's room and layout rows (generator 5, build plan §3.3, §10.7, §11.7): rooms judged by their kind's
 * row of the room-kind table (gen/roomTraits.ts roomTargets), what the interiors and the layered ground do, and the
 * dungeon layout measures (review/layout.ts). Engineer-facing, like the rest of the meter (review/qualityMap.ts): the
 * review's notes give the model only what plan words change.
 *
 *   kind_near_wall      rooms whose blockers meet their kind's least near-wall share / rooms judged (≥ 4 blockers;
 *                       kinds that lay out floor groups or station rows are not judged)
 *   kind_clear_floor    rooms whose floor not under a blocker lies within their kind's clear share (± 0.1) / rooms
 *   kind_lit            lived-in rooms with at least their kind's least lights per 10 tiles (at least one light) / rooms
 *   kind_props          rooms with at least half their kind's least props per 10 tiles / rooms (abandoned: not judged)
 *   anchor_present      rooms of a furnished kind holding one of its anchors / those rooms
 *   surface_dressing    tables, counters and desks with a thing resting on them / those surfaces (abandoned rooms out)
 *   middle_bare         rooms of 30 floor tiles or more whose middle (floor two tiles or more from a wall) holds nothing
 *                       / those rooms with a middle of 6 cells or more (the owner's screenshots: bare middles)
 *   light_pitch_alike   rooms and corridors with 3 or more wall lights whose wall-light pitch (median nearest-neighbour
 *                       distance, to 0.5) is the map's most common pitch / those rooms, at 3 or more such rooms (the
 *                       owner's screenshots: one even torch pitch everywhere)
 *   ground_cover        open natural ground outside (not a room or corridor) under the layered ground's pieces / that
 *                       ground (4 samples per cell)
 *   corridor_share      corridor floor / room and corridor floor, over levels judged as a complex
 *   room_size_ratio     largest room / median room, the least over levels judged as a complex
 *   dead_ends_empty     rooms with one way on and nothing in them
 *   no_way_back         areas reached by a one-way drop with no walk back
 */
import type { PlacementSet } from "../contracts/compiler";
import type { Vec2 } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  type ResolvedArea,
  type ResolvedFeature,
  type ResolvedLevel,
  type ResolvedPlan,
} from "../contracts/resolved";
import { WorldFrame, placedBox } from "../compile/index";
import { LIGHT_FEATURES, featureInfo } from "../gen/catalog";
import { classifyRoom } from "../gen/roomPurpose";
import { roomTargets } from "../gen/roomTraits";
import { SURFACE_LOAD } from "../gen/surfaces";
import { LevelGrid } from "../resolve/levelGrid";
import { isNaturalGround } from "../resolve/materials";
import { resolvedRoomClass, roomStats, type RoomStat } from "./interiors";
import { emptyDeadEnds, mapLayout } from "./layout";
import { nearBoundary } from "./qualityMap";
import { maxOf, minOf } from "../util/lists";
import { REVIEW } from "./thresholds";

export const ROOM_METER = {
  /** Rooms judged for near-wall share need this many blockers (the review's adriftMin). */
  minBlockers: REVIEW.interiors.adriftMin,
  /** Slack round the kind's clear share. */
  clearSlack: 0.1,
  /** Share of the kind's least props per 10 tiles a room must hold. */
  propsShare: 0.5,
  /** A thing rests on a surface when its base is this far or more above the surface's. */
  restAbove: 0.2,
  /** Middle: floor at least two tiles from a wall; judged in rooms of `middleRoom` floor with `middleCells` of it. */
  middleRoom: 30,
  middleCells: 6,
  /** Wall-light pitch: rooms with this many wall lights; pitches rounded to `pitchStep`; judged at `pitchRooms`. */
  pitchLights: 3,
  pitchStep: 0.5,
  pitchRooms: 3,
} as const;

const M = ROOM_METER;

/** Surfaces a thing is set on (tables, counters, desks): supports with a load of their own family and no chance. */
const SURFACES: ReadonlySet<string> = new Set(
  Object.entries(SURFACE_LOAD)
    .filter(([, l]) => l.chance === undefined && l.family === undefined && l.stackVariant === undefined)
    .map(([t]) => t),
);

export interface RoomMeterValues {
  kind_near_wall: number | null;
  kind_clear_floor: number | null;
  kind_lit: number | null;
  kind_props: number | null;
  anchor_present: number | null;
  surface_dressing: number | null;
  middle_bare: number | null;
  light_pitch_alike: number | null;
  ground_cover: number | null;
  corridor_share: number | null;
  room_size_ratio: number | null;
  dead_ends_empty: number | null;
  no_way_back: number | null;
}

const share = (n: number, of: number): number | null => (of > 0 ? n / of : null);
const cellsOf = (f: ResolvedFeature): Vec2[] => {
  const out: Vec2[] = [];
  for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
    for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) out.push([x, y]);
  return out;
};
const key = (x: number, y: number): string => `${x},${y}`;

/** A resolved room's class with the kind its words name (the classifier the resolver uses). */
const withKind = (a: ResolvedArea) => {
  const kind = classifyRoom(a, { kinds: true }).kind;
  return { ...resolvedRoomClass(a), ...(kind !== undefined ? { kind } : {}) };
};

/** The rooms' by-kind rows over every level. */
function kindRows(
  rooms: readonly RoomStat[],
): Pick<
  RoomMeterValues,
  "kind_near_wall" | "kind_clear_floor" | "kind_lit" | "kind_props" | "anchor_present"
> {
  let near = 0;
  let nearOf = 0;
  let clear = 0;
  let lit = 0;
  let litOf = 0;
  let props = 0;
  let anchors = 0;
  let of = 0;
  for (const r of rooms) {
    if (r.kind === undefined || r.passage) continue;
    const t = roomTargets(r.kind);
    of++;
    if (r.anchor) anchors++;
    if (r.clear >= t.clear[0] - M.clearSlack && r.clear <= t.clear[1] + M.clearSlack) clear++;
    if (!t.floorGroups && !t.stationRows && r.blockers >= M.minBlockers) {
      nearOf++;
      if (r.nearWall >= t.nearWall[0] * r.blockers) near++;
    }
    if (!r.abandoned) {
      if ((r.props * 10) / r.floor >= M.propsShare * t.props10[0]) props++;
      // (generator 5: a room drawn dim or dark is judged by its own level, not its kind's lights per 10 tiles)
      if (t.lightsPer10[0] > 0 && !r.dim) {
        litOf++;
        if (r.lights >= 1 && (r.lights * 10) / r.floor >= Math.min(t.lightsPer10[0], 10 / r.floor)) lit++;
      }
    }
  }
  const lived = rooms.filter((r) => r.kind !== undefined && !r.passage && !r.abandoned).length;
  return {
    kind_near_wall: share(near, nearOf),
    kind_clear_floor: share(clear, of),
    kind_lit: share(lit, litOf),
    kind_props: share(props, lived),
    anchor_present: share(anchors, of),
  };
}

/** Surfaces with something resting on them, rooms not abandoned. */
function surfaceTally(L: ResolvedLevel, t: { n: number; of: number }): void {
  const abandoned = new Set(
    L.areas.filter((a) => a.abandoned === true || a.purpose === "ruin").map((a) => a.id),
  );
  for (const s of L.features) {
    if (!SURFACES.has(s.type) || s.area === undefined || abandoned.has(s.area)) continue;
    const area = L.areas.find((a) => a.id === s.area);
    if (area?.kind !== "room") continue;
    const mine = new Set(cellsOf(s).map(([x, y]) => key(x, y)));
    t.of++;
    if (
      L.features.some(
        (f) =>
          f !== s &&
          f.baseHeight >= s.baseHeight + M.restAbove &&
          cellsOf(f).some(([x, y]) => mine.has(key(x, y))),
      )
    )
      t.n++;
  }
}

/** Rooms of a level judged for a bare middle, and how many have one. */
function middleTally(L: ResolvedLevel, grid: LevelGrid, t: { n: number; of: number }): void {
  const W = L.bounds.w;
  const covered = new Set(
    L.features
      .filter((f) => !featureInfo(f.type).wallMounted && featureInfo(f.type).strewn !== true)
      .flatMap((f) => cellsOf(f).map(([x, y]) => key(x, y))),
  );
  L.areas.forEach((a, ai) => {
    if (a.kind !== "room") return;
    const cells: Vec2[] = [];
    for (let i = 0; i < L.cells.area.length; i++)
      if (
        L.cells.area[i] === ai + 1 &&
        L.cells.state[i] === CELL.OPEN &&
        ((L.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) === 0
      )
        cells.push([L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)]);
    if (cells.length < M.middleRoom) return;
    const middle = cells.filter(([x, y]) => !nearBoundary(grid, x, y));
    if (middle.length < M.middleCells) return;
    t.of++;
    if (!middle.some(([x, y]) => covered.has(key(x, y)))) t.n++;
  });
}

/** Each room's or corridor's wall-light pitch (median nearest-neighbour distance), for rooms with enough of them. */
function lightPitches(L: ResolvedLevel, out: number[], gives: (f: ResolvedFeature) => boolean): void {
  for (const a of L.areas) {
    if (a.kind !== "room" && a.kind !== "corridor") continue;
    const lights = L.features.filter((f) => f.area === a.id && gives(f) && featureInfo(f.type).wallMounted);
    if (lights.length < M.pitchLights) continue;
    const at = lights.map((f) => [f.at[0] + (f.offset?.[0] ?? 0), f.at[1] + (f.offset?.[1] ?? 0)] as const);
    const nn = at
      .map((p, i) => minOf(at.filter((_, j) => j !== i).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))
      .sort((p, q) => p - q);
    const med = nn[Math.floor(nn.length / 2)] as number;
    out.push(Math.round(med / M.pitchStep) * M.pitchStep);
  }
}

/** Open natural ground outside rooms and corridors, and how much of it the layered ground covers. */
function groundTally(
  L: ResolvedLevel,
  set: PlacementSet,
  frame: WorldFrame,
  t: { n: number; of: number },
): void {
  const ground = new Set((L.arrangements ?? []).filter((x) => x.recipe === "layeredGround").map((x) => x.id));
  const W = L.bounds.w;
  const open = new Set<string>();
  for (let i = 0; i < L.cells.area.length; i++) {
    const a = L.areas[(L.cells.area[i] as number) - 1];
    if (!a || a.kind === "room" || a.kind === "corridor" || L.cells.state[i] !== CELL.OPEN) continue;
    const f = L.cells.flags[i] as number;
    if (
      (f & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.STEPS | CELL_FLAG.LINK)) !==
      0
    )
      continue;
    const m = L.materials[(L.cells.material[i] as number) - 1];
    if (m === undefined || !isNaturalGround(m)) continue;
    open.add(key(L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)));
  }
  if (open.size === 0) return;
  const hit = new Set<string>();
  if (ground.size > 0)
    for (const p of set.levels.find((l) => l.levelId === L.id)?.placements ?? []) {
      if (!ground.has(p.source.elementId ?? "")) continue;
      const b = placedBox(set, p);
      const a = frame.point(b.min.x, b.min.z);
      const c = frame.point(b.max.x, b.max.z);
      const x0 = Math.min(a.x, c.x);
      const x1 = Math.max(a.x, c.x);
      const y0 = Math.min(a.z, c.z);
      const y1 = Math.max(a.z, c.z);
      for (let y = Math.floor(y0); y < y1; y++)
        for (let x = Math.floor(x0); x < x1; x++)
          for (const [sx, sy] of [
            [0.25, 0.25],
            [0.75, 0.25],
            [0.25, 0.75],
            [0.75, 0.75],
          ] as const) {
            const px = x + sx;
            const py = y + sy;
            if (px > x0 && px < x1 && py > y0 && py < y1 && open.has(key(x, y)))
              hit.add(`${x},${y},${sx},${sy}`);
          }
    }
  t.n += hit.size;
  t.of += open.size * 4;
}

/** The room and layout rows of the meter over a realized build. */
export function roomMeter(
  resolved: ResolvedPlan,
  set: PlacementSet,
  frame: WorldFrame,
  entryLevel?: string,
  gives: (f: ResolvedFeature) => boolean = (f) => LIGHT_FEATURES.has(f.type),
): RoomMeterValues {
  const rooms = resolved.levels.flatMap((L) => roomStats(L, withKind, gives));
  const surf = { n: 0, of: 0 };
  const mid = { n: 0, of: 0 };
  const cover = { n: 0, of: 0 };
  const pitches: number[] = [];
  for (const L of resolved.levels) {
    const grid = new LevelGrid(L);
    surfaceTally(L, surf);
    middleTally(L, grid, mid);
    lightPitches(L, pitches, gives);
    groundTally(L, set, frame, cover);
  }
  let pitchAlike: number | null = null;
  if (pitches.length >= M.pitchRooms) {
    const counts = new Map<number, number>();
    for (const p of pitches) counts.set(p, (counts.get(p) ?? 0) + 1);
    pitchAlike = maxOf([...counts.values()]) / pitches.length;
  }
  const layout = mapLayout(resolved, entryLevel);
  return {
    ...kindRows(rooms),
    surface_dressing: share(surf.n, surf.of),
    middle_bare: share(mid.n, mid.of),
    light_pitch_alike: pitchAlike,
    ground_cover: share(cover.n, cover.of),
    corridor_share: layout.levels.length > 0 ? maxOf(layout.levels.map((l) => l.corridorShare)) : null,
    room_size_ratio: layout.levels.length > 0 ? minOf(layout.levels.map((l) => l.sizeRatio)) : null,
    dead_ends_empty: layout.levels.length > 0 ? emptyDeadEnds(layout).length : null,
    no_way_back: layout.noWayBack.length,
  };
}
