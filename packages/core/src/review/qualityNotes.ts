/**
 * Notes from the quality meter (generator 5, switch `qualityNotes`): the meter's findings the model can act on with plan
 * words. The meter itself (review/qualityMetrics.ts, qualitySlab.ts, qualityMap.ts) is engineer-facing; most of what it
 * measures is the generator's own craft (overlap, rest, off-axis dressing, bands), which no plan word changes, so it
 * never becomes a note.
 *
 *   lane_blocked     a room whose walking lane between its doors is blocked by features the plan placed
 *   doors_unlit      an intact building with two or more outside doors and no light at them, door lights not asked for
 *   silhouette_flat  a building of two storeys or more (or a large one) with nothing above its roof
 *   facades_alike    three or more neighbouring buildings with the same storeys, the same walls and the same detail
 *                    treatment (resolve/recipes/treatments.ts: posts, bands, plinths, trim material)
 *
 * Not built, and why (build plan §3.2): `storage_scattered` needs a container trait in the feature table (gen/catalog.ts,
 * the anchors package) and its advice ("name the room a store so its stock is stacked") relies on storage stacks, which
 * no generator builds yet; a note whose action relies on unbuilt behaviour is not advice for this plan (review policy,
 * plan/generator.ts).
 *
 * Every note is measured on the resolved plan (no build needed), and only for a plan whose generator has the switch.
 */
import type { MapPlan, Vec2 } from "../contracts/plan";
import type { ResolvedFeature, ResolvedLevel, ResolvedPlan, ResolvedStructure } from "../contracts/resolved";
import { sceneMeantDim } from "./lights";
import { CELL, CELL_FLAG } from "../contracts/resolved";
import { featureInfo } from "../gen/catalog";
import { isPassage } from "../gen/openingKinds";
import { LevelGrid } from "../resolve/levelGrid";
import { maxOf, minOf } from "../util/lists";
import { centreOf, neighbourGroups } from "../resolve/neighbours";
import { buildingDoors, openingCell, roomLane } from "./qualityMap";
import type { DesignNote } from "./review";
import { REVIEW, capped } from "./thresholds";

const Q = REVIEW.quality;
const rank = (weight: number, n: number): number => weight * capped(0.8 + n / 3);
const listed = (xs: readonly string[], most = 6): string =>
  xs.slice(0, most).join(", ") + (xs.length > most ? ` and ${String(xs.length - most)} more` : "");
const key = (x: number, y: number): string => `${x},${y}`;

/** A room whose lane the plan's own features block: the room, how much, and which features. */
interface BlockedLane {
  room: string;
  name: string;
  share: number;
  cut: boolean;
  features: string[];
  cell: Vec2;
}

function blockedLanes(plan: MapPlan, L: ResolvedLevel): BlockedLane[] {
  const planIds = new Set((plan.levels.find((l) => l.id === L.id)?.features ?? []).map((f) => f.id));
  const placed = L.features.filter(
    (f) => planIds.has(f.id) && f.blocking && !featureInfo(f.type).wallMounted,
  );
  if (placed.length === 0) return [];
  const grid = new LevelGrid(L);
  const W = L.bounds.w;
  const out: BlockedLane[] = [];
  L.areas.forEach((a, ai) => {
    if (a.kind !== "room") return;
    const cells = new Set<string>();
    for (let i = 0; i < L.cells.area.length; i++)
      if (
        L.cells.area[i] === ai + 1 &&
        L.cells.state[i] === CELL.OPEN &&
        ((L.cells.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER)) === 0
      )
        cells.add(key(L.bounds.x + (i % W), L.bounds.y + Math.floor(i / W)));
    const doors = L.openings
      .filter((o) => isPassage(o.kind))
      .map((o) => openingCell(o, a.id))
      .filter((c): c is Vec2 => c !== undefined && cells.has(key(c[0], c[1])));
    if (doors.length < 2) return;
    // the plan's features in this room, by the cells they cover
    const by = new Map<string, string>();
    for (const f of placed)
      for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
        for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) if (cells.has(key(x, y))) by.set(key(x, y), f.id);
    if (by.size === 0) return;
    const { lane, cut: cutBefore } = roomLane(grid, cells, doors);
    if (lane.size === 0) return;
    const hit = [...lane].filter((c) => by.has(c));
    const cut = roomLane(grid, cells, doors, new Set(by.keys())).cut > cutBefore;
    const share = hit.length / lane.size;
    if (share <= Q.laneShare && !cut) return;
    out.push({
      room: a.id,
      name: a.name ?? a.id,
      share,
      cut,
      features: [...new Set(hit.map((c) => by.get(c) as string))].sort(),
      cell: doors[0] as Vec2,
    });
  });
  return out;
}

const roofAccent = (s: ResolvedStructure): boolean => {
  if (s.chimneys.length > 0) return true;
  const f = s.furniture;
  if (f && (f.dormers || f.mast || f.finial || f.hut === true || f.clutter > 0)) return true;
  if ((s.design?.rooftop.length ?? 0) > 0) return true;
  const vs = s.volumes ?? [];
  if (vs.some((v) => v.on !== null)) return true;
  const tops = vs.map((v) => maxOf(v.storeys.map((q) => q.wallTop)));
  return tops.length > 1 && maxOf(tops) - minOf(tops) >= Q.accentRise;
};

const storeysOf = (s: ResolvedStructure): number => s.design?.storeys ?? s.storeys.length;
const wallsOf = (s: ResolvedStructure): string => s.design?.material ?? s.storeys[0]?.walls ?? "none";
const intact = (s: ResolvedStructure): boolean => s.condition === undefined || s.condition === "intact";

/** The quality notes of a map (the caller checks the plan's generator has `qualityNotes`). */
export function qualityNotes(
  plan: MapPlan,
  resolved: ResolvedPlan,
  gives?: (f: ResolvedFeature) => boolean,
): DesignNote[] {
  const out: DesignNote[] = [];
  // generator 5: a scene meant to be dim keeps its doors dark on purpose
  const dimScene = sceneMeantDim(plan);
  const lanes = resolved.levels.flatMap((L) => blockedLanes(plan, L).map((b) => ({ ...b, levelId: L.id })));
  const first = lanes[0];
  if (first) {
    const features = [...new Set(lanes.flatMap((b) => b.features))];
    out.push({
      code: "lane_blocked",
      levelId: first.levelId,
      score: rank(Q.weights.lane, lanes.length),
      cell: first.cell,
      elementIds: [...lanes.map((b) => b.room), ...features].slice(0, 12),
      message: `the way between the doors of ${listed(lanes.map((b) => `${b.name} (${b.room})`))} is ${lanes.some((b) => b.cut) ? "cut off" : "blocked"} by ${listed(features)}`,
      action: `keep a clear lane between a room's doors: move ${listed(features, 3)} against a wall`,
    });
  }

  for (const L of resolved.levels) {
    const buildings = (L.structures ?? []).filter((s) => s.kind === "building");

    const unlit = buildings
      .filter((s) => s.lighting?.doors !== true && !dimScene)
      .map((s) => ({ s, n: buildingDoors(L, s, gives).filter((d) => !d.lit).length }))
      .filter((x) => x.n >= Q.unlitDoors);
    if (unlit.length > 0)
      out.push({
        code: "doors_unlit",
        levelId: L.id,
        score: rank(Q.weights.doors, unlit.length),
        cell: centreOf(unlit.map((x) => x.s)),
        elementIds: unlit.map((x) => x.s.id),
        message: `${unlit.length} building(s) have outside doors with no light by them: ${listed(unlit.map((x) => `${x.s.id} (${x.n})`))}`,
        action: "set lighting.doors on them, or stand a light beside each outside door",
      });

    const flat = buildings.filter(
      (s) =>
        intact(s) &&
        (storeysOf(s) >= Q.silhouetteStoreys || s.cells.length >= Q.silhouetteCells) &&
        !roofAccent(s),
    );
    if (flat.length > 0)
      out.push({
        code: "silhouette_flat",
        levelId: L.id,
        score: rank(Q.weights.silhouette, flat.length),
        cell: centreOf(flat),
        elementIds: flat.map((s) => s.id),
        message: `${flat.length} large building(s) have nothing above the roofline: ${listed(flat.map((s) => s.id))}`,
        action: "give each something above its roof: chimneys, a taller volume or tower, or roofFurniture",
      });

    // the treatment each building drew: neighbours dressed differently do not read alike
    const treated = new Map((L.arrangements ?? []).map((a) => [a.host, a.treatment]));
    const rows = neighbourGroups(
      buildings,
      Q.gap,
      (s) => `${storeysOf(s)}|${wallsOf(s)}|${treated.get(s.id) ?? ""}`,
    ).filter((g) => g.length >= Q.facadesRow);
    const row = rows.sort((a, b) => b.length - a.length)[0];
    if (row)
      out.push({
        code: "facades_alike",
        levelId: L.id,
        score: rank(Q.weights.facades, row.length),
        cell: centreOf(row),
        elementIds: row.map((s) => s.id),
        message: `${row.length} neighbouring buildings have the same storeys (${storeysOf(row[0] as ResolvedStructure)}) and walls: ${listed(row.map((s) => s.id))}`,
        action:
          "vary the row: change storeys (one at least twice another) and wall styles between neighbours",
      });
  }
  return out;
}
