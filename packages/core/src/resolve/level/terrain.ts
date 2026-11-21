/**
 * Steps 2 and 4 of a level: the terrain ops, layer "under" (before the areas) and layer "over" (after them), and the
 * natural board outline of an open-air level.
 * Reads: the level's terrain ops in plan order, the cells as the areas left them. The shaping ops go to their own
 * modules (chasms, relief, floorOpenings) with the record each owns (TerrainRecords); paint, noise, path and height
 * are applied here.
 * Writes: cell floors, heights and PATH flags; the path ops' queued roads and kerbed paths (PathRecords, finished by
 * resolve/level/paths.ts); no-effect plan issues. Returns the cells each paint, noise, path or height op changed, for
 * the check that an under-layer op survived the areas. The board outline turns open cells outside it to void.
 */
import type { TerrainOp, Vec2 } from "../../contracts/plan";
import { PLAN_LIMITS } from "../../contracts/plan";
import { CELL, CELL_FLAG } from "../../contracts/resolved";
import { type CellMask, forEachMaskCell } from "../../gen/mask";
import { ValueNoise } from "../../gen/noise";
import { jitterPolyline, rasterPolyline, rasterizeShape } from "../../gen/shapes";
import { elementSeed, subSeed } from "../../util/hash";
import { isNaturalGround, isWater } from "../materials";
import { organicTiers } from "../organic";
import { trailCells } from "../trail";
import { STILL_WATER, riverCourse } from "../water";
import { type ChasmRecords, applyChasm, boardBox, keepOffHighGround } from "./chasms";
import { type FloorOpeningRecords, applyFloorOpening } from "./floorOpenings";
import type { ReadOnly, ResolveGrid } from "./grid";
import { type PathRecords, stepPathSpurs, stepPavements } from "./paths";
import { type ReliefRecords, applyOutcrop, applyPlatform, applyStairsOp, applyUneven } from "./relief";

/** The records the terrain ops write, each owned by the module that applies its ops. */
export interface TerrainRecords {
  chasms: ChasmRecords;
  relief: ReliefRecords;
  floorOpenings: FloorOpeningRecords;
  paths: PathRecords;
}

/** The cells a paint, noise, path or height op changed. */
export interface TerrainTouch {
  op: TerrainOp;
  path: string;
  cells: number[];
}

/** Applies the level's terrain ops of one layer, in plan order; returns the cells each simple op changed. */
export function stepTerrain(work: ResolveGrid, layer: "under" | "over", out: TerrainRecords): TerrainTouch[] {
  const touches: TerrainTouch[] = [];
  work.level.terrain.forEach((op, k) => {
    if (op.op === "scatter" || op.op === "dress") return;
    const structural =
      op.op === "chasm" ||
      op.op === "platform" ||
      op.op === "stairs" ||
      op.op === "uneven" ||
      op.op === "outcrop" ||
      op.op === "floor_opening";
    const opLayer = structural ? "over" : (op.layer ?? "under");
    if (opLayer !== layer) return;
    const path = `/levels/${work.li}/terrain/${k}`;
    switch (op.op) {
      case "chasm":
        applyChasm(work, op, path, out.chasms);
        return;
      case "platform":
        applyPlatform(work, op, path);
        return;
      case "stairs":
        applyStairsOp(work, op, path, out.relief);
        return;
      case "uneven":
        applyUneven(work, op, path);
        return;
      case "outcrop":
        applyOutcrop(work, op, path, out.relief);
        return;
      case "floor_opening":
        applyFloorOpening(work, op, path, out.floorOpenings);
        return;
    }
    const r = applyTerrain(work, op, path, layer, out.paths);
    if (r.touched.length > 0) touches.push({ op, path, cells: r.touched });
    if (r.touched.length === 0 && !r.partial) reportTerrainNoEffect(work, op, path, layer, r.inShape, r.open);
  });
  stepPavements(work, layer, out.paths);
  if (layer === "under") stepPathSpurs(work);
  return touches;
}

/** Warning for a paint/noise/path/height op that changed no cell, with the reason and the fix. */
function reportTerrainNoEffect(
  work: ResolveGrid,
  op: Exclude<
    TerrainOp,
    { op: "scatter" | "dress" | "chasm" | "platform" | "stairs" | "uneven" | "outcrop" | "floor_opening" }
  >,
  path: string,
  layer: "under" | "over",
  inShape: number,
  open: number,
): void {
  let why: string;
  let hint: string;
  if (inShape === 0) {
    why = "its shape has no cell inside the level";
    hint = `move it inside the level bounds (${work.bx},${work.by} ${work.w}x${work.h})`;
  } else if (open === 0 && layer === "under") {
    why =
      op.op === "height"
        ? 'layer "under" runs before the areas, when every cell of this level is still rock, and this map uses generator 1, where an under height op only changes cells that are already open'
        : 'layer "under" runs before the areas, when every cell of this level is still rock, and terrain ops never open rock';
    hint =
      op.op === "height"
        ? 'use layer "over" (applied after the areas) or give the area a floorHeight; for a crevasse use the chasm terrain op'
        : 'use layer "over" (applied after the areas) to change the floor of the areas';
  } else if (open === 0) {
    why = "none of its cells is open floor (terrain ops never open rock or void)";
    hint = "place it inside an area (or on ground), or add an area there first";
  } else {
    why = `its ${open} open cells already have that height`;
    hint = "remove it, or change set/delta";
  }
  work.issue(
    "warning",
    "no_effect",
    `terrain op "${op.id}" (${op.op}, layer ${layer}) changed nothing: ${why}`,
    { path, elementId: op.id, hint },
  );
}

/**
 * Under-layer ops (`under`: what stepTerrain returned for that layer) whose every touched cell was taken over by an
 * area that sets its own value (its floor for paint/noise/path, floorHeight for height), or that no area ever opened.
 */
export function checkUnderSurvivors(work: ResolveGrid, under: readonly TerrainTouch[]): void {
  for (const { op, path, cells } of under) {
    const isHeight = op.op === "height";
    let survivors = 0;
    let opened = 0;
    for (const i of cells) {
      if (work.state[i] !== CELL.OPEN) continue;
      opened++;
      if (isHeight ? work.heightSet[i] === 0 : work.struct[i] === 0) survivors++;
    }
    if (survivors > 0) continue;
    const msg =
      opened === 0
        ? `terrain op "${op.id}" (${op.op}, layer under) changes nothing you can see: no area opens any of its cells, so they stay solid rock`
        : isHeight
          ? `terrain op "${op.id}" (height, layer under) is overridden everywhere: every area covering it sets its own floorHeight`
          : `terrain op "${op.id}" (${op.op}, layer under) is painted over everywhere: the areas covering it set their own floor`;
    const hint =
      opened === 0
        ? "put an area over those cells, or move the op inside an area"
        : isHeight
          ? 'remove floorHeight from those areas, or use layer "over"'
          : 'use layer "over" to paint on top of the areas, or set the area\'s floor';
    work.issue("warning", "no_effect", msg, { path, elementId: op.id, hint });
  }
}

function applyTerrain(
  work: ResolveGrid,
  op: Exclude<
    TerrainOp,
    { op: "scatter" | "dress" | "chasm" | "platform" | "stairs" | "uneven" | "outcrop" | "floor_opening" }
  >,
  path: string,
  layer: "under" | "over",
  paths: PathRecords,
): { touched: number[]; inShape: number; open: number; partial: boolean } {
  // Generator 2: an under-layer height op sets the height field of every cell (rock included); the areas that open
  // those cells later inherit it unless they set floorHeight (contracts/plan.ts GENERATOR_VERSION).
  const field = op.op === "height" && layer === "under" && work.profile.underHeightField;
  const open = (i: number): boolean => field || work.state[i] === CELL.OPEN;
  const touched: number[] = [];
  let inShape = 0;
  let openCount = 0;
  // noise picks cells by coverage: hitting open cells but picking none is the model's call, not a no-op mistake
  let partial = false;
  switch (op.op) {
    case "paint": {
      for (const i of work.shapeCells(op.shape, "terrain", path, op.id)) {
        inShape++;
        if (!open(i)) continue;
        openCount++;
        work.setMaterial(i, op.material);
        touched.push(i);
      }
      break;
    }
    case "noise": {
      const seed = elementSeed(work.plan.seed, op.id, op.seed);
      const noise = new ValueNoise(subSeed(seed, "noise"));
      const scale = Math.max(1, op.scale ?? 8);
      for (const i of work.shapeCells(op.shape, "terrain", path, op.id)) {
        inShape++;
        if (!open(i)) continue;
        openCount++;
        const [x, y] = work.cellXY(i);
        if (noise.sample(x / scale, y / scale) < op.coverage) {
          work.setMaterial(i, op.material);
          touched.push(i);
        }
      }
      partial = openCount > 0;
      break;
    }
    case "path": {
      const seed = elementSeed(work.plan.seed, op.id, op.seed);
      // generator 2 road form (resolve/road.ts): sidewalk and/or crossings; always straight
      const road = work.profile.roads && (op.sidewalk !== undefined || op.crossings !== undefined);
      // generator 2: water winds like a trail unless told to run straight
      const wetPath = isWater(op.material);
      const natural0 =
        work.profile.naturalPaths &&
        !road &&
        (op.style ?? (isNaturalGround(op.material) || wetPath ? "natural" : "straight")) === "natural";
      const drawn = op.points ?? connectPoints(work, op.connect ?? [], path, op.id, !natural0);
      // a river or brook crosses the map: from one board edge to another, off the border in between
      const base =
        work.profile.riverCourses && wetPath && op.points !== undefined && !STILL_WATER.test(op.id)
          ? keepOffHighGround(work, drawn, riverCourse(drawn, boardBox(work), op.width))
          : drawn;
      const natural = natural0;
      // a straight road never wobbles: jitter only for paths that do not ask for straight
      const straightOnly = road || (work.profile.naturalPaths && op.style === "straight");
      const visit = (x: number, y: number): void => {
        const i = work.idx(x, y);
        if (i < 0) return;
        inShape++;
        if (!open(i)) return;
        // a trail goes round buildings (their door approaches stay open floor beside them)
        if (natural && work.areas[(work.struct[i] as number) - 1]?.kind === "building") return;
        openCount++;
        work.setMaterial(i, op.material);
        work.flags[i] = (work.flags[i] as number) | CELL_FLAG.PATH;
        touched.push(i);
      };
      const anchors: Vec2[] = [];
      if (natural) {
        // a winding trail (resolve/trail.ts): smooth curve through the waypoints, slow width changes, small rounded
        // widenings where it meets what it connects
        const clip = work.rasterClip();
        const junctions = op.connect ? base : [];
        for (const c of [base[0] as Vec2, base[base.length - 1] as Vec2, ...junctions]) anchors.push(c);
        const cells = trailCells(base, op.width, op.jitter ?? 0.7, subSeed(seed, "trail"), clip, junctions);
        for (const [x, y] of cells) visit(x, y);
      } else {
        const pts = jitterPolyline(base, op.width, straightOnly ? 0 : (op.jitter ?? 0), seed);
        forEachMaskCell(rasterPolyline(pts, op.width, work.rasterClip()), visit);
        if (road) paths.pendingRoads.push({ op, axis: pts, layer, cells: touched.slice(), pave: [] });
      }
      if (op.kerb === true && !road)
        paths.pendingKerbs.push({ cells: new Set(touched), material: op.material, seed, anchors, natural });
      break;
    }
    case "height": {
      let cells = work.shapeCells(op.shape, "terrain", path, op.id);
      if (
        work.profile.raggedTerrainEdges &&
        (op.edge ?? (work.level.base.type === "ground" ? "ragged" : "clean")) === "ragged"
      ) {
        // natural ground: a rounded, wandering outline (resolve/organic.ts)
        const tiers = organicTiers(
          cells,
          1,
          1,
          subSeed(elementSeed(work.plan.seed, op.id), "rim"),
          work.organicGrid(),
          true,
          work.growRing(cells),
        );
        cells = [...tiers].filter(([, t]) => t >= 1).map(([i]) => i);
      }
      const smooth = Math.max(0, Math.floor(op.smooth ?? 0));
      const dist = smooth > 0 ? work.innerDistance(cells) : null;
      for (const i of cells) {
        inShape++;
        if (!open(i)) continue;
        openCount++;
        const d = dist ? (dist.get(i) ?? 1) : smooth + 1;
        const factor = Math.min(1, d / (smooth + 1));
        const cur = work.height[i] as number;
        let next: number;
        if (op.set !== undefined) next = Math.round(cur + (Math.round(op.set * 4) - cur) * factor);
        else next = cur + Math.round((op.delta ?? 0) * 4 * factor);
        next = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(PLAN_LIMITS.maxHeight * 4, next));
        work.height[i] = next;
        if (next !== cur) touched.push(i);
      }
      break;
    }
  }
  return { touched, inShape, open: openCount, partial };
}

/** Cells of `connect` (area anchors, feature cells, explicit cells) joined by L-shaped legs. */
function connectPoints(
  work: ResolveGrid,
  connect: ReadonlyArray<string | Vec2>,
  path: string,
  id: string,
  manhattan = true,
): Vec2[] {
  const at: Vec2[] = [];
  for (const c of connect) {
    if (typeof c !== "string") {
      at.push(c);
      continue;
    }
    const ai = work.areaIndexById.get(c);
    // an under-layer path runs before the areas claim cells: fall back to the area's own shape
    const info = ai !== undefined ? work.areas[ai] : undefined;
    const cell =
      ai !== undefined && info
        ? (work.anchorOf(work.areaCells(ai)) ??
          (info.isRoute
            ? null
            : work.anchorOf(
                rasterCellsOf(
                  rasterizeShape(info.area.shape, { planSeed: work.plan.seed, clip: work.rasterClip() }),
                  (x, y) => work.idx(x, y),
                ),
              )))
        : null;
    const feat = work.level.features.find((f) => f.id === c);
    const p = cell ?? (feat ? feat.at : null);
    if (p) at.push(p);
    else
      work.issue("warning", "ref_unknown", `path "${id}" connects to unknown "${c}"`, {
        path: `${path}/connect`,
        elementId: id,
        hint: `use area ids or feature ids on ${work.level.id}, or [x,y] cells`,
      });
  }
  const out: Vec2[] = [];
  for (let k = 0; k < at.length; k++) {
    const p = at[k] as Vec2;
    const prev = out[out.length - 1];
    if (manhattan && prev && prev[0] !== p[0] && prev[1] !== p[1]) out.push([p[0], prev[1]]);
    out.push(p);
  }
  return out.length >= 2 ? out : out.concat(out);
}

/** Local indices of a mask's cells that lie inside the level (`idx` < 0 = outside). */
function rasterCellsOf(m: CellMask, idx: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  forEachMaskCell(m, (x, y) => {
    const i = idx(x, y);
    if (i >= 0) out.push(i);
  });
  return out;
}

/**
 * Generator 2, open-air natural levels: the board gets a ragged, rounded outline (about 80–90% of its rectangle,
 * stepping in 2-cell blocks) with a strip of low ground about 2 cells wide inside it, so a rise never meets the
 * board edge. Cells outside become void. Paths, water, areas, structures and explicit features keep their cells,
 * so roads and rivers still reach the true edge. Built-up levels (buildings or roads) keep their rectangle.
 */
export function stepOutline(work: ResolveGrid, paths: ReadOnly<PathRecords>): void {
  const base = work.level.base;
  if (!work.profile.naturalLevelOutline || base.type !== "ground" || work.level.outline === "rect") return;
  if (!isNaturalGround(base.material)) return;
  if (paths.pendingRoads.length > 0) return;
  if (
    (work.level.structures ?? []).some((st) => st.kind !== "enclosure") &&
    (work.level.structures ?? []).length >= 3
  )
    return;
  if (work.w < 16 || work.h < 16) return;
  const noise = new ValueNoise(subSeed(elementSeed(work.plan.seed, `${work.level.id}~outline`), "outline"));
  const keep = (i: number): boolean => {
    const f = work.flags[i] as number;
    if ((f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.LINK)) !== 0) return true;
    if ((work.struct[i] as number) > 0) return true;
    return work.structs?.reservedCell(i) === true;
  };
  // the plan's own features keep their cells too
  const featureCells = new Set<number>();
  for (const ft of work.level.features)
    for (const c of work.footprint(ft.at, ft.size ?? [1, 1]).cells) featureCells.add(c);
  // inset from each edge in 2-cell blocks: 2..6 cells, wandering with noise along the edge
  const inside = new Uint8Array(work.n);
  for (let i = 0; i < work.n; i++) {
    const [x, y] = work.cellXY(i);
    const lx = x - work.bx;
    const ly = y - work.by;
    const bx2 = Math.floor(lx / 2);
    const by2 = Math.floor(ly / 2);
    const d = Math.min(lx, ly, work.w - 1 - lx, work.h - 1 - ly);
    const n = noise.sample(bx2 / 3.2, by2 / 3.2);
    const inset = n > 0.62 ? 4 : n > 0.42 ? 2 : 0;
    // corners round off: the inset grows where two edges are near
    const corner = Math.min(lx, work.w - 1 - lx) + Math.min(ly, work.h - 1 - ly) < 5 ? 2 : 0;
    inside[i] = d >= inset + corner ? 1 : 0;
  }
  // the open board: inside the outline, plus whatever must reach the edge
  for (let i = 0; i < work.n; i++) {
    if (work.state[i] !== CELL.OPEN) continue;
    if (inside[i] || keep(i) || featureCells.has(i)) continue;
    work.state[i] = CELL.VOID;
  }
  // (a low apron round the outline, lowering raised ground near the void, is deferred: it cut routes on plans
  // that put a plateau against the board edge; see handoff-terrain.md)
}
