/**
 * Roof gaps (generator 4): an intact building's roof must be whole. A chimney takes the one cell its stack stands in;
 * every other cell inside the roof outline needs a roof piece. The owner's village proof had a bare strip along the
 * ridge of every odd-span roof (the kit had no cap piece), running out of the chimney, with the deck or the wall
 * showing through; the review counts the cells that the realized pieces leave open, so the model hears of it.
 *
 * Measured on the realized pieces, from the review's shared build (review/reviewBuild.ts: the CLI's, or one realizer
 * run in the app, shared with the cave notes); a plan with no intact pitched building never asks for it. Ruined and
 * weathered buildings are exempt: their roofs are meant to be broken.
 */
import type { PaletteCatalog, PlacementSet } from "../contracts/compiler";
import type { MapPlan } from "../contracts/plan";
import type { ResolvedPlan, ResolvedStructure } from "../contracts/resolved";
import { footprintFromGeom } from "../palette/resolve";
import { generatorProfile } from "../plan/generator";
import { roofOwners } from "../resolve/roof";
import type { DesignNote } from "./review";
import type { ReviewBuild } from "./reviewBuild";
import { REVIEW } from "./thresholds";
import { maxOf, minOf } from "../util/lists";

/** Roof cells of a building that have no roof piece. `covered` is a set of "x,y" keys the realized pieces fill. */
export function uncoveredRoofCells(
  st: ResolvedStructure,
  covered: ReadonlySet<string>,
): Array<[number, number]> {
  const holes = new Set(st.chimneys.map((c) => `${c.at[0]},${c.at[1]}`));
  const out: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const o of roofOwners(st.volumes ?? [], holes, true)) {
    // the owner's outline is the roof's reach: scan the cells of the volumes' bounding box plus the wall ring
    const xs = (st.volumes ?? []).flatMap((v) => v.rects.map((r) => [r.x - 2, r.x + r.w + 2] as const));
    const ys = (st.volumes ?? []).flatMap((v) => v.rects.map((r) => [r.y - 2, r.y + r.h + 2] as const));
    const x0 = minOf(xs.map((p) => p[0]));
    const x1 = maxOf(xs.map((p) => p[1]));
    const y0 = minOf(ys.map((p) => p[0]));
    const y1 = maxOf(ys.map((p) => p[1]));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (o.surface(x, y) < 0) continue;
        const k = `${x},${y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!holes.has(k) && !covered.has(k)) out.push([x, y]);
      }
  }
  return out;
}

/** Plan cells covered by a building's roof pieces in a placement set. */
export function roofCoverOf(
  set: PlacementSet,
  levelId: string,
  buildingId: string,
  palettes: PaletteCatalog,
): Set<string> {
  const feet = new Map<string, [number, number]>();
  for (const p of Object.values(palettes.palettes))
    for (const r of Object.values(p.roles))
      for (const v of r.variants) {
        if (!feet.has(v.asset)) {
          const f = v.footprint ?? footprintFromGeom(v.geom);
          feet.set(v.asset, [f[0], f[1]]);
        }
      }
  const covered = new Set<string>();
  for (const lv of set.levels) {
    if (lv.levelId !== levelId) continue;
    for (const q of lv.placements) {
      const id = q.source.elementId ?? "";
      if (
        q.layer !== "roof" ||
        !id.startsWith(`${buildingId}~`) ||
        !/(roof|dormer)$/.test(id) ||
        /porch|attach/.test(id)
      )
        continue;
      if (!q.source.cell) continue;
      const f = feet.get(q.asset) ?? [1, 1];
      const turned = Math.round(q.rot / 90) % 2 !== 0;
      const [w, h] = turned ? [f[1], f[0]] : f;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) covered.add(`${q.source.cell[0] + dx},${q.source.cell[1] + dy}`);
    }
  }
  return covered;
}

/** `roof_gap` notes for the intact pitched-roof buildings of a generator 4 plan. */
export function roofGapNotes(
  plan: MapPlan,
  resolved: ResolvedPlan,
  build: ReviewBuild,
  palettes: PaletteCatalog,
): DesignNote[] {
  if (!generatorProfile(plan).closedRoofs) return [];
  const out: DesignNote[] = [];
  const intact = (st: ResolvedStructure): boolean =>
    st.kind !== "enclosure" && (st.condition ?? "intact") === "intact" && !!st.volumes?.length;
  if (!resolved.levels.some((L) => (L.structures ?? []).some(intact))) return [];
  const set = build.get();
  for (const L of resolved.levels)
    for (const st of L.structures ?? []) {
      if (!intact(st)) continue;
      const open = uncoveredRoofCells(st, roofCoverOf(set, L.id, st.id, palettes));
      if (open.length === 0) continue;
      const first = open[0] as [number, number];
      out.push({
        code: "roof_gap",
        levelId: L.id,
        score:
          REVIEW.roofGap.base + Math.min(REVIEW.roofGap.extraMax, open.length / REVIEW.roofGap.cellsPerPoint),
        elementIds: [st.id],
        cell: first,
        message: `the roof of ${st.id} has ${open.length} open cell${open.length === 1 ? "" : "s"} (first at (${first[0]},${first[1]})) that no roof piece covers, so the deck or the wall shows through; only a chimney stack may stand in a roof`,
        action:
          "use a roof kit that has its own ridge cap and slope pieces, an even span so the ridge is a pair of slopes, or a flat roof; keep the chimney on a gable end",
      });
    }
  return out;
}
