/**
 * Layout notes (generator 5): how a complex of rooms is laid out, measured on the resolved map (review/layout.ts).
 * Advisory and low-weighted: the thresholds are one dungeon's examples, set looser (REVIEW.layout). Each note names an
 * option, never the one right layout: a long corridor, rooms of one size or a single gate may be the plan's intent.
 *
 *   dead_end_empty   more than one room with one way on and nothing in it        (switch deadEndReview; Q4)
 *   rooms_same_size  a complex whose largest room is under 1.6 x its median       (switch roomSizeReview; Q2)
 *   corridor_heavy   corridors over 30 % of a complex's floor                     (switch corridorShareReview; Q1)
 *   entrances_few    12 rooms or more with one way in                             (switch entrancesReview; Q5)
 *   drop_trap_dead   an area reached by a one-way drop with no walk back           (switch wayBackReview; Q6)
 *   hall_unbroken    a room of hall size with no column, height change or water,
 *                    that the generator does not lay out as a hall                (switch grandHalls; Q12)
 */
import type { MapPlan, Vec2 } from "../contracts/plan";
import { CELL_FLAG, type ResolvedPlan } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";
import { HALL_SIZE, hallPlanOf } from "../gen/roomTraits";
import { generatorProfile } from "../plan/generator";
import { floorCells } from "../resolve";
import { emptyDeadEnds, mapLayout, type LevelLayout } from "./layout";
import { noteAction } from "./noteActions";
import type { DesignNote } from "./review";
import { REVIEW, capped } from "./thresholds";

const T = REVIEW.layout;
const rank = (weight: number, n: number): number => weight * capped(0.8 + n / 3);
const listed = (xs: readonly string[], most = 6): string =>
  xs.slice(0, most).join(", ") + (xs.length > most ? ` and ${String(xs.length - most)} more` : "");

/**
 * Rooms of hall size (gen/roomTraits.ts HALL_SIZE) with nothing to break them: no column (a feature that carries a
 * hall), one floor height, no water, and not laid out as a hall by the generator (hallPlanOf: a great hall, a throne
 * room, a nave of that size get their columns, or keep their axis on purpose when the plain option is drawn).
 */
function unbrokenHalls(
  resolved: ResolvedPlan,
): Array<{ levelId: string; id: string; name: string; cells: number; cell: Vec2 }> {
  const out: Array<{ levelId: string; id: string; name: string; cells: number; cell: Vec2 }> = [];
  for (const L of resolved.levels) {
    const floors = floorCells(L);
    L.areas.forEach((a, ai) => {
      if (a.kind !== "room" || a.building !== undefined) return;
      const cells = floors.get(ai) ?? [];
      const across = Math.min(a.bbox.w, a.bbox.h);
      if (cells.length < HALL_SIZE.minCells || across < HALL_SIZE.minWidth) return;
      if (hallPlanOf(a.roomKind ?? a.purpose, cells.length, across) !== undefined) return;
      if (L.features.some((f) => f.area === a.id && featureInfo(f.type).carriesHall === true)) return;
      if (new Set(cells.map((i) => L.cells.height[i])).size > 1) return;
      for (let i = 0; i < L.cells.area.length; i++)
        if (L.cells.area[i] === ai + 1 && ((L.cells.flags[i] as number) & CELL_FLAG.WATER) !== 0) return;
      out.push({ levelId: L.id, id: a.id, name: a.name ?? a.id, cells: cells.length, cell: a.anchor });
    });
  }
  return out;
}

export function layoutNotes(plan: MapPlan, resolved: ResolvedPlan): DesignNote[] {
  const gen = generatorProfile(plan);
  if (
    !gen.deadEndReview &&
    !gen.roomSizeReview &&
    !gen.corridorShareReview &&
    !gen.entrancesReview &&
    !gen.wayBackReview &&
    !gen.grandHalls
  )
    return [];
  const m = mapLayout(resolved, plan.entryLevel);
  const out: DesignNote[] = [];

  const empty = emptyDeadEnds(m);
  const first = empty[0];
  if (gen.deadEndReview && first && empty.length > T.emptyDeadEnds)
    out.push({
      code: "dead_end_empty",
      levelId: first.levelId,
      score: rank(T.weights.deadEnd, empty.length - T.emptyDeadEnds),
      cell: first.cell,
      elementIds: empty.slice(0, 6).map((r) => r.id),
      message: `${empty.length} rooms are dead ends with nothing in them: ${listed(empty.map((r) => `${r.name} (${r.id})`))}`,
      action: noteAction("dead_end_empty"),
    });

  const judged = (pick: (l: LevelLayout) => boolean): LevelLayout | undefined => m.levels.find(pick);

  const alike = judged((l) => l.rooms.length >= T.sizeRooms && l.sizeRatio < T.sizeRatio);
  if (gen.roomSizeReview && alike)
    out.push({
      code: "rooms_same_size",
      levelId: alike.levelId,
      score: T.weights.sizeMix,
      cell: (alike.rooms[0] as LevelLayout["rooms"][number]).cell,
      elementIds: alike.rooms.slice(0, 6).map((r) => r.id),
      message: `the ${alike.rooms.length} rooms of ${alike.levelId} are all near one size (the largest is ${alike.sizeRatio.toFixed(1)} times the median)`,
      action: noteAction("rooms_same_size"),
    });

  const heavy = judged((l) => l.corridorShare > T.corridorShare);
  if (gen.corridorShareReview && heavy)
    out.push({
      code: "corridor_heavy",
      levelId: heavy.levelId,
      score: T.weights.corridor,
      cell: (heavy.rooms[0] as LevelLayout["rooms"][number]).cell,
      elementIds: [],
      message: `corridors take ${Math.round(heavy.corridorShare * 100)} % of the floor of ${heavy.levelId}`,
      action: noteAction("corridor_heavy"),
    });

  if (gen.entrancesReview && m.rooms >= T.entrancesRooms && m.entrances <= T.entrances) {
    const at = m.levels[0]?.rooms[0];
    out.push({
      code: "entrances_few",
      levelId: at?.levelId ?? resolved.levels[0]?.id ?? "",
      score: T.weights.entrances,
      ...(at ? { cell: at.cell } : {}),
      elementIds: [],
      message: `${m.rooms} rooms have one way in`,
      action: noteAction("entrances_few"),
    });
  }

  const hall = gen.grandHalls ? unbrokenHalls(resolved)[0] : undefined;
  if (hall)
    out.push({
      code: "hall_unbroken",
      levelId: hall.levelId,
      score: T.weights.hall,
      cell: hall.cell,
      elementIds: [hall.id],
      message: `${hall.name} (${hall.id}) is a big open hall, ${hall.cells} tiles, with nothing to break it (no column, no change of floor height, no water)`,
      action: noteAction("hall_unbroken"),
    });

  const dead = m.noWayBack[0];
  if (gen.wayBackReview && dead)
    out.push({
      code: "drop_trap_dead",
      levelId: dead.levelId,
      score: rank(T.weights.wayBack, m.noWayBack.length),
      cell: dead.cell,
      elementIds: m.noWayBack.slice(0, 6).map((a) => a.id),
      message: `${listed(m.noWayBack.map((a) => `${a.name} (${a.id})`))} can be dropped into but has no way back out`,
      action: noteAction("drop_trap_dead"),
    });
  return out;
}
