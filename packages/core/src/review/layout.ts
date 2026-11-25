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
import type { ResolvedPlan } from "../contracts/resolved";
import { entryLevelId, linkKindInfo } from "../plan/links";
import { WalkGraph, emptyDeadEndsOf, floorCells, layoutRooms, type LayoutRoom } from "../resolve";
import { maxOf } from "../util/lists";
import { REVIEW } from "./thresholds";

export type { LayoutRoom } from "../resolve";

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

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** The layout measures of a whole map. */
export function mapLayout(resolved: ResolvedPlan, entryLevel?: string): MapLayout {
  const g = new WalkGraph(resolved);
  const mode = { secret: true, ignoreFeatures: true } as const;
  const levels: LevelLayout[] = [];
  let roomCount = 0;
  for (const L of resolved.levels) {
    const d = g.byId.get(L.id);
    if (!d) continue;
    const floors = floorCells(L);
    // the rooms and their ways on, as the resolver asked while it built the level (resolve/layoutRooms.ts)
    const rooms = layoutRooms(L, L.areas, L.features, { deep: d.deep, lava: d.lava }, floors);
    let corridorFloor = 0;
    L.areas.forEach((a, ai) => {
      if (a.kind === "corridor") corridorFloor += (floors.get(ai) ?? []).length;
    });
    const roomFloor = rooms.reduce((n, r) => n + r.floor, 0);
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
      const floors = floorCells(L);
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
  m.levels.flatMap((l) => emptyDeadEndsOf(l.rooms));
