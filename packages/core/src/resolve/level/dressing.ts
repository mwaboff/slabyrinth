/**
 * Step 9 of a level: the generated features of the plan's dress and scatter ops, after the rock band every natural
 * open-air cliff gets by default. The placement itself is gen/place.ts and gen/setpieces.ts; this module picks the
 * regions, calls them and commits what they place.
 * Reads: the level's dress and scatter ops, its areas and open ground, the placement grid (FeatureWork.placementGrid).
 * Writes: generated features through FeatureWork, plan issues for ops that placed nothing or hit the level's cap.
 */
import type { TerrainOp } from "../../contracts/plan";
import { PLAN_LIMITS } from "../../contracts/plan";
import { CELL } from "../../contracts/resolved";
import { featureInfo } from "../../gen/catalog";
import { forEachMaskCell } from "../../gen/mask";
import {
  type AvoidKind,
  type GeneratedPlacement,
  type PlacementGrid,
  dressArea,
  scatterFeatures,
} from "../../gen/place";
import { defaultCliffBands } from "../../gen/setpieces";
import { rasterizeShape } from "../../gen/shapes";
import { elementSeed, subSeed } from "../../util/hash";
import { isNaturalGround } from "../materials";
import type { FeatureWork } from "./features";
import type { AreaInfo, ResolveGrid } from "./grid";

/** A dress op over the whole level: the open ground (no area) and each zone area, each dressed as one region. */
function dressWholeLevel(
  work: ResolveGrid,
  features: FeatureWork,
  op: Extract<TerrainOp, { op: "dress" }>,
  path: string,
  grid: PlacementGrid,
  cap: number,
  capWarn: (id: string, path: string) => void,
): void {
  const regions: Array<{ index: number; cells: Array<[number, number]> }> = [];
  const byIndex = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < work.n; i++) {
    if (work.state[i] !== CELL.OPEN) continue;
    const d = work.disp[i] as number;
    const a = d > 0 ? work.areas[d - 1] : undefined;
    if (d > 0 && a?.kind !== "zone") continue;
    const list = byIndex.get(d) ?? [];
    list.push(work.cellXY(i));
    byIndex.set(d, list);
  }
  for (const [index, cells] of [...byIndex.entries()].sort((p, q) => p[0] - q[0]))
    regions.push({ index, cells });
  let placed = 0;
  for (const r of regions) {
    const res = dressArea(grid, {
      preset: op.preset,
      areaIndex: r.index,
      areaCells: r.cells,
      density: op.density ?? 0.5,
      seed: subSeed(elementSeed(work.plan.seed, op.id, op.seed), `region${r.index}`),
      remaining: cap - features.generated,
    });
    features.commitGenerated(op.id, res.placements);
    placed += res.placements.length;
    if (res.capped) {
      capWarn(op.id, path);
      break;
    }
  }
  if (placed === 0)
    work.issue("warning", "no_effect", `dress "${op.id}" placed nothing on level "${work.level.id}"`, {
      path,
      elementId: op.id,
      hint: "the level has no free open ground; raise density or dress a named area",
    });
}

export function stepGeneratedFeatures(work: ResolveGrid, features: FeatureWork): void {
  const grid = features.placementGrid();
  const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
  const ops = work.level.terrain.map((op, k) => ({ op, k }));
  const capWarn = (id: string, path: string): void => {
    work.issue(
      "warning",
      "limit_exceeded",
      `"${id}" hit the ${cap} generated-feature cap for this level; the rest were dropped`,
      {
        path,
        elementId: id,
        hint: "lower density or narrow the shape",
      },
    );
  };
  // generator 3: the rock band of every natural cliff is laid first, over the whole level, so no zone's dressing
  // blocks a face that crosses into the next zone (the presets then only grow what follows the rock)
  stepDefaultCliffBands(work, features, grid, cap);
  for (const { op, k } of ops) {
    if (op.op !== "dress") continue;
    const path = `/levels/${work.li}/terrain/${k}`;
    if (op.area === undefined || op.area === work.level.id) {
      // generator 2: the whole level, region by region (the open ground outside areas, then each zone)
      if (work.profile.dressWholeLevel) dressWholeLevel(work, features, op, path, grid, cap, capWarn);
      continue;
    }
    const ai = work.areaIndexById.get(op.area);
    if (ai === undefined) {
      work.issue("error", "ref_unknown", `dress "${op.id}" names unknown area "${op.area}"`, {
        path: `${path}/area`,
        elementId: op.id,
        hint: `areas on ${work.level.id}: ${work.level.areas.map((a) => a.id).join(", ")}`,
      });
      continue;
    }
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < work.n; i++) if (work.disp[i] === ai + 1) cells.push(work.cellXY(i));
    const res = dressArea(grid, {
      preset: op.preset,
      areaIndex: ai + 1,
      areaCells: cells,
      density: op.density ?? 0.5,
      seed: elementSeed(work.plan.seed, op.id, op.seed),
      remaining: cap - features.generated,
      abandoned: (work.areas[ai] as AreaInfo).room.abandoned,
    });
    features.commitGenerated(op.id, res.placements);
    if (res.capped) capWarn(op.id, path);
    if (res.placements.length === 0 && !res.capped)
      work.issue("warning", "no_effect", `dress "${op.id}" placed nothing in "${op.area}"`, {
        path,
        elementId: op.id,
        hint: "the area has no free floor (too small, or full of features, links and water); dress a larger area or raise density",
      });
  }
  for (const { op, k } of ops) {
    if (op.op !== "scatter") continue;
    const path = `/levels/${work.li}/terrain/${k}`;
    const region = op.shape
      ? work.shapeCells(op.shape, "scatter", `${path}/shape`, op.id)
      : Array.from({ length: work.n }, (_, i) => i);
    const excluded = new Set<number>();
    (op.exclude ?? []).forEach((s) => {
      forEachMaskCell(rasterizeShape(s, { planSeed: work.plan.seed, clip: work.rasterClip() }), (x, y) => {
        const i = work.idx(x, y);
        if (i >= 0) excluded.add(i);
      });
    });
    const info = featureInfo(op.feature);
    const params = {
      feature: op.feature,
      candidates: region.filter((i) => !excluded.has(i)).map((i) => work.cellXY(i)),
      density: op.density,
      minSpacing: op.minSpacing ?? 1,
      avoid: new Set<AvoidKind>(op.avoid ?? ["water", "walls", "features", "links"]),
      randomRotation: op.randomRotation ?? info.organic,
      seed: elementSeed(work.plan.seed, op.id, op.seed),
      remaining: cap - features.generated,
      // generator 2: natural pieces scatter in drifts and clumps, never an even lattice
      drift: work.profile.naturalScatter && info.organic,
      supported: work.profile.naturalScatter,
    };
    const res = scatterFeatures(grid, op.variants ? { ...params, variants: op.variants } : params);
    features.commitGenerated(op.id, res.placements);
    if (res.capped) capWarn(op.id, path);
    if (res.placements.length === 0 && !res.capped && op.density > 0)
      work.issue("warning", "no_effect", `scatter "${op.id}" placed no ${op.feature}`, {
        path,
        elementId: op.id,
        hint:
          params.candidates.length === 0
            ? "its shape (minus exclude) has no cell inside the level"
            : "no candidate cell was free floor: widen the shape, shrink exclude, lower minSpacing or drop entries from avoid",
      });
  }
}

/**
 * Generator 3: every natural open-air region gets its rock band, however it is dressed: every drop of a tile or more
 * between natural ground, and the board's own edge where the ground stands above the base (gen/setpieces
 * `defaultCliffBands`; nothing where the theme has no formation roles). `cliffBands: false` on the level turns it off.
 */
function stepDefaultCliffBands(
  work: ResolveGrid,
  features: FeatureWork,
  grid: PlacementGrid,
  cap: number,
): void {
  if (!work.profile.defaultCliffBands || work.level.cliffBands === false) return;
  const base = work.level.base;
  if (base.type !== "ground" || !isNaturalGround(base.material)) return;
  if ((work.level.structures ?? []).some((st) => st.kind !== "enclosure")) return;
  const byIndex = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < work.n; i++) {
    if (work.state[i] !== CELL.OPEN) continue;
    const d = work.disp[i] as number;
    const a = d > 0 ? work.areas[d - 1] : undefined;
    if (d > 0 && a?.kind !== "zone") continue;
    const list = byIndex.get(d) ?? [];
    list.push(work.cellXY(i));
    byIndex.set(d, list);
  }
  // every region is planned before any piece is committed: rocks of neighbouring zones overlap on purpose, and a
  // committed piece would read as a feature in the way of the next zone's band
  const planned: Array<{ id: string; placements: GeneratedPlacement[] }> = [];
  let room = cap - features.generated;
  for (const [index, cells] of [...byIndex.entries()].sort((p, q) => p[0] - q[0])) {
    const res = defaultCliffBands(grid, {
      areaIndex: index,
      areaCells: cells,
      seed: elementSeed(work.plan.seed, `${work.level.id}~cliffbands~${index}`),
      remaining: room,
    });
    planned.push({ id: `${work.level.id}~bands${index}`, placements: res.placements });
    room -= res.placements.length;
    if (res.capped || room <= 0) break;
  }
  for (const r of planned) features.commitGenerated(r.id, r.placements);
}
