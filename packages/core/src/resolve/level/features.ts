/**
 * Step 8 of a level, the plan's own features, and the shared machinery of every later placement (FeatureWork): the
 * features placed so far and the cells they take, the placement grid the generators in gen/ read (gen/place.ts
 * PlacementGrid), the cells dressing must keep clear, and committing generated placements as features.
 * Owns FeatureWork: every phase-2 stage adds its features through it, and it alone writes the cells' FEATURE flag.
 * Reads: the level's features, cells and edges; read-only, what phase 1 left: the roads (a vehicle on a road is parked
 * in a kerb lane; crossings stay clear), the ramps (kept clear), the rivers (the water surface); the palette's piece
 * sizes and room pieces. Writes: the features and the cells they take, the generated-feature count, and plan issues
 * for features that cannot stand where the plan put them.
 */
import type { FeatureType, Side, Vec2 } from "../../contracts/plan";
import { MATERIALS } from "../../contracts/plan";
import type { ResolvedFeature } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { LIGHT_FEATURES, featureInfo, isLandmark, rotatedSize } from "../../gen/catalog";
import type { GeneratedPlacement, PlacementGrid } from "../../gen/place";
import type { ChasmRecords } from "./chasms";
import type { AreaInfo, ReadOnly, ResolveGrid } from "./grid";
import { type PathRecords, parkVehicle } from "./paths";
import type { ReliefRecords } from "./relief";
import { waterSurface } from "./waterSurface";

const LAVA_ORDINAL = MATERIALS.indexOf("lava") + 1;

/** What feature placement consults of phase 1, read-only. */
export interface PlacementSurroundings {
  /** Roads: their crossings stay clear, vehicles park in their kerb lanes. */
  paths: ReadOnly<PathRecords>;
  /** Rock ramps stay clear of dressing. */
  relief: ReadOnly<ReliefRecords>;
  /** Rivers: the water surface that dressing sinks stones to. */
  chasms: ReadOnly<ChasmRecords>;
}

/**
 * The level's features while phase 2 places them. Every feature goes in through `add` or `addGenerated`, which also
 * mark the cells it takes (how many features stand on each, the FEATURE flag for blocking ones, landmark and vehicle
 * cells); the list is read-only to everyone else. The keep-clear sets are built on first ask, which is in phase 2,
 * once the roads and ramps are final (nothing in phase 1 is handed a FeatureWork).
 */
export class FeatureWork {
  private readonly list: ResolvedFeature[] = [];
  /** Per cell, how many features stand on it. */
  private readonly occ: Uint16Array;
  private count = 0;
  /** Cells under landmark pieces (great trees, landmarks, great statues): later dressing keeps an apron round them. */
  private readonly landmarkCells = new Set<number>();
  /** Cells under vehicles: the street preset counts them toward its parking cap and keeps its own clear of them. */
  private readonly vehicleCells = new Set<number>();
  /** Generator 4: the recipe variants each purpose has drawn so far on this level (gen/rooms4.ts writes it). */
  private readonly roomMemory = new Map<string, number[]>();
  private keepClear: Set<number> | null = null;
  private rampSet: Set<number> | null = null;

  constructor(
    private readonly work: ResolveGrid,
    private readonly around: PlacementSurroundings,
  ) {
    this.occ = new Uint16Array(work.n);
  }

  /** The features placed so far, in the order placed (ResolvedLevel.features). */
  get all(): readonly ResolvedFeature[] {
    return this.list;
  }

  /** How many generated features the level holds (the cap is PLAN_LIMITS.generatedFeaturesPerLevel). */
  get generated(): number {
    return this.count;
  }

  /** True when a feature stands on cell `i` (false outside the level). */
  occupied(i: number): boolean {
    return i >= 0 && (this.occ[i] as number) > 0;
  }

  /** Places a feature on its footprint (`at`, `size`). */
  add(f: ResolvedFeature): void {
    const landmark = isLandmark(f.type);
    for (const i of this.work.footprint(f.at, f.size).cells) {
      if (landmark) this.landmarkCells.add(i);
      if (f.type === "vehicle") this.vehicleCells.add(i);
      this.occ[i] = (this.occ[i] as number) + 1;
      if (f.blocking) this.work.flags[i] = (this.work.flags[i] as number) | CELL_FLAG.FEATURE;
    }
    this.list.push(f);
  }

  /**
   * Places a generated feature and counts it toward the level's cap. `occupy` false lists it without taking its cells
   * (goods on a table, the pieces of an overhead line), so other dressing may still use them.
   */
  addGenerated(f: ResolvedFeature, occupy = true): void {
    if (occupy) this.add(f);
    else this.list.push(f);
    this.count++;
  }

  /** Commits a generator's placements as features "<opId>#<n>", counted toward the level's generated-feature cap. */
  commitGenerated(opId: string, placements: GeneratedPlacement[]): void {
    const work = this.work;
    placements.forEach((p, n) => {
      const info = featureInfo(p.type);
      const anchor = work.idx(p.at[0], p.at[1]);
      const rf: ResolvedFeature = {
        id: `${opId}#${n}`,
        type: p.type,
        generatedBy: opId,
        at: p.at,
        size: p.size,
        rot: p.rot,
        rotFine: p.rotFine,
        // generator 2: a generated piece may stand above (or sink below) the floor, e.g. a second course of rock
        baseHeight: work.featureBase(
          anchor,
          work.profile.featureLift ? ((p as { lift?: number }).lift ?? 0) : 0,
        ),
        theme: work.themes[anchor >= 0 ? (work.theme[anchor] as number) : 0] ?? work.levelTheme,
        blocking: info.blocking,
      };
      if (p.wall !== undefined) rf.wall = p.wall;
      if (p.variant !== undefined) rf.variant = p.variant;
      // generator 3: a sub-cell shift (each axis within half a tile)
      if (p.offset !== undefined && work.profile.subCellOffsets)
        rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
      // generator 3: a furnishing set against a wall stands clear of it (a preset's bed, coffin or brazier is a little
      // wider than its cell and would sink into the wall, verify_prop_in_wall): shifted 0.45 tile off each wall it
      // touches
      if (
        work.profile.furnitureOffWalls &&
        rf.offset === undefined &&
        !info.wallMounted &&
        !info.organic &&
        info.blocking
      ) {
        const [x0, y0] = p.at;
        const [x1, y1] = [p.at[0] + p.size[0] - 1, p.at[1] + p.size[1] - 1];
        let ox = 0;
        let oy = 0;
        for (let x = x0; x <= x1; x++) {
          if (work.edgeKindAt(x, y0, "N") === EDGE.WALL) oy = 0.45;
          if (work.edgeKindAt(x, y1, "S") === EDGE.WALL) oy = oy === 0.45 ? 0 : -0.45;
        }
        for (let y = y0; y <= y1; y++) {
          if (work.edgeKindAt(x0, y, "W") === EDGE.WALL) ox = 0.45;
          if (work.edgeKindAt(x1, y, "E") === EDGE.WALL) ox = ox === 0.45 ? 0 : -0.45;
        }
        if (ox !== 0 || oy !== 0) rf.offset = [ox, oy];
      }
      const ar = anchor >= 0 ? (work.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
      if (info.gmOnly) rf.gmOnly = true;
      this.addGenerated(rf);
    });
  }

  /** Road crossings and the pavement cells at their ends: generated dressing keeps off them. */
  crossingClear(): ReadonlySet<number> {
    if (this.keepClear) return this.keepClear;
    const work = this.work;
    const out = new Set<number>();
    for (const r of this.around.paths.roads)
      for (const c of r.crossings)
        for (const [x, y] of c.cells) {
          out.add(work.idx(x, y));
          // the pavement cells at each end of the crossing
          for (const [dx, dy] of c.axis === "h"
            ? [
                [0, -1],
                [0, 1],
              ]
            : [
                [-1, 0],
                [1, 0],
              ]) {
            const j = work.idx(x + (dx as number), y + (dy as number));
            if (j >= 0) out.add(j);
          }
        }
    this.keepClear = out;
    return out;
  }

  /** Cells of the rock ramps (generator 2): they stay clear of the band and other dressing. */
  private rampCells(): ReadonlySet<number> {
    if (!this.rampSet) {
      this.rampSet = new Set<number>();
      for (const r of this.around.relief.ramps)
        for (const [x, y] of r.cells) this.rampSet.add(this.work.idx(x, y));
    }
    return this.rampSet;
  }

  /** The level as the placement generators see it (gen/place.ts PlacementGrid). */
  placementGrid(): PlacementGrid {
    const work = this.work;
    return {
      inBounds: (x, y) => work.idx(x, y) >= 0,
      isFloor: (x, y) => placeable(work, work.idx(x, y)),
      flags: (x, y) => {
        const i = work.idx(x, y);
        return i < 0 ? 0 : (work.flags[i] as number);
      },
      area: (x, y) => {
        const i = work.idx(x, y);
        return i < 0 ? 0 : (work.disp[i] as number);
      },
      occupied: (x, y) => this.occupied(work.idx(x, y)),
      edge: (x, y, s) => work.edgeKindAt(x, y, s),
      landmark: (x, y) => this.landmarkCells.has(work.idx(x, y)),
      vehicle: (x, y) => this.vehicleCells.has(work.idx(x, y)),
      keepClear: (x, y) => this.crossingClear().has(work.idx(x, y)),
      // generator 2: rock ramp cells (no path flag) stay clear of the band and other dressing
      ramp: (x, y) => work.profile.ramps && this.rampCells().has(work.idx(x, y)),
      generator: work.plan.generator,
      // the band's pieces at their real size; undefined where the theme has no such piece (no band)
      ...(work.profile.realPieceSizes
        ? { pieceSize: (t: FeatureType) => work.ctx.palette.pieceSize(work.levelTheme, t) }
        : {}),
      // the real outline of those pieces, and the cells off the board (void or outside the bounds)
      ...(work.profile.realPieceOutlines
        ? {
            pieceExtent: (t: FeatureType) => work.ctx.palette.pieceSize(work.levelTheme, t, true),
            void: (x: number, y: number) => {
              const i = work.idx(x, y);
              return i < 0 || work.state[i] === CELL.VOID;
            },
          }
        : {}),
      // the board's water plane in tiles above the level floor (the scale of `height`): dressing sinks stones to it
      ...(work.profile.waterBody
        ? {
            waterSurface: () => {
              const s = waterSurface(work, this.around.chasms, false);
              return s === null ? undefined : s.level - work.level.elevation - 0.5;
            },
          }
        : {}),
      // floor height in tiles: set pieces put focal pieces on high ground and keep big pieces off height steps
      height: (x, y) => {
        const i = work.idx(x, y);
        // a void cell (cut away by the outline) keeps a stale height; the ground there is the base plane
        if (i < 0 || (work.state[i] === CELL.VOID && work.profile.voidIsBasePlane)) return 0;
        return (work.height[i] as number) / 4;
      },
      // what the room recipes need (gen/rooms4.ts)
      ...(work.profile.roomRecipes
        ? {
            piece4: (t: FeatureType, v?: string) => work.ctx.palette.roomPiece(work.levelTheme, t, v),
            wallHosted: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              if (!ed) return false;
              const [a, b] = work.edgeCells(ed.orient, ed.i);
              const forced = ed.e.hostSet[ed.i] as number;
              const host = forced >= 0 ? forced : work.hostOf(a, b, ed.e.run[ed.i] === 1);
              return host === (s === "N" || s === "W" ? 1 : 0);
            },
            wallHeight: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.height[ed.i] as number) : 0;
            },
            wallStyle: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.style[ed.i] ?? "wall") : undefined;
            },
            lightCells: () =>
              this.list.filter((f) => LIGHT_FEATURES.has(f.type)).map((f) => [f.at[0], f.at[1]] as const),
            roomMemory: this.roomMemory,
          }
        : {}),
    };
  }
}

/**
 * Floor that scatter/dress may furnish. Generator 2 also keeps generated props off lava and off bridge decks
 * (a deck must stay walkable, and its railings are not walls to hang torches on).
 */
function placeable(work: ResolveGrid, i: number): boolean {
  if (!work.isFloor(i)) return false;
  if (!work.profile.scatterKeepsClear) return true;
  if (work.structs?.reservedCell(i)) return false;
  if ((work.flags[i] as number) & (CELL_FLAG.BRIDGE | CELL_FLAG.STEPS)) return false;
  // keep the approach to bridges and stairs clear: no generated props on a cell beside a deck or a flight
  if (
    work
      .neighbours4(i)
      .some((j) => j >= 0 && ((work.flags[j] as number) & (CELL_FLAG.BRIDGE | CELL_FLAG.STEPS)) !== 0)
  )
    return false;
  return work.mat[i] !== LAVA_ORDINAL;
}

function nearestFree(
  work: ResolveGrid,
  type: FeatureType,
  at: Vec2,
  size: readonly [number, number],
  wall: Side | undefined,
): Vec2 | null {
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p: Vec2 = [at[0] + dx, at[1] + dy];
        if (work.featureProblem(type, p, size, wall) === null) return p;
      }
    }
  }
  return null;
}

/** The plan's own features: parked, snapped to a wall, or reported where they cannot stand, then placed. */
export function stepExplicitFeatures(
  work: ResolveGrid,
  features: FeatureWork,
  paths: ReadOnly<PathRecords>,
): void {
  work.level.features.forEach((f, k) => {
    const info = featureInfo(f.type);
    const rot = f.rot ?? 0;
    let size = rotatedSize(f.size ?? info.size, rot);
    if (f.type === "vehicle") {
      const parked = parkVehicle(work, paths, (i) => features.occupied(i), f.at, size);
      if (parked) {
        work.issue(
          "info",
          "feature_moved",
          `vehicle "${f.id}" at ${f.at[0]},${f.at[1]} stood on the pavement or across the road: parked at ${parked.at[0]},${parked.at[1]} in the kerb lane, along the road`,
          { path: `/levels/${work.li}/features/${k}`, elementId: f.id, cell: parked.at },
        );
        f = { ...f, at: parked.at };
        size = parked.size;
      }
    }
    let wall = info.wallMounted ? (f.wall ?? "N") : f.wall;
    // generator 3: a wall-mounted piece asked for a cell or side without a wall snaps to the nearest wall face within
    // one cell (same side first, then the other sides), instead of failing
    if (
      info.wallMounted &&
      work.profile.wallMountSnap &&
      work.featureProblem(f.type, f.at, size, wall) !== null
    ) {
      let snapped: { at: Vec2; wall: Side } | null = null;
      const sides: Side[] = [wall as Side, "N", "E", "S", "W"].filter(
        (s, n, a) => a.indexOf(s) === n,
      ) as Side[];
      const offs: Array<[number, number]> = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ];
      search: for (const [dx, dy] of offs) {
        for (const s of sides) {
          const p: Vec2 = [f.at[0] + dx, f.at[1] + dy];
          if (work.featureProblem(f.type, p, size, s) === null) {
            snapped = { at: p, wall: s };
            break search;
          }
        }
      }
      if (snapped) {
        work.issue(
          "info",
          "feature_moved",
          `${f.type} "${f.id}" had no wall at ${f.at[0]},${f.at[1]} (${wall}): snapped to the ${snapped.wall} wall of ${snapped.at[0]},${snapped.at[1]}`,
          { path: `/levels/${work.li}/features/${k}`, elementId: f.id, cell: snapped.at },
        );
        f = { ...f, at: snapped.at };
        wall = snapped.wall;
      }
    }
    const problem = work.featureProblem(f.type, f.at, size, wall);
    if (problem) {
      const near = nearestFree(work, f.type, f.at, size, wall);
      const code = problem.includes("another feature") ? "feature_overlap" : "feature_blocked";
      work.issue("error", code, `feature "${f.id}" (${f.type}) at ${f.at[0]},${f.at[1]}: ${problem}`, {
        path: `/levels/${work.li}/features/${k}`,
        elementId: f.id,
        cell: f.at,
        ...(near ? { hint: `nearest free spot is [${near[0]},${near[1]}]` } : {}),
      });
    }
    const anchor = work.idx(f.at[0], f.at[1]);
    const rf: ResolvedFeature = {
      id: f.id,
      type: f.type,
      at: [f.at[0], f.at[1]],
      size,
      rot,
      rotFine: rot,
      baseHeight: work.featureBase(anchor, f.lift ?? 0),
      theme: work.themes[anchor >= 0 ? (work.theme[anchor] as number) : 0] ?? work.levelTheme,
      blocking: info.blocking,
    };
    if (wall !== undefined) rf.wall = wall;
    if (f.variant !== undefined) rf.variant = f.variant;
    if (f.hint !== undefined) rf.hint = f.hint;
    if (f.label !== undefined) rf.label = f.label;
    const ar = anchor >= 0 ? (work.disp[anchor] as number) : 0;
    if (ar > 0) rf.area = (work.areas[ar - 1] as AreaInfo).area.id;
    if (f.gmOnly ?? info.gmOnly) rf.gmOnly = true;
    features.add(rf);
  });
}
