/**
 * Dead ends that pay (generator 5, switch `deadEndVignettes`; build plan §11.3 Q4, technique `dead-ends-pay`), with the
 * features (step 9), after the rooms are dressed: a room of the complex with one way on and nothing in it gets a small
 * set drawn for it (a cache, a dead explorer and his loot, stores, a figure: gen/complexLayout.ts DEAD_END_OPTIONS).
 * "One way on" and "nothing in it" are the review's own question (resolve/layoutRooms.ts layoutRooms, the walk the
 * `dead_end_empty` note reads), asked of the level as it stands now. The plain option leaves a room bare; it is drawn
 * only while the map's bare dead ends stay within the allowance the review grants (COMPLEX.emptyDeadEnds), counted
 * over the levels in plan order, on levels with enough rooms to be judged.
 * Reads: the level's areas, cells, edges and openings, the features so far, each room's class and character.
 * Writes: the sets' features (FeatureWork) and the map's count of bare dead ends (LevelContext.complex).
 */
import type { ResolvedOpening } from "../../contracts/resolved";
import { COMPLEX, DEAD_END_MIN_CELLS, DEAD_END_OPTIONS, drawDeadEnd } from "../../gen/complexLayout";
import { PLAN_LIMITS } from "../../contracts/plan";
import { dressDeadEnd } from "../../gen/rooms4";
import { showsDecay } from "../../gen/roomTraits";
import { elementSeed, hashUnit, subSeed } from "../../util/hash";
import { characterAt } from "../character";
import { emptyDeadEndsOf, gridLayoutLevel, holdsSomething, layoutRooms } from "../layoutRooms";
import type { FeatureWork } from "./features";
import type { ReadOnly, ResolveGrid } from "./grid";

export function stepDeadEnds(
  work: ResolveGrid,
  features: FeatureWork,
  openings: ReadOnly<ResolvedOpening[]>,
): void {
  if (!work.profile.deadEndVignettes || work.level.roomDress === false) return;
  const { level, water } = gridLayoutLevel(work, openings as readonly ResolvedOpening[]);
  const areas = work.areas.map((a) => ({
    id: a.area.id,
    name: a.area.name,
    kind: a.kind,
    building: a.building,
    purpose: a.room.purpose,
  }));
  const rooms = layoutRooms(level, areas, features.all, water);
  // a level with fewer rooms is not judged as a complex: a bare dead end there takes nothing from the allowance
  const judged = rooms.length >= COMPLEX.minRooms;
  const complex = work.ctx.complex ?? { plainDeadEnds: 0 };
  const grid = features.placementGrid();
  for (const r of emptyDeadEndsOf(rooms)) {
    const ai = work.areaIndexById.get(r.id);
    const info = ai === undefined ? undefined : work.areas[ai];
    if (info === undefined || r.floor < DEAD_END_MIN_CELLS) continue;
    const seed = elementSeed(work.plan.seed, `${work.level.id}~${r.id}~deadend`, undefined);
    const condition = characterAt(work, r.id)?.condition;
    const abandoned = info.room.abandoned || condition === "ruined" || condition === "ramshackle";
    const plainAllowed = !judged || complex.plainDeadEnds < COMPLEX.emptyDeadEnds;
    // generator 5 (decayWhereItBelongs): remains only in a room that shows decay (gen/roomTraits.ts showsDecay)
    const decay =
      !work.profile.decayWhereItBelongs ||
      showsDecay({
        room: info.kind === "room",
        purpose: info.room.purpose,
        kind: info.room.kind ?? info.room.purpose,
        abandoned: info.room.abandoned,
        condition,
      });
    const option = drawDeadEnd(hashUnit(seed, "option", 0), abandoned, plainAllowed, decay);
    const cells = work
      .shownCells(info.index)
      .filter((i) => work.isFloor(i))
      .map((i) => work.cellXY(i));
    // the drawn set, else (its anchor fits nowhere: a room too narrow for a chest's standing room) the others in order
    const tries =
      option.group === null
        ? []
        : [option, ...DEAD_END_OPTIONS.filter((o) => o !== option && o.group && (decay || o.decay !== true))];
    let capped = false;
    for (const o of tries) {
      const res = dressDeadEnd(grid, {
        option: o,
        areaIndex: info.index + 1,
        areaCells: cells,
        seed: subSeed(seed, "set"),
        remaining: PLAN_LIMITS.generatedFeaturesPerLevel - features.generated,
      });
      if (res === null || res.placements.length === 0) continue;
      features.commitGenerated(`${r.id}~deadend`, res.placements);
      if (res.keptClear) features.keepClearOf(res.keptClear);
      capped = res.capped;
      if (holdsSomething(features.all, r.id) || capped) break;
    }
    // plain, or nothing of any set fits: the room stays bare and counts against the allowance
    if (judged && !holdsSomething(features.all, r.id)) complex.plainDeadEnds++;
    if (capped) break;
  }
}
