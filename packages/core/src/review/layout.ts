/**
 * How a complex of rooms is laid out (generator 5, build plan §11.3, technique catalogue Part 4 Q1, Q2, Q4, Q5, Q6):
 * measured on the resolved map only, for the quality meter (review/qualityMap.ts) and the advisory layout notes
 * (review/layoutNotes.ts). One walk per question, all through the resolver's walking graph (resolve/playability.ts
 * WalkGraph), so a step, a door, a stair or a one-way drop counts here exactly as playability counts it.
 *
 *   corridor share   corridor floor / room and corridor floor, on a level with `minRooms` rooms or more
 *   size ratio       the largest room's floor / the median room's floor, on such a level
 *   dead ends        rooms with exactly one way on (one neighbouring area or link), and whether anything stands in them
 *                    (a feature that is not a light and not strewn litter: furniture, a chest, a trap, remains)
 *   entrances        ways into the map from outside it: openings to "@outside", at least the entry area itself
 *   no way back      areas the party reaches from the entry but from which no walk leads back to it (the low side of a
 *                    one-way drop, a trapdoor or a pit, with no stair or door of its own back up)
 */
import type { Vec2 } from "../contracts/plan";
import {
  CELL,
  CELL_FLAG,
  type ResolvedArea,
  type ResolvedLevel,
  type ResolvedPlan,
} from "../contracts/resolved";
import { LIGHT_FEATURES, featureInfo } from "../gen/catalog";
import { SIDES } from "../gen/gridGeometry";
import { entryLevelId, linkKindInfo } from "../plan/links";
import { WalkGraph } from "../resolve";
import { maxOf } from "../util/lists";
import { REVIEW } from "./thresholds";

/** One room of a level: its floor, its ways on, and whether it holds something. */
export interface LayoutRoom {
  readonly levelId: string;
  readonly id: string;
  readonly name: string;
  readonly floor: number;
  /** Distinct neighbouring areas a step leads into, plus one for a link (stairs, ladder, drop) in the room. */
  readonly ways: number;
  /** A feature stands in it that is neither a light nor strewn litter. */
  readonly holds: boolean;
  readonly cell: Vec2;
}

export interface LevelLayout {
  readonly levelId: string;
  readonly rooms: readonly LayoutRoom[];
  /** Corridor floor / (room + corridor floor). */
  readonly corridorShare: number;
  /** Largest room floor / median room floor. */
  readonly sizeRatio: number;
}

export interface MapLayout {
  /** Levels with enough rooms to be judged as a complex (REVIEW.layout.minRooms). */
  readonly levels: readonly LevelLayout[];
  /** Rooms on every level (judged or not). */
  readonly rooms: number;
  /** Ways in from outside the map (at least 1: the entry). */
  readonly entrances: number;
  /** Areas reached from the entry with no walk back to it. */
  readonly noWayBack: ReadonlyArray<{ levelId: string; id: string; name: string; cell: Vec2 }>;
}

const T = REVIEW.layout;

/** The walkable floor cells of each area of a level (local indices), by area index. */
function floorOf(L: ResolvedLevel): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < L.cells.area.length; i++) {
    const a = L.cells.area[i] as number;
    if (a === 0 || L.cells.state[i] !== CELL.OPEN) continue;
    if (((L.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) !== 0) continue;
    const list = out.get(a - 1) ?? [];
    list.push(i);
    out.set(a - 1, list);
  }
  return out;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

const isRoom = (a: ResolvedArea): boolean => a.kind === "room";

/** The layout measures of a whole map. */
export function mapLayout(resolved: ResolvedPlan, entryLevel?: string): MapLayout {
  const g = new WalkGraph(resolved);
  const mode = { secret: true, ignoreFeatures: true } as const;
  const levels: LevelLayout[] = [];
  let roomCount = 0;
  for (const L of resolved.levels) {
    const d = g.byId.get(L.id);
    if (!d) continue;
    const floors = floorOf(L);
    const W = L.bounds.w;
    const xy = (i: number): Vec2 => [L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)];
    const rooms: LayoutRoom[] = [];
    let roomFloor = 0;
    let corridorFloor = 0;
    L.areas.forEach((a, ai) => {
      const cells = floors.get(ai) ?? [];
      if (a.kind === "corridor") corridorFloor += cells.length;
      if (!isRoom(a) || cells.length === 0) return;
      roomFloor += cells.length;
      const next = new Set<number>();
      let link = false;
      for (const i of cells) {
        if (((L.cells.flags[i] as number) & (CELL_FLAG.LINK | CELL_FLAG.STEPS)) !== 0) link = true;
        for (const s of SIDES) {
          const [j, pass] = g.step(d, i, s, mode);
          if (!pass || j < 0 || !g.walkable(d, j, mode)) continue;
          const b = L.cells.area[j] as number;
          if (b !== ai + 1) next.add(b);
        }
      }
      const holds = L.features.some(
        (f) => f.area === a.id && !LIGHT_FEATURES.has(f.type) && featureInfo(f.type).strewn !== true,
      );
      rooms.push({
        levelId: L.id,
        id: a.id,
        name: a.name ?? a.id,
        floor: cells.length,
        ways: next.size + (link ? 1 : 0),
        holds,
        cell: xy(cells[0] as number),
      });
    });
    roomCount += rooms.length;
    if (rooms.length < T.minRooms) continue;
    const sizes = rooms.map((r) => r.floor);
    levels.push({
      levelId: L.id,
      rooms,
      corridorShare: corridorFloor / Math.max(1, corridorFloor + roomFloor),
      sizeRatio: maxOf(sizes) / Math.max(1, median(sizes)),
    });
  }

  // ways in from outside: openings with no area on one side; the entry itself is one
  const outside = resolved.levels.reduce(
    (n, L) => n + L.openings.filter((o) => o.sides[0] === null || o.sides[1] === null).length,
    0,
  );

  // no way back: from each reached area, does a walk lead back to an entry cell? Every move of the walk goes both ways
  // but a one-way link's (a trapdoor, a pit drop), so only a map with one can strand the party
  const noWayBack: Array<{ levelId: string; id: string; name: string; cell: Vec2 }> = [];
  const oneWay = resolved.links.some((l) => !linkKindInfo(l.kind).climbsUp || linkKindInfo(l.kind).hatch);
  const starts = oneWay ? g.starts(entryLevelId({ entryLevel, levels: resolved.levels })) : [];
  const startSet = new Set(starts.map(([li, i]) => `${li}:${i}`));
  const reached = oneWay ? g.flood(starts, mode) : [];
  if (starts.length > 0)
    for (const L of resolved.levels) {
      const d = g.byId.get(L.id);
      if (!d) continue;
      const r = reached[d.li];
      const floors = floorOf(L);
      L.areas.forEach((a, ai) => {
        if (a.kind === "zone") return;
        const cells = (floors.get(ai) ?? []).filter((i) => r?.[i] === 1);
        if (cells.length < T.minTrapCells) return;
        const back = g.flood([[d.li, cells[0] as number]], mode);
        const home = [...startSet].some((k) => {
          const [li, i] = k.split(":").map(Number) as [number, number];
          return back[li]?.[i] === 1;
        });
        if (!home)
          noWayBack.push({
            levelId: L.id,
            id: a.id,
            name: a.name ?? a.id,
            cell: [
              L.bounds.x + ((cells[0] as number) % L.bounds.w),
              L.bounds.y + Math.floor((cells[0] as number) / L.bounds.w),
            ],
          });
      });
    }
  return { levels, rooms: roomCount, entrances: Math.max(1, outside), noWayBack };
}

/** Rooms with one way on that hold nothing, over the judged levels. */
export const emptyDeadEnds = (m: MapLayout): LayoutRoom[] =>
  m.levels.flatMap((l) => l.rooms.filter((r) => r.ways === 1 && !r.holds));
