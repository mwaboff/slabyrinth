/**
 * Floor openings (generator 3 and up): holes cut in a level's floor (a collapse, a shaft, a balcony) and what they do
 * to the level below. Runs in three places: the floor_opening op with the over-layer terrain (step 4), the rim after
 * the openings (step 6), and, once every level has resolved its phase 1, `linkFloorOpenings` across levels
 * (resolvePlan); the rubble and debris are placed with the features (phase 2).
 * Owns FloorOpeningRecords (this level's holes, and the rubble the level above drops on this one); every other stage
 * reads them. Reads: the op's shape and kind, the cells' floors and flags, the edges round the hole, the level below.
 * Writes: the holes (the cut cells, rim style, rim cells and what lies below), the cut cells' floors, the rim edges (a
 * low wall or railing hosted on the floor beside the hole), the level below's rubble and mound heights, and the
 * rubble and debris features.
 */
import type { TerrainOp, Vec2, WallStyle } from "../../contracts/plan";
import type { ResolvedFeature } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { featureInfo, rotatedSize } from "../../gen/catalog";
import { ValueNoise } from "../../gen/noise";
import { isLowWallStyle } from "../../gen/wallStyles";
import { elementSeed, h32, subSeed } from "../../util/hash";
import { roughenLumps } from "../organic";
import type { FeatureWork } from "./features";
import { type AreaInfo, type ReadOnly, type ResolveGrid, RAILING_HEIGHT } from "./grid";
import type { ResolveLevelState } from "./state";

/** The shape of a collapse (applyFloorOpening); the rest of its outline is the profile's `openingOutline` tuning. */
const RAGGED = {
  /** A hole of fewer cells keeps its shape. */
  minCells: 6,
  /** A hole of this many cells has its lumps roughened twice. */
  twiceFrom: 20,
  /** A roughened hole of this many cells also has rim cells bitten off. */
  biteFrom: 12,
  /** Noise scale (cells) of the lobes that bulge out beside the hole. */
  lobeScale: 1.6,
} as const;
/** Share of a collapse's rim edges left open (where people walk to the edge, and rubble spilled over it). */
const RIM_GAP_SHARE = 0.4;
/** Below this share of its cells over open floor on the level below, a floor opening looks into rock (a warning). */
const FLOOR_BELOW_SHARE = 0.6;
/** The mound under a collapse (moundUnder). */
const MOUND = {
  /** Fewer floor cells under the hole get no mound. */
  minCells: 6,
  /** Noise scale (cells) and share of inner cells that stay at the lower step. */
  scale: 1.7,
  lowShare: 0.35,
  /** Rise (quarter tiles): one cell in from the skirt, and the crown. */
  lowQ: 2,
  highQ: 4,
} as const;
/** Debris along the rim of a collapse (stepOpeningRimDebris): share of rim cells, and of the cells one further back. */
const RIM_DEBRIS = { onRim: 0.75, behind: 0.22 } as const;

/** Generator 3: a hole cut in the floor by a floor_opening op, and what the review and the level below learn of it. */
export interface FloorOpening {
  id: string;
  kind: "collapse" | "shaft" | "balcony";
  rim: WallStyle | "none";
  cells: number[];
  rubble: boolean;
  seed: number;
  below?: string;
  floorBelow: number;
  hiddenEdge: number;
  edgeCells: number;
  /** Generator 4: floor cells beside the hole (the broken rim of a collapse), where low debris is dropped. */
  rimCells: number[];
}

/** The level's floor openings. Written only by this module (the op, the rims, the link to the level below). */
export class FloorOpeningRecords {
  /** This level's holes, in op order. */
  readonly holes: FloorOpening[] = [];
  /** Generator 3: rubble to heap on this level's floor under a collapse in the level above (global cells). */
  readonly rubbleUnder: Array<{ id: string; cells: Vec2[]; seed: number }> = [];
}

/**
 * Generator 3: the floor_opening op. Open floor cells of the shape lose their floor but stay part of their area, so no
 * wall rings the hole (stepOpeningRims adds the low edge afterwards). A collapse is ragged: corners cut, sides bitten,
 * lobes bulging out where noise says so, never into a wall's cell.
 */
export function applyFloorOpening(
  work: ResolveGrid,
  op: Extract<TerrainOp, { op: "floor_opening" }>,
  path: string,
  out: FloorOpeningRecords,
): void {
  if (!work.profile.floorOpenings) {
    work.issue(
      "warning",
      "no_effect",
      `terrain op "${op.id}" (floor_opening) needs generator 3 and was ignored`,
      { path, elementId: op.id, hint: 'set "generator": 3 on the plan, or use an area with floor "none"' },
    );
    return;
  }
  const kind = op.kind ?? "collapse";
  const free = (i: number): boolean =>
    i >= 0 &&
    work.state[i] === CELL.OPEN &&
    ((work.flags[i] as number) &
      (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE | CELL_FLAG.LINK | CELL_FLAG.STEPS)) ===
      0;
  let cells = work.shapeCells(op.shape, "terrain", path, op.id).filter(free);
  const seed = subSeed(elementSeed(work.plan.seed, op.id), "floor-opening");
  const outline = work.profile.openingOutline;
  if (
    (op.edge ?? (kind === "collapse" ? "ragged" : "clean")) === "ragged" &&
    cells.length >= RAGGED.minCells
  ) {
    const tiers = new Map<number, number>(cells.map((i) => [i, 1]));
    roughenLumps(tiers, work.organicGrid(), seed);
    if (cells.length >= RAGGED.twiceFrom) roughenLumps(tiers, work.organicGrid(), subSeed(seed, "again"));
    let kept = cells.filter((i) => (tiers.get(i) ?? 0) > 0);
    if (kept.length >= RAGGED.biteFrom) {
      const noise = new ValueNoise(subSeed(seed, "rim"));
      const dist = work.innerDistance(kept);
      kept = kept.filter((i) => {
        const [x, y] = work.cellXY(i);
        return !(
          (dist.get(i) ?? 2) === 1 && noise.sample(x / outline.grain, y / outline.grain) < outline.cut
        );
      });
    }
    if (kept.length >= Math.ceil(cells.length * outline.keepShare)) {
      // lobes: open floor beside the hole, with open floor on every side of it (no wall or rock next to the new edge)
      const inSet = new Set(kept);
      const noise = new ValueNoise(subSeed(seed, "lobes"));
      for (const i of cells) {
        if (!inSet.has(i)) continue;
        const [x, y] = work.cellXY(i);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const j = work.idx(x + dx, y + dy);
          const lobe = noise.sample((x + dx) / RAGGED.lobeScale, (y + dy) / RAGGED.lobeScale);
          if (!free(j) || inSet.has(j) || lobe < outline.lobeCut) continue;
          const [jx, jy] = work.cellXY(j);
          const clear = (
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const
          ).every(([ex, ey]) => free(work.idx(jx + ex, jy + ey)) && !work.hasWallAround(jx, jy));
          if (clear) inSet.add(j);
        }
      }
      cells = [...inSet].sort((a, b) => a - b);
    }
  }
  for (const i of cells) {
    work.flags[i] = ((work.flags[i] as number) | CELL_FLAG.NO_FLOOR) & ~(CELL_FLAG.WATER | CELL_FLAG.PATH);
    work.mat[i] = 0;
  }
  if (cells.length === 0) {
    work.issue(
      "warning",
      "no_effect",
      `floor_opening "${op.id}" changed nothing: its shape covers no open floor`,
      {
        path,
        elementId: op.id,
        hint: "place it inside a room of this level (an opening only cuts floor that exists)",
      },
    );
    return;
  }
  out.holes.push({
    id: op.id,
    kind,
    rim:
      op.rim ??
      (work.profile.lowOpeningRims
        ? // generator 4: a collapse has no wall at all (stepOpeningRims drops rubble on its edge instead); a shaft has a
          // low kerb, a balcony a railing: nothing 2 tall hides the hole
          kind === "collapse"
          ? "none"
          : kind === "shaft"
            ? "low_wall"
            : "railing"
        : kind === "collapse"
          ? "ruined"
          : "iron_bars"),
    cells,
    rubble: kind === "collapse" && op.rubble !== false,
    seed,
    floorBelow: 0,
    hiddenEdge: 0,
    edgeCells: 0,
    rimCells: [],
  });
}

/**
 * Generator 3: the low edge round every floor opening: a railing (shaft, balcony) or a broken rim with gaps (collapse)
 * on each edge between a hole cell and the floor beside it, standing on that floor. Also counts the edge cells and the
 * ones a full-height wall already hides (the walls of the area itself), for the review.
 */
export function stepOpeningRims(work: ResolveGrid, out: FloorOpeningRecords): void {
  const low = work.profile.lowOpeningRims;
  for (const fo of out.holes) {
    const set = new Set(fo.cells);
    for (const i of fo.cells) {
      const [x, y] = work.cellXY(i);
      for (const side of ["N", "E", "S", "W"] as const) {
        const [dx, dy] = side === "N" ? [0, -1] : side === "S" ? [0, 1] : side === "E" ? [1, 0] : [-1, 0];
        const j = work.idx(x + dx, y + dy);
        if (j < 0 || work.state[j] !== CELL.OPEN || set.has(j)) continue;
        if (((work.flags[j] as number) & CELL_FLAG.NO_FLOOR) !== 0) continue;
        const ed = work.sideEdge(x, y, side);
        if (!ed) continue;
        const k = ed.e.kind[ed.i];
        fo.edgeCells++;
        if (k === EDGE.WALL) {
          if ((ed.e.height[ed.i] as number) >= 1.5) fo.hiddenEdge++;
          continue;
        }
        if (k === EDGE.OPENING || k === EDGE.STAIR) continue;
        if (low && fo.kind === "collapse" && !fo.rimCells.includes(j)) fo.rimCells.push(j);
        if (fo.rim === "none") continue;
        // a broken rim has gaps: where people walk to the edge, and rubble spilled over it
        if (fo.kind === "collapse" && h32(`${fo.seed}:rim:${x}:${y}:${side}`) / 4294967296 < RIM_GAP_SHARE)
          continue;
        ed.e.kind[ed.i] = EDGE.WALL;
        ed.e.style[ed.i] = fo.rim;
        ed.e.height[ed.i] = RAILING_HEIGHT;
        // generator 4: a rim piece that stands taller than a railing (a wall style a model asked for) hides the hole
        if (low && !isLowWallStyle(fo.rim)) fo.hiddenEdge++;
        // the rim stands on the floor beside the hole: host on that cell (first = N/W cell of the edge)
        ed.e.hostSet[ed.i] = side === "N" || side === "W" ? 0 : 1;
      }
    }
  }
}

/**
 * Generator 3, after the links, across the plan's levels (in plan order): each level's floor openings look into the
 * next level down. Every level of a plan has the same generator, so the first one says whether this runs.
 */
export function linkFloorOpenings(levels: readonly ResolveLevelState[]): void {
  if (levels[0]?.grid.profile.floorOpenings !== true) return;
  const byElev = [...levels].sort((a, b) => a.grid.level.elevation - b.grid.level.elevation);
  for (const s of levels)
    linkOpenings(s, byElev.filter((o) => o.grid.level.elevation < s.grid.level.elevation).pop());
}

/**
 * What lies under each floor opening of a level (the next level down), a plan issue when it is not open floor, and the
 * rubble the lower level heaps under a collapse (placed with its generated features).
 */
function linkOpenings(level: ResolveLevelState, lower: ResolveLevelState | undefined): void {
  const work = level.grid;
  const below = lower?.grid;
  for (const fo of level.floorOpenings.holes) {
    const xy = fo.cells.map((i) => work.cellXY(i) as Vec2);
    const path = `/levels/${work.li}/terrain`;
    if (!lower || !below) {
      work.issue(
        "warning",
        "opening_no_floor_below",
        `floor opening "${fo.id}" has no level below it to look into`,
        {
          path,
          elementId: fo.id,
          hint: "add a level one storey (2.5) lower with a room under the opening, or use an area with floor none for an open pit",
        },
      );
      continue;
    }
    fo.below = below.level.id;
    fo.floorBelow = xy.filter(([x, y]) => below.hasFloorAt(x, y)).length;
    if (fo.floorBelow < Math.ceil(xy.length * FLOOR_BELOW_SHARE)) {
      const first = xy.find(([x, y]) => !below.hasFloorAt(x, y)) ?? xy[0];
      work.issue(
        "warning",
        "opening_no_floor_below",
        `floor opening "${fo.id}" on ${work.level.id}: only ${fo.floorBelow} of its ${xy.length} cells have open floor on ${below.level.id} under them (e.g. ${first?.[0]},${first?.[1]} is solid rock, void or another hole); you would look into rock`,
        {
          path,
          elementId: fo.id,
          ...(first ? { cell: first } : {}),
          hint: `put a room of ${below.level.id} under the opening (same x,y cells), or move the opening over the room below`,
        },
      );
    }
    if (fo.rubble) lower.floorOpenings.rubbleUnder.push({ id: fo.id, cells: xy, seed: fo.seed });
    if (fo.rubble && work.profile.rubbleMounds) moundUnder(below, xy, fo.seed);
  }
}

/**
 * Generator 4: the heap under a collapse is a mound, not a flat layer. Floor cells under the hole rise in half-tile
 * steps from the skirt (level) to a crown up to a tile high (rock surface), never beside a wall, a stair or a link, and
 * never more than half a tile between neighbours, so it can be walked. Runs before the features of the level so
 * everything standing in the heap rides on it.
 */
function moundUnder(work: ResolveGrid, xy: Vec2[], seed: number): void {
  const wanted = new Set<number>();
  for (const [x, y] of xy) {
    const i = work.idx(x, y);
    if (i < 0 || !work.hasFloorAt(x, y)) continue;
    const f = work.flags[i] as number;
    if (
      (f & (CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.BRIDGE | CELL_FLAG.WATER | CELL_FLAG.STAIRWELL)) !==
      0
    )
      continue;
    if (work.hasWallAround(x, y)) continue;
    wanted.add(i);
  }
  if (wanted.size < MOUND.minCells) return;
  const dist = work.innerDistance([...wanted]);
  const noise = new ValueNoise(subSeed(seed, "mound"));
  for (const i of wanted) {
    const d = dist.get(i) ?? 1;
    const [x, y] = work.cellXY(i);
    const lift =
      d <= 1
        ? 0
        : d === 2 || noise.sample(x / MOUND.scale, y / MOUND.scale) < MOUND.lowShare
          ? MOUND.lowQ
          : MOUND.highQ;
    if (lift === 0) continue;
    work.height[i] = (work.height[i] as number) + lift;
    work.setMaterial(i, "rock");
  }
}

/**
 * Generator 4: low broken pieces dropped on the floor along the edge of a collapse: debris (nothing taller than half a
 * tile, never blocking) on most rim cells, thinning one cell further back. The hole itself stays open.
 */
export function stepOpeningRimDebris(
  work: ResolveGrid,
  features: FeatureWork,
  openings: ReadOnly<FloorOpeningRecords>,
): void {
  if (!work.profile.lowOpeningRims) return;
  for (const fo of openings.holes) {
    if (fo.kind !== "collapse" || fo.rim !== "none" || fo.rimCells.length === 0) continue;
    const holes = new Set(fo.cells);
    const u = (i: number, k: string): number => h32(`${fo.seed}:rimdebris:${k}:${i}`) / 4294967296;
    const info = featureInfo("debris");
    const size = rotatedSize(info.size, 0);
    let n = 0;
    const drop = (i: number): void => {
      const c = work.cellXY(i) as Vec2;
      if (work.featureProblem("debris", c, size, undefined) !== null) return;
      const rf: ResolvedFeature = {
        id: `${fo.id}#rim${n++}`,
        type: "debris",
        generatedBy: fo.id,
        at: c,
        size,
        rot: 0,
        rotFine: (h32(`${fo.seed}:rimrot:${i}`) % 24) * 15,
        baseHeight: work.featureBase(i, 0),
        theme: work.themeAt(i),
        blocking: info.blocking,
      };
      const ar = work.disp[i] as number;
      if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
      features.addGenerated(rf);
    };
    const rim = [...new Set(fo.rimCells)].sort((a, b) => a - b);
    const back = new Set<number>();
    for (const i of rim) {
      if (u(i, "on") < RIM_DEBRIS.onRim) drop(i);
      const [x, y] = work.cellXY(i);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const j = work.idx(x + dx, y + dy);
        if (j >= 0 && !holes.has(j) && !rim.includes(j) && work.hasFloorAt(x + dx, y + dy)) back.add(j);
      }
    }
    for (const j of [...back].sort((a, b) => a - b)) if (u(j, "back") < RIM_DEBRIS.behind) drop(j);
  }
}

/** Generator 3: rubble heaped on the floor under a collapse of the level above: densest and biggest at the centre. */
export function stepOpeningRubble(
  work: ResolveGrid,
  features: FeatureWork,
  openings: ReadOnly<FloorOpeningRecords>,
): void {
  for (const r of openings.rubbleUnder) {
    const cells: Vec2[] = r.cells.filter(([x, y]) => work.hasFloorAt(x, y)).map(([x, y]) => [x, y]);
    if (cells.length === 0) continue;
    const cx = cells.reduce((s, c) => s + c[0], 0) / cells.length + 0.5;
    const cy = cells.reduce((s, c) => s + c[1], 0) / cells.length + 0.5;
    const dist = (c: Vec2): number => Math.hypot(c[0] + 0.5 - cx, c[1] + 0.5 - cy);
    const maxD = Math.max(1, ...cells.map(dist));
    const order = [...cells].sort((a, b) => dist(a) - dist(b) || a[1] - b[1] || a[0] - b[0]);
    const u = (c: Vec2, k: string): number => h32(`${r.seed}:rubble:${k}:${c[0]}:${c[1]}`) / 4294967296;
    let n = 0;
    const put = (type: "cave_in" | "rubble" | "debris" | "rock", c: Vec2): boolean => {
      const info = featureInfo(type);
      const size = rotatedSize(info.size, 0);
      if (work.featureProblem(type, c, size, undefined) !== null) return false;
      const anchor = work.idx(c[0], c[1]);
      const rf: ResolvedFeature = {
        id: `${r.id}#rubble${n++}`,
        type,
        generatedBy: r.id,
        at: c,
        size,
        rot: 0,
        rotFine: (h32(`${r.seed}:rot:${c[0]}:${c[1]}`) % 24) * 15,
        baseHeight: work.featureBase(anchor, 0),
        theme: work.themeAt(anchor),
        blocking: info.blocking,
      };
      const ar = anchor >= 0 ? (work.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
      features.addGenerated(rf);
      return true;
    };
    // the heap: a cave-in at the centre, rubble round it, debris and the odd rock at the skirt (thinning with distance)
    let cave = 0;
    for (const c of order) {
      const d = dist(c) / maxD;
      if (cave < 2 && d < 0.5 && put("cave_in", c)) {
        cave++;
        continue;
      }
      if (u(c, "p") > 0.92 - 0.8 * d) continue;
      if (d < 0.6) put("rubble", c);
      else put(u(c, "t") < 0.25 ? "rock" : "debris", c);
    }
  }
}
