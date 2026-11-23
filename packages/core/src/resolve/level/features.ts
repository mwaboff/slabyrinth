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
import type { ResolvedFeature, ResolvedOpening } from "../../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../../contracts/resolved";
import { LIGHT_FEATURES, featureInfo, isLandmark, rotatedSize } from "../../gen/catalog";
import { SIDE_STEP } from "../../gen/gridGeometry";
import { isPassage, isWindow } from "../../gen/openingKinds";
import { featureRoles } from "../../gen/surfaces";
import { maxOf } from "../../util/lists";
import type { GeneratedPlacement, PlacementGrid } from "../../gen/placementGrid";
import { THEME_WALL_STYLE } from "../../gen/wallStyles";
import { wallRole } from "../../palette/roles";
import type { ChasmRecords } from "./chasms";
import type { ReadOnly, ResolveGrid } from "./grid";
import { type PathRecords, parkVehicle } from "./paths";
import type { ReliefRecords } from "./relief";
import { waterSurface } from "./waterSurface";

const LAVA_ORDINAL = MATERIALS.indexOf("lava") + 1;

/** A side's index in a window-edge key (FeatureWork.windowEdges). */
const SIDE_INDEX: Readonly<Record<Side, number>> = { N: 0, E: 1, S: 2, W: 3 };

/** What feature placement consults of phase 1, read-only. */
export interface PlacementSurroundings {
  /** Roads: their crossings stay clear, vehicles park in their kerb lanes. */
  paths: ReadOnly<PathRecords>;
  /** Rock ramps stay clear of dressing. */
  relief: ReadOnly<ReliefRecords>;
  /** Rivers: the water surface that dressing sinks stones to. */
  chasms: ReadOnly<ChasmRecords>;
  /** The level's openings: nothing blocking stands in front of a way in (generator 4, `inWayIn`). */
  openings: readonly ResolvedOpening[];
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
  private passageFrontSet: Set<number> | null = null;
  private windowEdgeSet: Set<number> | null = null;
  /** Generator 4: the lane before each market stall's front row (filled as the stalls are placed). */
  private readonly stallFronts = new Set<number>();
  private readonly keptClearCells = new Set<number>();
  /** Generator 5 (lightRegimes): the light level drawn for each furnished room (ResolvedArea.lightLevel). */
  readonly lightLevels = new Map<string, number>();

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
    if (f.stall) this.addStallFront(f.at, f.size, f.stall.front);
    this.list.push(f);
  }

  /** Generator 5: cells a room's furnisher kept clear (standing room, the way in, landings): ResolvedLevel.keptClear. */
  keepClearOf(cells: ReadonlyArray<readonly [number, number]>): void {
    for (const [x, y] of cells) {
      const i = this.work.idx(x, y);
      if (i >= 0) this.keptClearCells.add(i);
    }
  }

  /** The cells kept clear so far (keepClearOf), ascending. */
  get keptClear(): number[] {
    return [...this.keptClearCells].sort((a, b) => a - b);
  }

  /** The cells along a stall's front side, just outside its footprint: where its customers stand. */
  private addStallFront(at: readonly [number, number], size: readonly [number, number], front: Side): void {
    const [dx, dy] = SIDE_STEP[front];
    const x0 = dx > 0 ? at[0] + size[0] : dx < 0 ? at[0] - 1 : at[0];
    const y0 = dy > 0 ? at[1] + size[1] : dy < 0 ? at[1] - 1 : at[1];
    const n = dx === 0 ? size[0] : size[1];
    for (let k = 0; k < n; k++) {
      const i = dx === 0 ? this.work.idx(x0 + k, y0) : this.work.idx(x0, y0 + k);
      if (i >= 0) this.stallFronts.add(i);
    }
  }

  /**
   * Places a generated feature and counts it toward the level's cap; false when it is refused. `occupy` false lists it
   * without taking its cells (goods on a table, the pieces of an overhead line), so other dressing may still use them.
   *
   * Generator 4 (`waysInKeepClear`): this is the one way a generated feature enters the level, so this is where a
   * blocking piece that would stand in, or reach over, a cell in front of a way in (`blocksWayIn`) is refused: every
   * placer is held to it, whether it asked first (and chose another spot) or not. `wayIn.mayStand` is the exception of
   * a placer whose pieces may stand there, with the reason, written at the call site.
   */
  addGenerated(f: ResolvedFeature, opts: { occupy?: boolean; wayIn?: { mayStand: string } } = {}): boolean {
    if (
      opts.wayIn === undefined &&
      f.blocking &&
      this.blocksWayIn(f.type, f.at, f.size, f.variant, {
        rotFine: f.rotFine,
        ...(f.offset !== undefined ? { offset: f.offset } : {}),
      })
    )
      return false;
    if (opts.occupy ?? true) this.add(f);
    else this.list.push(f);
    this.count++;
    return true;
  }

  /**
   * Commits a generator's placements as features "<opId>#<n>", counted toward the level's generated-feature cap. A
   * placement refused at a way in (`addGenerated`) takes the pieces lifted onto its cells with it (a thing on a table
   * is not left floating where the table was refused); its number stays unused.
   */
  commitGenerated(opId: string, placements: GeneratedPlacement[]): void {
    const work = this.work;
    const refusedCells = new Set<number>();
    placements.forEach((p, n) => {
      if ((p.lift ?? 0) > 0 && refusedCells.has(work.idx(p.at[0], p.at[1]))) return;
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
        baseHeight: work.featureBase(anchor, work.profile.featureLift ? (p.lift ?? 0) : 0),
        theme: work.themeAt(anchor),
        blocking: info.blocking,
      };
      if (p.wall !== undefined) rf.wall = p.wall;
      if (p.variant !== undefined) rf.variant = p.variant;
      // generator 3: a sub-cell shift (each axis within half a tile)
      if (p.offset !== undefined && work.profile.subCellOffsets)
        rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
      // generator 3: a furnishing set against a wall stands clear of it
      if (work.profile.furnitureOffWalls && rf.offset === undefined) {
        const off = offWalls(work, p.type, p.at, p.size);
        if (off) rf.offset = off;
      }
      const shown = work.areaAt(anchor);
      if (shown) rf.area = shown.area.id;
      if (info.gmOnly) rf.gmOnly = true;
      if (!this.addGenerated(rf)) for (const i of work.footprint(rf.at, rf.size).cells) refusedCells.add(i);
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

  /**
   * Generator 4 (`waysInKeepClear`): a cell in front of a way in, where people stand to go through: both sides of every
   * passage (a door, an archway, a gate, an open gap; gen/openingKinds.ts `isPassage`) and the lane before a market
   * stall's front row. Nothing blocking may stand there, nor reach over it (`blocksWayIn`). `stallLanes` false leaves
   * the stalls' lanes out: the market lays its own pieces round its stalls (stock never in front, posts at an aisle's
   * ends).
   */
  inWayIn(i: number, stallLanes = true): boolean {
    if (!this.work.profile.waysInKeepClear || i < 0) return false;
    return this.passageFronts().has(i) || (stallLanes && this.stallFronts.has(i));
  }

  /**
   * Generator 4 (`waysInKeepClear`): a blocking piece of this type, anchored at `at` with this footprint, would stand in
   * or reach over a cell in front of a way in (`inWayIn`). Its reach is its real outline round the footprint's middle:
   * the widest variant the anchor cell's theme builds it with (a tree's crown is wider than its cell), turned any way.
   * `addGenerated`, the one entry of every generated feature, refuses a piece it answers true for; the placers that
   * choose among spots (scatter, dress, the composed set pieces, through the placement grid) ask it first so they pick
   * another. The exceptions say why at their call: the market (it keeps the doors clear cell by cell, `marketCellOk`,
   * and its stalls carry goods a refusal would leave standing on nothing) and the heap under a collapse.
   */
  blocksWayIn(
    type: FeatureType,
    at: readonly [number, number],
    size: readonly [number, number],
    variant?: string,
    pose?: { rotFine: number; offset?: readonly [number, number] },
  ): boolean {
    if (!this.work.profile.waysInKeepClear) return false;
    const info = featureInfo(type);
    if (!info.blocking || info.wallMounted) return false;
    const theme = this.work.pieceTheme(this.work.idx(at[0], at[1]));
    const ext = this.work.ctx.palette.roomPiece(theme, type, variant);
    // turned any way (a scattered piece turns in steps of 15°): half its outline's diagonal
    const reach = Math.hypot(ext?.wMax ?? 0, ext?.dMax ?? 0) / 2;
    let cx = at[0] + size[0] / 2;
    let cy = at[1] + size[1] / 2;
    let rx = Math.max(size[0] / 2, reach);
    let ry = Math.max(size[1] / 2, reach);
    // generator 5: a piece set square (a quarter turn) where it stands reaches exactly its outline there
    if (
      pose !== undefined &&
      this.work.profile.exactWayInReach &&
      pose.rotFine % 90 === 0 &&
      ext !== undefined
    ) {
      const across = pose.rotFine % 180 !== 0;
      cx += pose.offset?.[0] ?? 0;
      cy += pose.offset?.[1] ?? 0;
      rx = (across ? ext.dMax : ext.wMax) / 2;
      ry = (across ? ext.wMax : ext.dMax) / 2;
    }
    // a cell the outline only grazes (a hundredth of a tile) does not count
    const EPS = 0.01;
    for (let y = Math.floor(cy - ry + EPS); y < cy + ry - EPS; y++)
      for (let x = Math.floor(cx - rx + EPS); x < cx + rx - EPS; x++)
        if (this.inWayIn(this.work.idx(x, y))) return true;
    return false;
  }

  /** Both side cells of every passage of the level (built on first ask: the openings are final in phase 2). */
  private passageFronts(): ReadonlySet<number> {
    if (this.passageFrontSet) return this.passageFrontSet;
    const out = new Set<number>();
    for (const o of this.around.openings) {
      if (!isPassage(o.kind)) continue;
      for (let k = 0; k < o.width; k++) {
        // the edge's two cells: north and south of an "h" edge, west and east of a "v" edge
        const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
        const [ax, ay] = o.orientation === "h" ? [x, y - 1] : [x - 1, y];
        for (const i of [this.work.idx(ax, ay), this.work.idx(x, y)]) if (i >= 0) out.add(i);
      }
    }
    this.passageFrontSet = out;
    return out;
  }

  /**
   * Generator 5: the window edges of the level, as cell index × 4 + side index (N, E, S, W) for both cells of each
   * (built on first ask, like the passage fronts).
   */
  private windowEdges(): ReadonlySet<number> {
    if (this.windowEdgeSet) return this.windowEdgeSet;
    const out = new Set<number>();
    for (const o of this.around.openings) {
      if (!isWindow(o.kind)) continue;
      for (let k = 0; k < o.width; k++) {
        const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
        // north (west) of the edge the window is on the cell's south (east) side; the other cell has it on its north (west)
        const [ax, ay] = o.orientation === "h" ? [x, y - 1] : [x - 1, y];
        const [sa, sb] = o.orientation === "h" ? [2, 0] : [1, 3];
        const ia = this.work.idx(ax, ay);
        const ib = this.work.idx(x, y);
        if (ia >= 0) out.add(ia * 4 + sa);
        if (ib >= 0) out.add(ib * 4 + sb);
      }
    }
    this.windowEdgeSet = out;
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
      area: (x, y) => work.shownRegionAt(work.idx(x, y)),
      occupied: (x, y) => this.occupied(work.idx(x, y)),
      edge: (x, y, s) => work.edgeKindAt(x, y, s),
      landmark: (x, y) => this.landmarkCells.has(work.idx(x, y)),
      vehicle: (x, y) => this.vehicleCells.has(work.idx(x, y)),
      keepClear: (x, y) => this.crossingClear().has(work.idx(x, y)),
      // generator 4: nothing blocking in front of a way in (a door, a stall's front)
      ...(work.profile.waysInKeepClear
        ? {
            blocksWayIn: (t: FeatureType, at, size, v?: string, pose?) =>
              this.blocksWayIn(t, at, size, v, pose),
          }
        : {}),
      // generator 2: rock ramp cells (no path flag) stay clear of the band and other dressing
      ramp: (x, y) => work.profile.ramps && this.rampCells().has(work.idx(x, y)),
      generator: work.plan.generator,
      // the band's pieces at their real size; undefined where the theme has no such piece (no band)
      ...(work.profile.realPieceSizes
        ? {
            pieceSize: (t: FeatureType, x: number, y: number) =>
              work.ctx.palette.pieceSize(work.pieceTheme(work.idx(x, y)), t),
          }
        : {}),
      // the real outline of those pieces, and the cells off the board (void or outside the bounds)
      ...(work.profile.realPieceOutlines
        ? {
            pieceExtent: (t: FeatureType, x: number, y: number) =>
              work.ctx.palette.pieceSize(work.pieceTheme(work.idx(x, y)), t, true),
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
            // generator 4 only: always the anchor cell's theme
            piece4: (t: FeatureType, x: number, y: number, v?: string) =>
              work.ctx.palette.roomPiece(work.themeAt(work.idx(x, y)), t, v),
            wallHosted: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              if (!ed) return false;
              const [a, b] = work.edgeCells(ed.orient, ed.i);
              const forced = ed.e.hostSet[ed.i] as number;
              const host = forced >= 0 ? forced : work.hostOf(a, b, ed.e.run[ed.i] === 1);
              return host === (s === "N" || s === "W" ? 1 : 0);
            },
            // the realize wall pass builds a rock wall's column in the cell past the edge, and nothing past the board
            // when its edge is an exit (resolve/wallFaces.ts boardEdgeIsExit, compile/realize/walls.ts)
            wallBuilt: (x: number, y: number, s: Side) => {
              if (!work.profile.mountsOnBuiltWalls || !work.profile.boardEdgeExits) return true;
              if (work.idx(x + SIDE_STEP[s][0], y + SIDE_STEP[s][1]) >= 0) return true;
              const ed = work.sideEdge(x, y, s);
              if (!ed || ed.e.kind[ed.i] !== EDGE.WALL) return true;
              const style = ed.e.style[ed.i] ?? THEME_WALL_STYLE;
              const res = work.ctx.palette.probe(work.themeAt(work.idx(x, y)))([wallRole(style)]);
              return (res?.def.mount ?? "half-cell") !== "full-cell";
            },
            wallHeight: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.height[ed.i] as number) : 0;
            },
            wallStyle: (x: number, y: number, s: Side) => {
              const ed = work.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.style[ed.i] ?? THEME_WALL_STYLE) : undefined;
            },
            headroom: (x: number, y: number) =>
              work.profile.ceilingOverRooms ? work.headroomAt(x, y) : Infinity,
            lightCells: () =>
              this.list.filter((f) => LIGHT_FEATURES.has(f.type)).map((f) => [f.at[0], f.at[1]] as const),
            roomMemory: this.roomMemory,
          }
        : {}),
      // generator 5: the room furnisher reads the windows (a desk at one, nothing tall across one)
      ...(work.profile.companionGroups
        ? {
            windowOn: (x: number, y: number, s: Side) => {
              const i = work.idx(x, y);
              return i >= 0 && this.windowEdges().has(i * 4 + SIDE_INDEX[s]);
            },
          }
        : {}),
      // generator 5: the light regimes choose lights by the pieces the compiler would build (gen/lightReach.ts)
      ...(work.profile.lightRegimes
        ? {
            lightPieces: (t: FeatureType, x: number, y: number, v?: string) => {
              const theme = work.themeAt(work.idx(x, y));
              for (const role of featureRoles(t)) {
                const res = work.ctx.palette.roles.resolve(theme, role).resolution;
                if (!res) continue;
                const vs =
                  v !== undefined
                    ? res.variants.filter((q) => q.variant === v)
                    : res.variants.filter((q) => q.weight > 0);
                if (vs.length === 0) continue;
                return {
                  names: vs.map((q) => q.name ?? q.uuid),
                  wMax: maxOf(vs.map((q) => q.geom.size.x)),
                  dMax: maxOf(vs.map((q) => q.geom.size.z)),
                  hMax: maxOf(vs.map((q) => q.geom.size.y)),
                };
              }
              return undefined;
            },
          }
        : {}),
    };
  }
}

/**
 * The sub-cell shift that sets a blocking furnishing clear of the walls it stands against (a bed, coffin, brazier or
 * barrel is a little wider than its cell, and a wall hosted on the cell's side takes half of it: it would sink into
 * the wall, verify_prop_in_wall): 0.45 tile off each wall the footprint touches, none between two facing walls.
 * Undefined for a piece that is wall-mounted, organic or not blocking, or that touches no wall. `openings`: an opening
 * edge counts as wall too (a window's frame and the course under it stand where the wall would).
 */
export function offWalls(
  work: ReadOnly<ResolveGrid>,
  type: FeatureType,
  at: readonly [number, number],
  size: readonly [number, number],
  openings = false,
): [number, number] | undefined {
  const info = featureInfo(type);
  if (info.wallMounted || info.organic || !info.blocking) return undefined;
  const walled = (x: number, y: number, s: Side): boolean => {
    const k = work.edgeKindAt(x, y, s);
    return k === EDGE.WALL || (openings && k === EDGE.OPENING);
  };
  const [x0, y0] = at;
  const [x1, y1] = [at[0] + size[0] - 1, at[1] + size[1] - 1];
  let ox = 0;
  let oy = 0;
  for (let x = x0; x <= x1; x++) {
    if (walled(x, y0, "N")) oy = 0.45;
    if (walled(x, y1, "S")) oy = oy === 0.45 ? 0 : -0.45;
  }
  for (let y = y0; y <= y1; y++) {
    if (walled(x0, y, "W")) ox = 0.45;
    if (walled(x1, y, "E")) ox = ox === 0.45 ? 0 : -0.45;
  }
  return ox !== 0 || oy !== 0 ? [ox, oy] : undefined;
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
      theme: work.themeAt(anchor),
      blocking: info.blocking,
    };
    if (wall !== undefined) rf.wall = wall;
    if (f.variant !== undefined) rf.variant = f.variant;
    if (f.hint !== undefined) rf.hint = f.hint;
    if (f.label !== undefined) rf.label = f.label;
    const shown = work.areaAt(anchor);
    if (shown) rf.area = shown.area.id;
    if (f.gmOnly ?? info.gmOnly) rf.gmOnly = true;
    features.add(rf);
  });
}
