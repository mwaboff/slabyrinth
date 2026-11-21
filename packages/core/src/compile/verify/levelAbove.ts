/**
 * Anything rising through the floor of the level above: a piece (not a link) of a level whose top passes the elevation
 * of the next level up, under a floor cell of that level.
 *
 * Emits `verify_pokes_into_level_above` (warning), one per level, lowest level first.
 */
import { BUILD_CONSTANTS } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import type { VerifyCtx } from "./context";
import type { Solid, SolidIndex } from "./grid";
import { POKE_TOLERANCE } from "./limits";
import { elementRef, round2, solidLabel, uniq } from "./words";

/** A storey needs walls, a floor and a tile of air above the walls. */
const STOREY_NEEDS = BUILD_CONSTANTS.wallHeight + BUILD_CONSTANTS.floorThickness + 1;

export function checkLevelAbove(ctx: VerifyCtx, solids: SolidIndex): void {
  const byElev = [...ctx.levels].sort((a, b) => a.elevation - b.elevation);
  byElev.forEach((L, i) => {
    const U = byElev[i + 1];
    const gu = U ? ctx.grids.get(U.id) : undefined;
    if (!U || !gu) return;
    const hits: Solid[] = [];
    for (const s of solids.all) {
      if (s.levelId !== L.id || s.role === "link" || s.box.max.y <= U.elevation + POKE_TOLERANCE) continue;
      const pc = solids.toPlan((s.box.min.x + s.box.max.x) / 2, (s.box.min.z + s.box.max.z) / 2);
      if (gu.cell(Math.floor(pc.px), Math.floor(pc.py)).floor) hits.push(s);
    }
    if (!hits.length) return;
    ctx.report.add({
      severity: "warning",
      code: "verify_pokes_into_level_above",
      levelId: L.id,
      count: hits.length,
      assets: uniq(hits.map((s) => s.name)).slice(0, 5),
      ...elementRef(hits[0]?.p.source.elementId),
      message: `${hits.length} piece${hits.length > 1 ? "s" : ""} on level ${L.id} rise through the floor of level ${U.id} (e.g. ${solidLabel(hits[0] as Solid)}).`,
      hint: pokeHint(L, U, hits),
    });
  });
}

/** How far the tallest pieces poke through, by element (the three worst), and the two ways out. */
function pokeHint(L: ResolvedLevel, U: ResolvedLevel, hits: readonly Solid[]): string {
  const gap = U.elevation - L.elevation;
  const top = Math.max(...hits.map((s) => s.box.max.y));
  const poke = round2(top - U.elevation);
  const by = new Map<string, { n: number; h: number }>();
  for (const s of hits) {
    const k = s.p.source.elementId?.split(".")[0]?.split("#")[0] || s.name;
    const e = by.get(k) ?? { n: 0, h: 0 };
    e.n++;
    e.h = Math.max(e.h, s.box.max.y - U.elevation);
    by.set(k, e);
  }
  const worst = [...by.entries()]
    .sort((a, b) => b[1].h - a[1].h)
    .slice(0, 3)
    .map(([k, e]) => `${k} (${e.n} piece${e.n > 1 ? "s" : ""}, up to ${round2(e.h)} through)`)
    .join(", ");
  return `The tallest piece reaches ${round2(top - L.elevation)} above level ${L.id}'s base, ${poke} past the underside of ${U.id}'s floor (${U.id} is only ${round2(gap)} above ${L.id}): ${worst}. Choices: raise ${U.id} by at least ${round2(poke)} (a storey of walls needs ${round2(STOREY_NEEDS)} or more: 2-tall walls, 0.5 floor, 1 of air), or, if it is a platform or feature (not the walls), lower that element or move it out from under ${U.id}'s floor.`;
}
