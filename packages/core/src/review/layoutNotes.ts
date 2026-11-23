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
 */
import type { MapPlan } from "../contracts/plan";
import type { ResolvedPlan } from "../contracts/resolved";
import { generatorProfile } from "../plan/generator";
import { emptyDeadEnds, mapLayout, type LevelLayout } from "./layout";
import { noteAction } from "./noteActions";
import type { DesignNote } from "./review";
import { REVIEW, capped } from "./thresholds";

const T = REVIEW.layout;
const rank = (weight: number, n: number): number => weight * capped(0.8 + n / 3);
const listed = (xs: readonly string[], most = 6): string =>
  xs.slice(0, most).join(", ") + (xs.length > most ? ` and ${String(xs.length - most)} more` : "");

export function layoutNotes(plan: MapPlan, resolved: ResolvedPlan): DesignNote[] {
  const gen = generatorProfile(plan);
  if (
    !gen.deadEndReview &&
    !gen.roomSizeReview &&
    !gen.corridorShareReview &&
    !gen.entrancesReview &&
    !gen.wayBackReview
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
