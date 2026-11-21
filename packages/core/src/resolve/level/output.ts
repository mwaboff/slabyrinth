/**
 * Step 10 of a level and the output: the derived data (area outlines, anchors and bounding boxes, edge hosts, cliffs,
 * the water surface, interior wall tops) and the conversion from the typed working arrays to the plain ResolvedLevel
 * contract shape.
 * Reads: the whole level state once every stage has run (the grid and every record, resolve/level/state.ts), and the
 * structures' own records (resolve/structure.ts). Writes: the ResolvedLevel it returns, plus `area_empty` and
 * water-level plan issues.
 */
import type { Material, Vec2, WallStyle } from "../../contracts/plan";
import { MATERIALS } from "../../contracts/plan";
import type { ResolvedArea, ResolvedLevel } from "../../contracts/resolved";
import { CELL, EDGE } from "../../contracts/resolved";
import { elementSeed } from "../../util/hash";
import { cliffRuns } from "../cliffs";
import { traceRings } from "../trace";
import { settleWallHeights } from "../wallSettle";
import { roughWallTops } from "../wallTops";
import type { EdgeArrays } from "./grid";
import type { ResolveLevelState } from "./state";
import { type WaterSurface, waterSurface } from "./waterSurface";

export function toResolved(s: ResolveLevelState): ResolvedLevel {
  const work = s.grid;
  const { w, h, n } = work;
  // materials in first-appearance order (row-major)
  const materials: Material[] = [];
  const matMap = new Map<number, number>();
  const material: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!work.isFloor(i)) continue;
    const m = work.mat[i] as number;
    if (m === 0) continue;
    let k = matMap.get(m);
    if (k === undefined) {
      k = materials.length;
      materials.push(MATERIALS[m - 1] as Material);
      matMap.set(m, k);
    }
    material[i] = k + 1;
  }
  const height: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) height[i] = work.state[i] === CELL.OPEN ? (work.height[i] as number) : 0;

  // wall styles + edge grids
  const wallStyles: WallStyle[] = [];
  const styleIdx = (s: WallStyle): number => {
    let k = wallStyles.indexOf(s);
    if (k < 0) {
      k = wallStyles.length;
      wallStyles.push(s);
    }
    return k;
  };
  const grid = (orient: "h" | "v", e: EdgeArrays): ResolvedLevel["hEdges"] => {
    const len = e.kind.length;
    const kind = new Array<number>(len);
    const ref = new Array<number>(len);
    const hgt = new Array<number>(len);
    const host = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      const k = e.kind[i] as number;
      kind[i] = k;
      hgt[i] = k === EDGE.NONE ? 0 : (e.height[i] as number);
      if (k === EDGE.WALL) ref[i] = styleIdx(e.style[i] ?? "wall");
      else if (k === EDGE.OPENING) ref[i] = e.ref[i] as number;
      else ref[i] = 0xffff;
      if (k === EDGE.WALL || k === EDGE.OPENING) {
        const [a, b] = work.edgeCells(orient, i);
        const forced = e.hostSet[i] as number;
        host[i] = forced >= 0 ? forced : work.hostOf(a, b, e.run[i] === 1);
      } else host[i] = 0;
    }
    return { kind, ref, height: hgt, host };
  };
  const hEdges = grid("h", work.hE);
  const vEdges = grid("v", work.vE);

  // areas
  const dispCells: number[][] = work.areas.map(() => []);
  for (let i = 0; i < n; i++) {
    const d = work.disp[i] as number;
    if (d > 0) (dispCells[d - 1] as number[]).push(i);
  }
  const areas: ResolvedArea[] = work.areas.map((info) => {
    const cells = dispCells[info.index] as number[];
    const openCells = cells.filter((i) => work.state[i] === CELL.OPEN);
    if (cells.length === 0) {
      work.issue(
        "error",
        "area_empty",
        info.isRoute
          ? `corridor "${info.area.id}" has no cells: its endpoints already touch or every cell on its path belongs to another area`
          : `area "${info.area.id}" has no cells (its shape is empty, outside the level, or covered by later areas)`,
        {
          path: `/levels/${work.li}/areas/${info.index}`,
          elementId: info.area.id,
          hint: info.isRoute
            ? "remove the route and add an opening between the two areas"
            : "move it, enlarge it, or reorder areas",
        },
      );
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of cells) {
      const [x, y] = work.cellXY(i);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const bbox =
      cells.length > 0
        ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
        : { x: work.bx, y: work.by, w: 0, h: 0 };
    const anchor = work.anchorOf(openCells.length > 0 ? openCells : cells) ?? [work.bx, work.by];
    const set = new Uint8Array(n);
    for (const i of cells) set[i] = 1;
    const outline =
      cells.length > 0
        ? traceRings(
            bbox.w,
            bbox.h,
            (ux, uy) => set[(bbox.y - work.by + uy) * w + (bbox.x - work.bx + ux)] === 1,
            bbox.x,
            bbox.y,
          )
        : [];
    const ra: ResolvedArea = {
      id: info.area.id,
      kind: info.kind,
      theme: info.theme,
      cellCount: cells.length,
      bbox,
      anchor,
      outline,
    };
    if (info.area.name !== undefined) ra.name = info.area.name;
    if (info.area.key !== undefined) ra.key = info.area.key;
    if (info.area.notes !== undefined) ra.notes = info.area.notes;
    if (info.area.labelAt !== undefined) ra.labelAt = [info.area.labelAt[0], info.area.labelAt[1]];
    // generator 4: the area's one classification, for the compiler and the review (they never parse words)
    if (work.profile.roomClassification) {
      if (info.room.purpose !== undefined) ra.purpose = info.room.purpose;
      if (info.room.abandoned) ra.abandoned = true;
      ra.finish = info.rough ? "rough" : "tidy";
    }
    return ra;
  });

  const lvl: ResolvedLevel = {
    id: work.level.id,
    name: work.level.name,
    elevation: work.level.elevation,
    bounds: { x: work.bx, y: work.by, w, h },
    cells: {
      state: Array.from(work.state),
      area: Array.from(work.disp),
      material,
      height,
      flags: Array.from(work.flags),
      theme: Array.from(work.theme),
    },
    areaIds: work.areas.map((a) => a.area.id),
    materials,
    themes: work.themes.slice(),
    wallStyles,
    hEdges,
    vEdges,
    areas,
    openings: s.openings,
    features: s.features.all.slice(),
    labels: work.level.labels.map((l) => ({
      id: l.id,
      text: l.text,
      at: [l.at[0], l.at[1]] as Vec2,
      size: l.size ?? "m",
    })),
  };
  if (s.bridges.decks.length > 0) lvl.bridges = s.bridges.decks;
  if (s.relief.outcrops.length > 0) lvl.outcrops = s.relief.outcrops;
  if (s.paths.kerbs.length > 0) lvl.kerbs = s.paths.kerbs;
  if (s.paths.roads.length > 0) lvl.roads = s.paths.roads;
  if (s.relief.ramps.length > 0) lvl.ramps = s.relief.ramps;
  if (work.profile.cliffRockBand) {
    const cliffs = cliffRuns(lvl);
    if (cliffs.length > 0) lvl.cliffs = cliffs;
  }
  let water: WaterSurface | null = null;
  if (work.profile.foundation) {
    lvl.foundation = work.level.foundation ?? (work.level.base.type === "ground" ? 2 : 0);
    water = waterSurface(work, s.chasms);
    if (water !== null) lvl.waterLevel = water.level;
  }
  if (work.profile.floorOpenings && s.floorOpenings.holes.length > 0)
    lvl.floorOpenings = s.floorOpenings.holes.map((fo) => ({
      id: fo.id,
      kind: fo.kind,
      cells: fo.cells.map((i) => work.cellXY(i) as Vec2),
      ...(fo.below !== undefined ? { below: fo.below } : {}),
      floorBelow: fo.floorBelow,
      hiddenEdge: fo.hiddenEdge,
      edgeCells: fo.edgeCells,
    }));
  if (work.profile.wanderingChannels) {
    if (s.chasms.channels.length > 0) lvl.channels = s.chasms.channels;
    if (s.chasms.falls.length > 0) lvl.falls = s.chasms.falls;
    // (wanderingChannels comes after foundation, so the surface above was asked for)
    if (water?.range) lvl.waterRange = water.range;
  }
  if (s.lines.length > 0) lvl.lines = s.lines;
  if (work.structs) Object.assign(lvl, work.structs.finish(work.level.elevation));
  // the walls of a built interior vary in height (resolve/wallTops.ts)
  if (work.profile.interiorWallTops && work.level.base.type === "solid") {
    if (!work.structs)
      roughWallTops(lvl, String(elementSeed(work.plan.seed, `${work.level.id}~walltops`, undefined)));
    // stepRoomFloors raises rooms in every solid-based level: the walls beside them are shortened by the step
    settleWallHeights(lvl);
  }
  return lvl;
}
