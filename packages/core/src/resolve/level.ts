/**
 * Per-level resolution (architecture §2.4, normative order):
 *   1 base · 2 terrain "under" · 3 areas (routes last) · 4 terrain "over" · 5 edges + wall runs · 6 openings
 *   [7 links: done across levels by resolvePlan] · 8 explicit features · 9 generated features · 10 derived data.
 * Works on typed arrays; `toResolved()` converts to the plain ResolvedLevel contract shape.
 */
import type {
  AreaKind,
  BridgeSpan,
  FeatureType,
  Level,
  Material,
  Side,
  TerrainOp,
  Vec2,
  WallStyle,
} from "../contracts/plan";
import { MATERIALS, PLAN_LIMITS } from "../contracts/plan";
import type {
  ResolvedArea,
  ResolvedBridge,
  ResolvedFeature,
  ResolvedLevel,
  ResolvedLine,
  StallBuild,
} from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { featureInfo, rotatedSize } from "../gen/catalog";
import { type CellMask, forEachMaskCell } from "../gen/mask";
import { ValueNoise } from "../gen/noise";
import {
  type AvoidKind,
  type GeneratedPlacement,
  type PlacementGrid,
  dressArea,
  scatterFeatures,
} from "../gen/place";
import { defaultCliffBands } from "../gen/setpieces";
import { furnishedPurpose } from "../gen/roomPurpose";
import { isLowWallStyle, isNaturalWallStyle, isUnevenWallStyle } from "../gen/wallStyles";
import { dressRoom, lightArea } from "../gen/rooms4";
import { LIGHT_FEATURES } from "../gen/catalog";
import {
  TRADE_PROPS,
  stallKindInfo,
  layoutLine,
  layoutStalls,
  layoutStalls4,
  stallCell,
  tradeOf,
} from "../gen/market";
import {
  bandOffsets,
  jitterPolyline,
  rasterPolyline,
  rasterizeShape,
} from "../gen/shapes";
import { elementSeed, h32, subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { type ChasmGeometry, type ChasmSample, chasmGeometry, chasmSampleAt } from "./chasm";
import { type ChannelCell, type ReachPlan, planReaches } from "./falls";
import { breakStraightSteps, chamferCorners, organicTiers, roughenLumps } from "./organic";
import { raggedCaveOutline } from "./caveOutline";
import { CAVE_RELIEF, caveShelves } from "./caveRelief";
import { cliffRuns } from "./cliffs";
import { STILL_WATER, riverCourse } from "./water";
import { linkCellsOnLevel } from "../plan/links";
import { BUILT_FLOORS, FAMILY_ROTATION, accentTop, purposeFloor } from "./interiorFloors";
import { roughWallTops } from "./wallTops";
import { settleWallHeights } from "./wallSettle";
import { crossingCells, kerbLinesAndCorners } from "./road";
import { trailCells } from "./trail";
import { traceRings } from "./trace";
import {
  type AreaInfo,
  type BridgeRequest,
  type EdgeArrays,
  LevelWork,
  NATURAL_PATH,
  RAILING_HEIGHT,
  WATER_MATS,
  materialOrdinal,
} from "./level/work";
import { checkAreaFields, initAreas, stepAreas, stepBase } from "./level/areas";
import { stepEdges, stepStairs, stepWallRuns } from "./level/edges";
import { stepOpenings } from "./level/openings";

const WOOD_DECKS = new Set<Material>(["bridge_wood", "wood_plank"]);
const NATURAL_DECKS = new Set<Material>(["rock", "dirt", "gravel", "mud", "sand", "grass", "snow", "ice"]);
/** Rise of the deck's middle (quarter tiles) by span; plank bridges sag. */
const SPAN_ARCH_Q: Record<BridgeSpan, number> = { arch: 3, flat: 0, plank: -1, natural: 1 };
const SPAN_RAILING: Record<BridgeSpan, WallStyle | null> = {
  arch: "railing_stone",
  flat: "railing_stone",
  plank: "railing",
  natural: null,
};

const LAVA_ORDINAL = MATERIALS.indexOf("lava") + 1;
/** Generator 3: a long rift or river strays from the line between its ends by about this share of its length. */
const WANDER_SHARE = 0.2;
/** Samples (half a cell each) of the pool at the foot of a fall. */
const POOL_LENGTH = 7;
/** A pool is cut only into ground at most this far (a tile) above its level. */
const POOL_MAX_BANK_Q = 4;
/** Landmark-class pieces a spur trail leads to (the first found), then lesser focal pieces. */
const SPUR_PRIMARY = new Set<string>([
  "landmark",
  "statue_large",
  "monolith",
  "tree_large",
  "giant_mushroom",
]);
const SPUR_FOCAL = new Set<string>([
  "statue",
  "altar",
  "fountain",
  "well",
  "standing_stone",
  "tall_marker",
  "campfire",
  "fire_pit",
]);
export class LevelSteps extends LevelWork {
  /**
   * A river's inner points are drawn off the border, but never onto higher ground than the plan put them on (a brook at
   * the foot of a terrace stays at its foot): a moved point that would climb goes back where it was drawn.
   */
  private keepOffHighGround(drawn: readonly Vec2[], course: Vec2[]): Vec2[] {
    const hAt = (p: Vec2): number => {
      const i = this.idx(Math.round(p[0]), Math.round(p[1]));
      return i < 0 ? 0 : (this.height[i] as number);
    };
    const key = (p: Vec2): string => `${p[0]},${p[1]}`;
    const original = new Set(drawn.map(key));
    // inner points line up with the drawn points (extensions are only added at the ends)
    const offset = course.length > drawn.length && !original.has(key(course[0] as Vec2)) ? 1 : 0;
    return course.map((p, k) => {
      const d = drawn[k - offset];
      if (!d || original.has(key(p))) return p;
      return hAt(p) > hAt(d) ? ([d[0], d[1]] as Vec2) : p;
    });
  }

  /** The level's cells as a box (inclusive), for courses that run to the board edge. */
  private boardBox(): { x0: number; y0: number; x1: number; y1: number } {
    return { x0: this.bx, y0: this.by, x1: this.bx + this.w - 1, y1: this.by + this.h - 1 };
  }

  // ───────────────────────────── phase 1: steps 1–6 ─────────────────────────────

  runPhase1(): void {
    initAreas(this);
    stepBase(this);
    this.stepTerrain("under");
    stepAreas(this);
    if (this.gen.caveOutlines) this.stepCaveOutlines();
    this.structs?.afterAreas(this);
    this.checkUnderSurvivors();
    this.stepTerrain("over");
    this.structs?.afterTerrain(this);
    if (this.gen.caveRelief) this.stepCaveRelief();
    this.stepPavementFronts();
    this.stepOutline();
    this.stepBridges();
    if (this.gen.roomFloors) this.stepRoomFloors();
    stepEdges(this);
    stepStairs(this);
    this.stepRailings();
    this.stepRoads();
    this.stepKerbs();
    stepWallRuns(this);
    stepOpenings(this);
    this.stepOpeningRims();
    this.structs?.afterOpenings(this);
    checkAreaFields(this);
  }

  /**
   * Generator 4, built interiors (level base solid): rooms are told apart by floor and sit a step above the corridor
   * (resolve/interiorFloors.ts).
   *  (a) a room whose floor is the theme default (the model writes `flagstone` on every room, which says nothing) takes
   *      the floor its purpose asks for in the theme's floor family (gen/roomPurpose.ts, from the purpose the room was
   *      classified with once), else the first built floor that none of the rooms or corridors beside it mostly uses;
   *      corridor-like rooms (a landing, a passage), abandoned rooms and floors the plan chose on purpose are left alone;
   *  (b) a room a corridor opens on (a door or an unwalled boundary, not a wall it merely touches: see
   *      roomsOpeningOnCorridors), with no floorHeight and no height of its own (no dais, hole, steps or link)
   *      is raised a quarter tile; the lip at its door is the step. A miniature climbs half a tile, so a quarter is
   *      always walkable, and walls take their height from the lower floor (resolve/wallspan.ts), so tops stay put.
   * Rooms that hold a link end (stairs, ladder) keep their floor height: the climb lands on the level's own floor top.
   */
  private stepRoomFloors(): void {
    if (this.level.base.type !== "solid") return;
    const rooms = this.areas.filter(
      (a) => a.kind === "room" && !a.isZone && !a.isRoute && !a.isBridge && !a.floorNone && a.area.shape.type !== "route",
    );
    if (rooms.length === 0) return;
    // cells that hold a link end on this level (lower run, the well above it, the landing)
    const linkCells = new Set<number>();
    for (const c of linkCellsOnLevel(this.plan, this.level.id)) {
      const i = this.idx(c[0], c[1]);
      if (i >= 0) linkCells.add(i);
    }
    const cellsOf = new Map<number, number[]>();
    const nbrs = new Map<number, Set<number>>();
    for (const a of this.areas) {
      if (a.isZone) continue;
      cellsOf.set(a.index, this.areaCells(a.index));
    }
    for (const [ai, cells] of cellsOf) {
      const set = new Set<number>();
      for (const i of cells) {
        const [x, y] = this.cellXY(i);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const j = this.idx(x + dx, y + dy);
          if (j < 0 || this.state[j] !== CELL.OPEN) continue;
          const o = (this.struct[j] as number) - 1;
          if (o >= 0 && o !== ai) set.add(o);
        }
      }
      nbrs.set(ai, set);
    }
    // the floor an area mostly has (a dais or a painted patch does not count)
    const famOf = (ai: number): Material | undefined => {
      const count = new Map<number, number>();
      for (const i of cellsOf.get(ai) ?? []) {
        const m = this.mat[i] as number;
        if (m > 0) count.set(m, (count.get(m) ?? 0) + 1);
      }
      const top = [...count].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
      return top === undefined ? undefined : MATERIALS[top[0] - 1];
    };
    // (a) floors
    for (const info of rooms) {
      const td = this.ctx.themeDefaults(info.theme);
      if (!BUILT_FLOORS.has(td.floor)) continue;
      if (info.area.floor !== undefined && info.area.floor !== td.floor) continue;
      // the floor stays inside the theme's floor family: stone and earth below ground, wood and a few domestic tiles in
      // an inhabited timber building (the theme's interior character, resolve/themes.ts)
      const family = info.interior.floorFamily;
      const purpose = purposeFloor(info.room.purpose, family);
      // a corridor in all but name keeps the corridor's floor; an abandoned room keeps the level's default floor
      if (purpose === "keep" || info.room.abandoned) continue;
      const ns = [...(nbrs.get(info.index) ?? [])];
      const used = new Set<Material>(ns.map(famOf).filter((m): m is Material => m !== undefined));
      const rotation = FAMILY_ROTATION[family];
      const start = elementSeed(this.plan.seed, `${this.level.id}~${info.area.id}~floorfam`, undefined) % rotation.length;
      // a timber building keeps a room's purpose floor even when its neighbours share it (wood beside wood is one building);
      // the difference rule only picks among the rest
      const cand: Material[] = [
        ...(purpose !== null ? [purpose] : []),
        ...rotation.map((_, k) => rotation[(start + k) % rotation.length] as Material),
      ];
      const nCells = (cellsOf.get(info.index) ?? []).length;
      // a big room keeps to floors that come in big tiles (a 1x1-only tile would take four times the pieces)
      const pick = cand.find(
        (m) =>
          (!used.has(m) || (family === "timber" && m === purpose)) &&
          BUILT_FLOORS.has(m) &&
          (nCells <= 36 || (this.ctx.palette.floorTileArea(info.theme, m) ?? 4) >= 4),
      );
      if (pick === undefined || pick === td.floor) continue;
      const ord = materialOrdinal(pick);
      const cells = cellsOf.get(info.index) ?? [];
      for (const i of cells) if (this.mat[i] === info.floorMat) this.setMaterial(i, pick);
      info.floorMat = ord;
    }
    // (b) a step above the corridor, for a room you enter from one
    const joined = this.roomsOpeningOnCorridors(nbrs);
    for (const info of rooms) {
      if (info.area.floorHeight !== undefined) continue;
      const cells = cellsOf.get(info.index) ?? [];
      if (cells.length < 4) continue;
      if (!joined.has(info.index)) continue;
      const clean = cells.every(
        (i) =>
          this.height[i] === 0 &&
          !linkCells.has(i) &&
          ((this.flags[i] as number) &
            (CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.BRIDGE | CELL_FLAG.WATER | CELL_FLAG.STAIRWELL)) ===
            0,
      );
      if (!clean) continue;
      for (const i of cells) this.height[i] = 1;
    }
  }

  /**
   * Rooms (area indexes) a corridor opens on: a plan opening between the two (by `between` or by an `at` edge with a
   * cell of each on its sides), a route corridor that ends on the room, or a shared boundary where no wall stands
   * (neither area builds walls, as in stepEdges). A room that only touches a corridor across a solid wall is not one.
   * Runs before the openings are placed, so it reads the plan's openings, not the edges.
   */
  private roomsOpeningOnCorridors(nbrs: ReadonlyMap<number, ReadonlySet<number>>): Set<number> {
    const out = new Set<number>();
    const kindOf = (ai: number | undefined): AreaKind | undefined =>
      ai === undefined || ai < 0 ? undefined : this.areas[ai]?.kind;
    const pair = (a: number | undefined, b: number | undefined): void => {
      if (a === undefined || b === undefined) return;
      if (kindOf(a) === "room" && kindOf(b) === "corridor") out.add(a);
      if (kindOf(b) === "room" && kindOf(a) === "corridor") out.add(b);
    };
    const step: Record<Side, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
    for (const o of this.level.openings) {
      if (o.between) pair(this.areaIndexById.get(o.between[0]), this.areaIndexById.get(o.between[1]));
      else if (o.at) {
        const [dx, dy] = step[o.at.side];
        const width = o.width ?? (o.kind === "double_door" ? 2 : 1);
        // the run extends east along a horizontal edge (N/S side), south along a vertical one
        for (let k = 0; k < width; k++) {
          const x = o.at.x + (o.at.side === "N" || o.at.side === "S" ? k : 0);
          const y = o.at.y + (o.at.side === "E" || o.at.side === "W" ? k : 0);
          pair(this.owner(this.idx(x, y)) - 1, this.owner(this.idx(x + dx, y + dy)) - 1);
        }
      }
    }
    for (const info of this.areas) {
      const s = info.area.shape;
      if (info.kind !== "corridor" || s.type !== "route") continue;
      for (const end of [s.from, s.to])
        if (typeof end === "string") {
          const ai = this.areaIndexById.get(end);
          if (ai !== undefined && kindOf(ai) === "room") out.add(ai);
        }
    }
    for (const [ai, set] of nbrs) {
      if (kindOf(ai) !== "room") continue;
      for (const o of set)
        if (kindOf(o) === "corridor" && this.modeOf(ai + 1) !== "auto" && this.modeOf(o + 1) !== "auto") out.add(ai);
    }
    return out;
  }

  private stepTerrain(layer: "under" | "over"): void {
    this.level.terrain.forEach((op, k) => {
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
      const path = `/levels/${this.li}/terrain/${k}`;
      switch (op.op) {
        case "chasm":
          this.applyChasm(op, path);
          return;
        case "platform":
          this.applyPlatform(op, path);
          return;
        case "stairs":
          this.applyStairsOp(op, path);
          return;
        case "uneven":
          this.applyUneven(op, path);
          return;
        case "outcrop":
          this.applyOutcrop(op, path);
          return;
        case "floor_opening":
          this.applyFloorOpening(op, path);
          return;
      }
      const r = this.applyTerrain(op, path, layer);
      if (layer === "under" && r.touched.length > 0) this.underTouched.push({ op, path, cells: r.touched });
      if (r.touched.length === 0 && !r.partial)
        this.reportTerrainNoEffect(op, path, layer, r.inShape, r.open);
    });
    this.stepPavements(layer);
    if (layer === "under") this.stepPathSpurs();
  }

  /** Warning for a paint/noise/path/height op that changed no cell, with the reason and the fix. */
  private reportTerrainNoEffect(
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
      hint = `move it inside the level bounds (${this.bx},${this.by} ${this.w}x${this.h})`;
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
    this.issue(
      "warning",
      "no_effect",
      `terrain op "${op.id}" (${op.op}, layer ${layer}) changed nothing: ${why}`,
      { path, elementId: op.id, hint },
    );
  }

  /**
   * Under-layer ops whose every touched cell was taken over by an area that sets its own value (its floor for
   * paint/noise/path, floorHeight for height), or that no area ever opened.
   */
  private checkUnderSurvivors(): void {
    for (const { op, path, cells } of this.underTouched) {
      const isHeight = op.op === "height";
      let survivors = 0;
      let opened = 0;
      for (const i of cells) {
        if (this.state[i] !== CELL.OPEN) continue;
        opened++;
        if (isHeight ? this.heightSet[i] === 0 : this.struct[i] === 0) survivors++;
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
      this.issue("warning", "no_effect", msg, { path, elementId: op.id, hint });
    }
  }

  private applyTerrain(
    op: Exclude<
      TerrainOp,
      { op: "scatter" | "dress" | "chasm" | "platform" | "stairs" | "uneven" | "outcrop" | "floor_opening" }
    >,
    path: string,
    layer: "under" | "over",
  ): { touched: number[]; inShape: number; open: number; partial: boolean } {
    // Generator 2: an under-layer height op sets the height field of every cell (rock included); the areas that open
    // those cells later inherit it unless they set floorHeight (contracts/plan.ts GENERATOR_VERSION).
    const field = op.op === "height" && layer === "under" && this.gen.underHeightField;
    const open = (i: number): boolean => field || this.state[i] === CELL.OPEN;
    const touched: number[] = [];
    let inShape = 0;
    let openCount = 0;
    // noise picks cells by coverage: hitting open cells but picking none is the model's call, not a no-op mistake
    let partial = false;
    switch (op.op) {
      case "paint": {
        for (const i of this.shapeCells(op.shape, "terrain", path, op.id)) {
          inShape++;
          if (!open(i)) continue;
          openCount++;
          this.setMaterial(i, op.material);
          touched.push(i);
        }
        break;
      }
      case "noise": {
        const seed = elementSeed(this.plan.seed, op.id, op.seed);
        const noise = new ValueNoise(subSeed(seed, "noise"));
        const scale = Math.max(1, op.scale ?? 8);
        for (const i of this.shapeCells(op.shape, "terrain", path, op.id)) {
          inShape++;
          if (!open(i)) continue;
          openCount++;
          const [x, y] = this.cellXY(i);
          if (noise.sample(x / scale, y / scale) < op.coverage) {
            this.setMaterial(i, op.material);
            touched.push(i);
          }
        }
        partial = openCount > 0;
        break;
      }
      case "path": {
        const seed = elementSeed(this.plan.seed, op.id, op.seed);
        // generator 2 road form (resolve/road.ts): sidewalk and/or crossings; always straight
        const road = this.gen.roads && (op.sidewalk !== undefined || op.crossings !== undefined);
        // generator 2: water winds like a trail unless told to run straight
        const wetPath = WATER_MATS.has(op.material);
        const natural0 =
          this.gen.naturalPaths &&
          !road &&
          (op.style ?? (NATURAL_PATH.has(op.material) || wetPath ? "natural" : "straight")) === "natural";
        const drawn = op.points ?? this.connectPoints(op.connect ?? [], path, op.id, !natural0);
        // a river or brook crosses the map: from one board edge to another, off the border in between
        const base =
          this.gen.riverCourses && wetPath && op.points !== undefined && !STILL_WATER.test(op.id)
            ? this.keepOffHighGround(drawn, riverCourse(drawn, this.boardBox(), op.width))
            : drawn;
        const natural = natural0;
        // a straight road never wobbles: jitter only for paths that do not ask for straight
        const straightOnly = road || (this.gen.naturalPaths && op.style === "straight");
        const visit = (x: number, y: number): void => {
          const i = this.idx(x, y);
          if (i < 0) return;
          inShape++;
          if (!open(i)) return;
          // a trail goes round buildings (their door approaches stay open floor beside them)
          if (natural && this.areas[(this.struct[i] as number) - 1]?.kind === "building") return;
          openCount++;
          this.setMaterial(i, op.material);
          this.flags[i] = (this.flags[i] as number) | CELL_FLAG.PATH;
          touched.push(i);
        };
        const anchors: Vec2[] = [];
        if (natural) {
          // a winding trail (resolve/trail.ts): smooth curve through the waypoints, slow width changes, small rounded
          // widenings where it meets what it connects
          const clip = this.rasterClip();
          const junctions = op.connect ? base : [];
          for (const c of [base[0] as Vec2, base[base.length - 1] as Vec2, ...junctions]) anchors.push(c);
          const cells = trailCells(base, op.width, op.jitter ?? 0.7, subSeed(seed, "trail"), clip, junctions);
          for (const [x, y] of cells) visit(x, y);
        } else {
          const pts = jitterPolyline(base, op.width, straightOnly ? 0 : (op.jitter ?? 0), seed);
          forEachMaskCell(rasterPolyline(pts, op.width, this.rasterClip()), visit);
          if (road) this.pendingRoads.push({ op, axis: pts, layer, cells: touched.slice(), pave: [] });
        }
        if (op.kerb === true && !road)
          this.pendingKerbs.push({ cells: new Set(touched), material: op.material, seed, anchors, natural });
        break;
      }
      case "height": {
        let cells = this.shapeCells(op.shape, "terrain", path, op.id);
        if (
          this.gen.raggedTerrainEdges &&
          (op.edge ?? (this.level.base.type === "ground" ? "ragged" : "clean")) === "ragged"
        ) {
          // natural ground: a rounded, wandering outline (resolve/organic.ts)
          const tiers = organicTiers(
            cells,
            1,
            1,
            subSeed(elementSeed(this.plan.seed, op.id), "rim"),
            this.organicGrid(),
            true,
            this.growRing(cells),
          );
          cells = [...tiers].filter(([, t]) => t >= 1).map(([i]) => i);
        }
        const smooth = Math.max(0, Math.floor(op.smooth ?? 0));
        const dist = smooth > 0 ? this.innerDistance(cells) : null;
        for (const i of cells) {
          inShape++;
          if (!open(i)) continue;
          openCount++;
          const d = dist ? (dist.get(i) ?? 1) : smooth + 1;
          const factor = Math.min(1, d / (smooth + 1));
          const cur = this.height[i] as number;
          let next: number;
          if (op.set !== undefined) next = Math.round(cur + (Math.round(op.set * 4) - cur) * factor);
          else next = cur + Math.round((op.delta ?? 0) * 4 * factor);
          next = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(PLAN_LIMITS.maxHeight * 4, next));
          this.height[i] = next;
          if (next !== cur) touched.push(i);
        }
        break;
      }
    }
    return { touched, inShape, open: openCount, partial };
  }

  /**
   * Chasm op (§2.5): cuts open floor cells `depth` tiles down along a meandering course, optionally changes the
   * bottom's material, and queues its bridges for the bridge pass.
   */
  private applyChasm(op: Extract<TerrainOp, { op: "chasm" }>, path: string): void {
    const seed = elementSeed(this.plan.seed, op.id, op.seed);
    const clip = this.rasterClip();
    const wet0 = op.floor === "water_shallow" || op.floor === "water_deep";
    // a river channel crosses the map from one board edge to another (generator 2; still water keeps its course)
    const course =
      this.gen.riverCourses && wet0 && !STILL_WATER.test(op.id)
        ? this.keepOffHighGround(op.points, riverCourse(op.points, this.boardBox(), op.width))
        : op.points;
    const wander = this.gen.wanderingChannels;
    // generator 3: a long rift, chasm or river strays visibly from the line between its ends (a fifth of its length)
    const geo = chasmGeometry(
      course,
      op.width,
      op.meander ?? 0.5,
      seed,
      {
        x0: clip.x0,
        y0: clip.y0,
        x1: clip.x1,
        y1: clip.y1,
      },
      wander && op.meander !== 0 && !STILL_WATER.test(op.id)
        ? { wander: WANDER_SHARE, avoid: this.explicitFeatureCells() }
        : {},
    );
    const wet = op.floor === "water_shallow" || op.floor === "water_deep";
    if (wander && geo.samples.length > 16 && !STILL_WATER.test(op.id))
      this.channels.push({
        id: op.id,
        kind: wet ? "river" : "rift",
        centre: geo.samples.filter((_, k) => k % 2 === 0).map((s) => [s.x, s.y] as Vec2),
        widths: geo.widths.filter((_, k) => k % 2 === 0).map((w) => Math.round(w * 10) / 10),
      });
    // a water channel needs room for TaleSpire's board-wide water plane (an imprecise slider): a tile deep leaves half
    // a tile between "bed covered" and "banks flooded"
    const depthQ = Math.round((wet ? Math.max(1, op.depth ?? 1) : (op.depth ?? 3)) * 4);
    if (wet && op.depth !== undefined && op.depth < 1)
      this.issue(
        "warning",
        "water_level",
        `chasm "${op.id}" is a water channel only ${op.depth} deep; it is cut 1 tile deep`,
        {
          path,
          elementId: op.id,
          hint: "water in TaleSpire is a board-wide plane: a channel at least 1 tile deep keeps it in the channel and off the banks",
        },
      );
    const cut = new Set<number>();
    let outside = 0;
    // ledges part-way down (deep chasms): rim cells where a noise field is high stop at about half depth, keeping the
    // ground they were cut from, so the walls step down in places instead of dropping sheer everywhere
    const geoSet = new Set(geo.cells.map(([x, y]) => `${x},${y}`));
    const shelfNoise = new ValueNoise(subSeed(seed, "shelf"));
    const shelfQ = depthQ >= 8 ? 2 * Math.round(depthQ / 4) : 0;
    // generator 3: a river runs at one level. Its bed follows the channel's low side (a lower quartile of the ground it
    // crosses), so a bank it clips on a terrace is cut down to that bed instead of raising the board-wide water surface
    let lowSide = Infinity;
    // a river that drops 2 tiles or more is split into reaches at different levels with a fall between them
    let reaches: ReachPlan | null = null;
    if (wet && wander && !STILL_WATER.test(op.id)) {
      const grounds: number[] = [];
      const chan: ChannelCell[] = [];
      for (const [x, y] of geo.cells) {
        const i = this.idx(x, y);
        if (i >= 0 && this.state[i] === CELL.OPEN) {
          grounds.push(this.height[i] as number);
          chan.push({ i, x, y });
        }
      }
      grounds.sort((m, n) => m - n);
      if (grounds.length > 0) lowSide = grounds[Math.floor((grounds.length - 1) * 0.25)] as number;
      reaches = planReaches(geo.samples, chan, geo.widths, (x, y) => {
        const i = this.idx(x, y);
        return i >= 0 && this.state[i] === CELL.OPEN ? (this.height[i] as number) : null;
      });
    }
    for (const [x, y] of geo.cells) {
      const i = this.idx(x, y);
      if (i < 0) {
        outside++;
        continue;
      }
      if (this.state[i] !== CELL.OPEN) continue;
      const cur = this.height[i] as number;
      const rim = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ].some(([nx, ny]) => !geoSet.has(`${nx},${ny}`));
      if (shelfQ > 0 && rim && shelfNoise.sample(x / 3, y / 3) > 0.62) {
        this.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, cur - shelfQ);
        cut.add(i);
        continue;
      }
      const level = reaches ? (reaches.low[reaches.reachOf.get(i) ?? 0] ?? lowSide) : lowSide;
      this.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(cur, level) - depthQ);
      if (reaches && (reaches.reachOf.get(i) ?? 0) < reaches.low.length - 1) this.upperReach.add(i);
      if (op.floor === "none") {
        this.flags[i] =
          ((this.flags[i] as number) | CELL_FLAG.NO_FLOOR) & ~(CELL_FLAG.WATER | CELL_FLAG.PATH);
        this.mat[i] = 0;
      } else if (op.floor !== undefined) {
        this.setMaterial(i, op.floor);
        this.flags[i] = (this.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.PATH);
      }
      cut.add(i);
    }
    if (cut.size === 0) {
      this.issue(
        "warning",
        "no_effect",
        `chasm "${op.id}" cut nothing: its course crosses no open floor${outside > 0 ? " inside the level" : ""}`,
        {
          path,
          elementId: op.id,
          hint: "run it through an area (a chasm only cuts floor that an area or ground has opened); list it in the level's terrain, which is applied after the areas",
        },
      );
      return;
    }
    (op.bridges ?? []).forEach((b, k) => {
      const bid = `${op.id}~b${k + 1}`;
      const s = chasmSampleAt(geo, b.at ?? 0.5);
      if (!s) return;
      // bridges run square across the chasm: N–S where the chasm runs mostly E–W, else E–W
      let vertical = Math.abs(s.tx) >= Math.abs(s.ty);
      const px = Math.floor(s.x);
      const py = Math.floor(s.y);
      if (wander) {
        // generator 3: a bridge takes the shortest span across the cut, square to the channel there (a wandering rift
        // can run either way at its sample): measure the cut cells in a line along each axis through the sample
        const spanAlong = (vert: boolean): number => {
          let n = 0;
          for (const dir of [-1, 1])
            for (let step = 0; step < 64; step++) {
              const i = this.idx(vert ? px : px + dir * (step + 1), vert ? py + dir * (step + 1) : py);
              if (i < 0 || !cut.has(i)) break;
              n++;
            }
          return n;
        };
        const sv = spanAlong(true);
        const sh = spanAlong(false);
        if (sv !== sh) vertical = sv < sh;
      }
      const width = b.width ?? 2;
      const [lo, hi] = bandOffsets(width);
      const cells: number[] = [];
      for (let o = lo; o <= hi; o++) {
        const sx = vertical ? px + o : px;
        const sy = vertical ? py : py + o;
        const start = this.idx(sx, sy);
        if (start < 0 || !cut.has(start)) continue;
        cells.push(start);
        for (const dir of [-1, 1]) {
          for (let step = 1; step < 64; step++) {
            const i = this.idx(vertical ? sx : sx + dir * step, vertical ? sy + dir * step : sy);
            if (i < 0 || !cut.has(i)) break;
            cells.push(i);
          }
        }
      }
      if (cells.length === 0) {
        this.issue(
          "warning",
          "no_effect",
          `bridge ${k + 1} of chasm "${op.id}" found no chasm cell to span at at=${b.at ?? 0.5}`,
          {
            path: `${path}/bridges/${k}`,
            elementId: op.id,
            hint: "move it (at 0..1 along the chasm) to where the chasm crosses open floor",
          },
        );
        return;
      }
      this.bridgeReqs.push({
        id: bid,
        elementId: op.id,
        path: `${path}/bridges/${k}`,
        cells: [...new Set(cells)].sort((a, c) => a - c),
        floorMat: materialOrdinal(b.floor ?? "flagstone"),
        deck: null,
        railing: b.railing === "none" ? null : b.railing,
        broken: [],
        crumble: b.crumble ?? 0,
        seed: subSeed(seed, `bridge${k}`),
        axis: vertical ? "v" : "h",
        ...(b.span !== undefined ? { span: b.span } : {}),
        ...(b.arch !== undefined ? { arch: b.arch } : {}),
      });
    });
    if (reaches) this.cutFalls(op, geo, reaches, geoSet, depthQ);
  }

  /** Cells under the plan's own features (with a one-cell margin): a wandering channel keeps off them when it can. */
  private explicitFeatureCells(): Set<string> {
    const out = new Set<string>();
    for (const f of this.level.features) {
      const [w, h] = rotatedSize(f.size ?? featureInfo(f.type).size, f.rot ?? 0);
      for (let y = f.at[1] - 1; y <= f.at[1] + h; y++)
        for (let x = f.at[0] - 1; x <= f.at[0] + w; x++) out.add(`${x},${y}`);
    }
    return out;
  }

  /**
   * Falls of a stepped river (generator 3): a pool wider than the channel at the foot of each, the fall recorded on
   * the resolved level (position, direction, width, surfaces and beds, lip and pool cells).
   */
  private cutFalls(
    op: Extract<TerrainOp, { op: "chasm" }>,
    geo: ChasmGeometry,
    reaches: ReachPlan,
    geoSet: Set<string>,
    depthQ: number,
  ): void {
    const n = geo.samples.length;
    const nearBridge = new Set<number>();
    for (const req of this.bridgeReqs)
      if (req.elementId === op.id)
        for (const c of req.cells) {
          nearBridge.add(c);
          for (const j of this.neighbours4(c)) if (j >= 0) nearBridge.add(j);
        }
    const elev = this.level.elevation;
    reaches.falls.forEach((fall, f) => {
      const lowQ = reaches.low[f + 1] as number;
      const from = fall.boundary;
      const to = Math.min(n - 1, from + POOL_LENGTH);
      const pool = new Set<number>();
      for (const [i, fp] of reaches.flowOf)
        if (reaches.reachOf.get(i) === f + 1 && fp >= from && fp <= to) pool.add(i);
      for (let j = from; j <= to; j++) {
        const k = reaches.flow[j] as number;
        const s = geo.samples[k] as ChasmSample;
        // widest in the middle of the pool, a cell and a bit wider than the channel at least
        const mid = 1 - Math.abs(j - (from + to) / 2) / Math.max(1, (to - from) / 2);
        const hw = (geo.widths[k] as number) / 2 + 1 + 0.8 * mid;
        const r = Math.ceil(hw) + 1;
        for (let y = Math.floor(s.y) - r; y <= Math.floor(s.y) + r; y++)
          for (let x = Math.floor(s.x) - r; x <= Math.floor(s.x) + r; x++) {
            const dx = x + 0.5 - s.x;
            const dy = y + 0.5 - s.y;
            if (dx * dx + dy * dy > hw * hw || geoSet.has(`${x},${y}`)) continue;
            const i = this.idx(x, y);
            if (i < 0 || pool.has(i) || nearBridge.has(i) || this.state[i] !== CELL.OPEN) continue;
            const fl = this.flags[i] as number;
            if ((fl & (CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH | CELL_FLAG.BRIDGE)) !== 0) continue;
            if (this.areas[(this.struct[i] as number) - 1]?.kind === "building") continue;
            const cur = this.height[i] as number;
            // a bank much higher than the pool would leave a tall bare face, and a pool must not eat into the bank of
            // another reach where the course doubles back: keep both
            if (cur - lowQ > POOL_MAX_BANK_Q) continue;
            if (this.neighbours4(i).some((j) => j >= 0 && (reaches.reachOf.get(j) ?? f + 1) !== f + 1)) continue;
            this.height[i] = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(cur, lowQ) - depthQ);
            if (op.floor !== undefined && op.floor !== "none") this.setMaterial(i, op.floor);
            this.flags[i] = (this.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.PATH);
            pool.add(i);
          }
      }
      if (f + 1 < reaches.low.length - 1) for (const i of pool) this.upperReach.add(i);
      const upper = reaches.low[f] as number;
      this.falls.push({
        id: `${op.id}~fall${f + 1}`,
        river: op.id,
        at: fall.at,
        side: fall.side,
        width: fall.lip.length,
        top: elev + upper / 4,
        bottom: elev + lowQ / 4,
        bedTop: elev + (upper - depthQ) / 4 + 0.5,
        bedBottom: elev + (lowQ - depthQ) / 4 + 0.5,
        drop: (upper - lowQ) / 4,
        lip: fall.lip.map((i) => this.cellXY(i) as Vec2),
        pool: [...pool].sort((a, b) => a - b).map((i) => this.cellXY(i) as Vec2),
      });
    });
  }

  // ── structure ops (over layer): platform, stairs, uneven, outcrop ──

  /** A flight from cell `start` stepping by (dx,dy) through `cells` (in order): stair edges where heights differ. */
  private flight(cells: number[]): void {
    for (let k = 1; k < cells.length; k++) this.addStairEdge(cells[k - 1] as number, cells[k] as number);
  }

  private applyPlatform(op: Extract<TerrainOp, { op: "platform" }>, path: string): void {
    const cells = this.shapeCells(op.shape, "terrain", path, op.id).filter(
      (i) => this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.BRIDGE) === 0,
    );
    if (cells.length === 0) {
      this.issue(
        "warning",
        "no_effect",
        `platform "${op.id}" changed nothing: its shape covers no open floor`,
        {
          path,
          elementId: op.id,
          hint: "put it inside an area (a platform raises or sinks floor that an area has opened); list it after the areas",
        },
      );
      return;
    }
    // ragged (natural) contours: the distance to the edge wanders with noise, then tiers are relaxed so neighbours
    // never differ by more than one tier
    // generator 3: in a natural or cave level a platform is rock with a ragged outline unless the plan asks for worked
    // stone (a built material, or an explicit clean edge)
    const wild = this.gen.wildPlatforms && (this.level.base.type === "ground" || this.plan.kind === "cave");
    const worked = [op.material, op.topMaterial].some((m) => m !== undefined && !NATURAL_PATH.has(m));
    const rockDefault = wild && !worked && this.plan.kind === "cave" && op.material === undefined;
    const material: Material | undefined = rockDefault ? "rock" : op.material;
    const natural = material !== undefined && NATURAL_PATH.has(material);
    const ragged =
      this.gen.raggedTerrainEdges &&
      (op.edge ??
        ((this.level.base.type === "ground" && natural) || (wild && !worked) ? "ragged" : "clean")) ===
        "ragged";
    // natural hills default to few bold rises (two terraces 2.5 tiles apart, a few cells deep), not many small steps;
    // a dais or built terrace keeps the small defaults
    const bold = ragged && natural;
    let tiers = op.tiers ?? (bold ? 2 : 3);
    let riseQ = Math.round((op.rise ?? (bold ? 2.5 : 0.5)) * 4);
    let inset = op.inset ?? (bold ? 3 : 1);
    // generator 3: a gentle rise on natural ground reads as one rounded mound, not stacked half-tile plates with
    // square, stair-stepped outlines: fewer, larger steps (a tile or more each), outline rounded by the organic pass
    if (this.gen.roundedRises && ragged && natural && riseQ > 0 && riseQ < 4 && tiers > 1) {
      const total = tiers * riseQ;
      if (total >= 4) {
        tiers = Math.max(1, Math.floor(total / 4));
        riseQ = Math.round(total / tiers);
        inset = Math.max(inset, 3);
      }
    }
    // the level bounds do not count as an edge: a plateau against the map edge stays high there
    const dist = this.innerDistance(cells, true);
    const tierOf = new Map<number, number>();
    if (ragged) {
      // organic tiers: rounded, wandering, non-parallel outlines (resolve/organic.ts)
      const grow = this.growRing(cells);
      const org = organicTiers(
        cells,
        tiers,
        inset,
        subSeed(elementSeed(this.plan.seed, op.id), "contour"),
        this.organicGrid(),
        true,
        grow,
      );
      for (const i of grow) if ((org.get(i) ?? 0) >= 1) cells.push(i);
      for (const i of cells) tierOf.set(i, org.get(i) ?? 0);
    } else
      for (const i of cells) {
        const dn = dist.get(i) ?? 1;
        tierOf.set(i, Math.max(0, Math.min(tiers, Math.floor((dn - 1) / inset) + 1)));
      }
    if (ragged)
      for (let pass = 0; pass < 6; pass++)
        for (const i of cells)
          for (const j of this.neighbours4(i)) {
            const tj = j >= 0 ? tierOf.get(j) : undefined;
            if (tj !== undefined && (tierOf.get(i) as number) > tj + 1) tierOf.set(i, tj + 1);
          }
    for (const i of cells) {
      const t = tierOf.get(i) as number;
      if (t === 0) continue;
      this.height[i] = Math.max(
        PLAN_LIMITS.minHeight * 4,
        Math.min(PLAN_LIMITS.maxHeight * 4, (this.height[i] as number) + t * riseQ),
      );
      let m = t === tiers ? (op.topMaterial ?? material) : material;
      // generator 4: a top much paler than the room's floor (marble over flagstone) is a stark slab: it takes the tier's
      // own material, or the room's floor (resolve/interiorFloors.ts accentTop)
      if (m !== undefined && t === tiers && op.topMaterial !== undefined && this.gen.accentTops) {
        const ord = this.mat[i] as number;
        m = accentTop(m, ord > 0 ? MATERIALS[ord - 1] : undefined, material);
      }
      if (m !== undefined) this.setMaterial(i, m);
    }
    const top = Math.max(...tierOf.values());
    if (top < tiers)
      this.issue(
        "warning",
        "no_effect",
        `platform "${op.id}" only has room for ${top} of its ${tiers} tiers (the shape is too small for inset ${inset})`,
        { path, elementId: op.id, hint: "enlarge the shape, or lower tiers or inset" },
      );
    if (Math.abs(riseQ) > 4 && (op.stairs ?? []).length > 0)
      this.issue(
        "warning",
        "stairs_invalid",
        `platform "${op.id}" rises ${riseQ / 4} per tier: too steep for its stairs`,
        {
          path,
          elementId: op.id,
          hint: "use rise 1 or less per tier (0.5 reads as steps and is walkable everywhere)",
        },
      );
    // stairs: a 2-wide flight through the middle of each requested side, from outside the platform to the top tier
    const set = new Set(cells);
    const xy = cells.map((i) => this.cellXY(i));
    const x0 = Math.min(...xy.map((c) => c[0]));
    const x1 = Math.max(...xy.map((c) => c[0]));
    const y0 = Math.min(...xy.map((c) => c[1]));
    const y1 = Math.max(...xy.map((c) => c[1]));
    const cx = Math.floor((x0 + x1) / 2);
    const cy = Math.floor((y0 + y1) / 2);
    const [lo, hi] = bandOffsets(2);
    for (const side of op.stairs ?? []) {
      for (let o = lo; o <= hi; o++) {
        const seq: number[] = [];
        const vertical = side === "N" || side === "S";
        const step = side === "N" || side === "W" ? 1 : -1;
        let x = vertical ? cx + o : side === "W" ? x0 - 1 : x1 + 1;
        let y = vertical ? (side === "N" ? y0 - 1 : y1 + 1) : cy + o;
        for (let n = 0; n < 200; n++) {
          const i = this.idx(x, y);
          if (i >= 0 && (set.has(i) || seq.length === 0)) {
            if (set.has(i) || this.state[i] === CELL.OPEN) seq.push(i);
            if (set.has(i) && tierOf.get(i) === top) break;
          } else if (seq.length > 0) break;
          if (vertical) y += step;
          else x += step;
        }
        this.flight(seq);
      }
    }
  }

  /**
   * A rock ramp (generator 2): a band from `from` to `to` (any direction), `width` cells wide (3..6, default 4),
   * rising in half-tile steps from the low end's height to the high end's, floored with rock. Walkable everywhere
   * (no step over half a tile); a warning when it climbs faster than 1 tile per 2.5 cells.
   */
  private applyRamp(op: Extract<TerrainOp, { op: "stairs" }>, path: string): void {
    const a = this.idx(op.from[0], op.from[1]);
    const b = this.idx(op.to[0], op.to[1]);
    if (a < 0 || b < 0 || this.state[a] !== CELL.OPEN || this.state[b] !== CELL.OPEN) {
      this.issue("warning", "stairs_invalid", `ramp "${op.id}" needs open floor at both ends`, {
        path,
        elementId: op.id,
        hint: "start it on the low ground and end it on the high ground",
      });
      return;
    }
    const h0 = this.height[a] as number;
    const h1 = this.height[b] as number;
    const [fx, fy] = op.from;
    const [tx, ty] = op.to;
    const len = Math.hypot(tx - fx, ty - fy);
    if (len > 0 && Math.abs(h1 - h0) / 4 > len / 2.5)
      this.issue(
        "warning",
        "stairs_invalid",
        `ramp "${op.id}" climbs ${Math.abs(h1 - h0) / 4} tiles over ${Math.round(len)} cells: steeper than 1 tile per 2.5 cells`,
        {
          path,
          elementId: op.id,
          hint: `make it at least ${Math.ceil((Math.abs(h1 - h0) / 4) * 2.5)} cells long, diagonal to the cliff`,
        },
      );
    const width = Math.max(3, Math.min(6, op.width ?? 4));
    const cells: Vec2[] = [];
    forEachMaskCell(rasterPolyline([op.from, op.to], width, this.rasterClip()), (x, y) => {
      const i = this.idx(x, y);
      if (i < 0 || this.state[i] !== CELL.OPEN) return;
      if (((this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) !== 0) return;
      const t =
        len > 0 ? Math.max(0, Math.min(1, ((x - fx) * (tx - fx) + (y - fy) * (ty - fy)) / (len * len))) : 0;
      this.height[i] = h0 + 2 * Math.round(((h1 - h0) * t) / 2);
      this.setMaterial(i, "rock");
      cells.push([x, y]);
    });
    if (cells.length > 0) this.ramps.push({ id: op.id, cells, from: [fx, fy], to: [tx, ty] });
  }

  private applyStairsOp(op: Extract<TerrainOp, { op: "stairs" }>, path: string): void {
    if (op.style === "ramp" && this.gen.ramps) {
      this.applyRamp(op, path);
      return;
    }
    const [fx, fy] = op.from;
    const [tx, ty] = op.to;
    if (fx !== tx && fy !== ty) {
      this.issue("warning", "stairs_invalid", `stairs "${op.id}" must run along one row or column`, {
        path,
        elementId: op.id,
        hint: `use to: [${tx},${fy}] or [${fx},${ty}]`,
      });
      return;
    }
    const n = Math.abs(tx - fx) + Math.abs(ty - fy);
    const dx = Math.sign(tx - fx);
    const dy = Math.sign(ty - fy);
    const [lo, hi] = bandOffsets(op.width ?? 1);
    let placed = 0;
    for (let o = lo; o <= hi; o++) {
      const ox = dx === 0 ? o : 0;
      const oy = dx === 0 ? 0 : o;
      const a = this.idx(fx + ox, fy + oy);
      const b = this.idx(tx + ox, ty + oy);
      if (a < 0 || b < 0 || this.state[a] !== CELL.OPEN || this.state[b] !== CELL.OPEN || n === 0) continue;
      const h0 = this.deckHeightOf(a) ?? (this.height[a] as number);
      const h1 = this.deckHeightOf(b) ?? (this.height[b] as number);
      if (Math.abs(h1 - h0) > 4 * n) {
        this.issue(
          "warning",
          "stairs_invalid",
          `stairs "${op.id}" climb ${(h1 - h0) / 4} tiles over ${n} cell${n > 1 ? "s" : ""}: steeper than 1 tile per cell`,
          {
            path,
            elementId: op.id,
            hint: `start or end it further out: it needs at least ${Math.ceil(Math.abs(h1 - h0) / 4)} cells between from and to`,
          },
        );
      }
      const seq: number[] = [a];
      for (let k = 1; k < n; k++) {
        const i = this.idx(fx + ox + dx * k, fy + oy + dy * k);
        if (i < 0) break;
        if (this.state[i] !== CELL.OPEN) {
          this.state[i] = CELL.OPEN;
          this.mat[i] = this.mat[a] as number;
          this.struct[i] = this.struct[a] as number;
          this.disp[i] = this.disp[a] as number;
          this.theme[i] = this.theme[a] as number;
        }
        this.flags[i] = (this.flags[i] as number) & ~CELL_FLAG.NO_FLOOR;
        if (this.mat[i] === 0) this.mat[i] = this.mat[a] as number;
        this.height[i] = h0 + Math.round(((h1 - h0) * k) / n);
        seq.push(i);
      }
      seq.push(b);
      this.flight(seq);
      placed++;
    }
    if (placed === 0)
      this.issue(
        "warning",
        "no_effect",
        `stairs "${op.id}" changed nothing: from and to must both be open floor`,
        {
          path,
          elementId: op.id,
          hint: "put both ends on floor cells (the cells in between may be anything)",
        },
      );
  }

  private applyUneven(op: Extract<TerrainOp, { op: "uneven" }>, path: string): void {
    const region = op.shape
      ? this.shapeCells(op.shape, "terrain", path, op.id)
      : Array.from({ length: this.n }, (_, i) => i);
    const excluded = new Set<number>();
    for (const s of op.exclude ?? [])
      forEachMaskCell(rasterizeShape(s, { planSeed: this.plan.seed, clip: this.rasterClip() }), (x, y) => {
        const i = this.idx(x, y);
        if (i >= 0) excluded.add(i);
      });
    const cells = region.filter(
      (i) =>
        !excluded.has(i) &&
        this.state[i] === CELL.OPEN &&
        ((this.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE | CELL_FLAG.WATER)) === 0,
    );
    if (cells.length === 0) {
      this.issue(
        "warning",
        "no_effect",
        `uneven "${op.id}" changed nothing: no open dry floor in its shape`,
        {
          path,
          elementId: op.id,
          hint: "give it a shape inside an area, or shrink exclude",
        },
      );
      return;
    }
    const seed = elementSeed(this.plan.seed, op.id, op.seed);
    const noise = new ValueNoise(subSeed(seed, "uneven"));
    const scale = op.scale ?? 8;
    const amountQ = Math.round((op.amount ?? 0.5) * 4);
    const set = new Set(cells);
    // taper to nothing over 3 cells at the edge of the region, so it meets the floor around it smoothly
    const dist = this.innerDistance(cells);
    const delta = new Map<number, number>();
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      const taper = Math.min(1, ((dist.get(i) ?? 1) - 1) / 3);
      // whole half tiles: a quarter-tile step only reads as a crack in game (round 3); generator 2 rounds the band
      // outlines below so they read as gentle banks, not square stair-steps
      delta.set(i, 2 * Math.round((noise.sample(x / scale, y / scale) - 0.5) * amountQ * taper));
    }
    // generator 2: the band edges wander like an organic outline (no straight or square stair-steps)
    if (this.gen.organicBands) {
      const tiers = new Map<number, number>();
      for (const i of cells) tiers.set(i, Math.round((delta.get(i) as number) / 2));
      breakStraightSteps(tiers, this.organicGrid(), subSeed(seed, "bands"));
      chamferCorners(tiers, this.organicGrid());
      // generator 3: small lumps lose their square corners and their straight sides are bitten
      if (this.gen.roughenedLumps) roughenLumps(tiers, this.organicGrid(), subSeed(seed, "lumps"));
      for (const i of cells) delta.set(i, 2 * (tiers.get(i) ?? 0));
    }
    // walkable: neighbours in the region never differ by more than 2 quarters (relaxation, then applied)
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const i of cells) {
        let lo2 = -Infinity;
        let hi2 = Infinity;
        for (const j of this.neighbours4(i)) {
          if (j < 0 || !set.has(j)) continue;
          // an existing step (a cliff or a riser the plan built) stays as it is: smoothing across it would drag the
          // low ground up into a ramp that ends in a straight wall at the edge of the shape
          if (Math.abs((this.height[j] as number) - (this.height[i] as number)) > 2) continue;
          const base = (this.height[j] as number) + (delta.get(j) as number) - (this.height[i] as number);
          lo2 = Math.max(lo2, base - 2);
          hi2 = Math.min(hi2, base + 2);
        }
        const d = delta.get(i) as number;
        const c = Math.max(lo2, Math.min(hi2, d));
        if (Number.isFinite(c) && c !== d) {
          delta.set(i, Math.round(c));
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const i of cells) this.height[i] = (this.height[i] as number) + (delta.get(i) as number);
  }

  private applyOutcrop(op: Extract<TerrainOp, { op: "outcrop" }>, path: string): void {
    let n = 0;
    const riseQ = Math.round((op.height ?? 2) * 4);
    let cells = this.shapeCells(op.shape, "terrain", path, op.id).filter(
      (i) =>
        this.state[i] === CELL.OPEN &&
        ((this.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) === 0,
    );
    // generator 3: a small natural rise is not a rectangle: its corners are cut (twice on larger ones) and its sides
    // bitten. Only ever removes cells, so no route is closed that the shape did not already close.
    if (this.gen.roughenedLumps && cells.length >= 6) {
      const tiers = new Map<number, number>(cells.map((i) => [i, 1]));
      const lumpSeed = subSeed(elementSeed(this.plan.seed, op.id), "outcrop-lumps");
      roughenLumps(tiers, this.organicGrid(), lumpSeed);
      if (cells.length >= 30) roughenLumps(tiers, this.organicGrid(), subSeed(lumpSeed, "again"));
      const kept = cells.filter((i) => (tiers.get(i) ?? 0) > 0);
      if (kept.length >= Math.ceil(cells.length * 0.55)) cells = kept;
    }
    const dist = this.innerDistance(cells);
    const noise = new ValueNoise(subSeed(elementSeed(this.plan.seed, op.id), "outcrop"));
    const kept: number[] = [];
    let peak = 0;
    for (const i of cells) {
      const [x, y] = this.cellXY(i);
      const nz = noise.sample(x / 1.7, y / 1.7);
      const d = dist.get(i) ?? 1;
      // ragged edge: some rim cells stay floor; heights taper from the core to the rim and vary by ±0.5
      if (d === 1 && nz < 0.35 && cells.length > 4) continue;
      const taper = Math.min(1, (d + 0.5) / 2.5);
      const q = Math.max(2, 2 * Math.round((riseQ * taper + (nz - 0.5) * 4) / 2));
      this.height[i] = Math.min(PLAN_LIMITS.maxHeight * 4, (this.height[i] as number) + q);
      this.setMaterial(i, op.material ?? "rock");
      kept.push(i);
      peak = Math.max(peak, q);
      n++;
    }
    if (kept.length > 0)
      this.outcrops.push({
        id: op.id,
        cells: kept.sort((a, b) => a - b).map((i) => this.cellXY(i)),
        peak: peak / 4,
      });
    if (n === 0)
      this.issue(
        "warning",
        "no_effect",
        `outcrop "${op.id}" changed nothing: its shape covers no open floor`,
        {
          path,
          elementId: op.id,
          hint: "place it on open floor (inside an area, or on ground)",
        },
      );
  }

  /**
   * Generator 3: the floor_opening op. Open floor cells of the shape lose their floor but stay part of their area, so no
   * wall rings the hole (stepOpeningRims adds the low edge afterwards). A collapse is ragged: corners cut, sides bitten,
   * lobes bulging out where noise says so, never into a wall's cell.
   */
  private applyFloorOpening(op: Extract<TerrainOp, { op: "floor_opening" }>, path: string): void {
    if (!this.gen.floorOpenings) {
      this.issue(
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
      this.state[i] === CELL.OPEN &&
      ((this.flags[i] as number) & (CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE | CELL_FLAG.LINK | CELL_FLAG.STEPS)) === 0;
    let cells = this.shapeCells(op.shape, "terrain", path, op.id).filter(free);
    const seed = subSeed(elementSeed(this.plan.seed, op.id), "floor-opening");
    const outline = this.gen.openingOutline;
    if ((op.edge ?? (kind === "collapse" ? "ragged" : "clean")) === "ragged" && cells.length >= 6) {
      const tiers = new Map<number, number>(cells.map((i) => [i, 1]));
      roughenLumps(tiers, this.organicGrid(), seed);
      if (cells.length >= 20) roughenLumps(tiers, this.organicGrid(), subSeed(seed, "again"));
      let kept = cells.filter((i) => (tiers.get(i) ?? 0) > 0);
      if (kept.length >= 12) {
        const noise = new ValueNoise(subSeed(seed, "rim"));
        const dist = this.innerDistance(kept);
        kept = kept.filter((i) => {
          const [x, y] = this.cellXY(i);
          return !((dist.get(i) ?? 2) === 1 && noise.sample(x / outline.grain, y / outline.grain) < outline.cut);
        });
      }
      if (kept.length >= Math.ceil(cells.length * outline.keepShare)) {
        // lobes: open floor beside the hole, with open floor on every side of it (no wall or rock next to the new edge)
        const inSet = new Set(kept);
        const noise = new ValueNoise(subSeed(seed, "lobes"));
        for (const i of cells) {
          if (!inSet.has(i)) continue;
          const [x, y] = this.cellXY(i);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const j = this.idx(x + dx, y + dy);
            if (!free(j) || inSet.has(j) || noise.sample((x + dx) / 1.6, (y + dy) / 1.6) < outline.lobeCut) continue;
            const [jx, jy] = this.cellXY(j);
            const clear = (
              [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
            ).every(([ex, ey]) => free(this.idx(jx + ex, jy + ey)) && !this.hasWallAround(jx, jy));
            if (clear) inSet.add(j);
          }
        }
        cells = [...inSet].sort((a, b) => a - b);
      }
    }
    for (const i of cells) {
      this.flags[i] = ((this.flags[i] as number) | CELL_FLAG.NO_FLOOR) & ~(CELL_FLAG.WATER | CELL_FLAG.PATH);
      this.mat[i] = 0;
    }
    if (cells.length === 0) {
      this.issue("warning", "no_effect", `floor_opening "${op.id}" changed nothing: its shape covers no open floor`, {
        path,
        elementId: op.id,
        hint: "place it inside a room of this level (an opening only cuts floor that exists)",
      });
      return;
    }
    this.floorOpenings.push({
      id: op.id,
      kind,
      rim:
        op.rim ??
        (this.gen.lowOpeningRims
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
  private stepOpeningRims(): void {
    const low = this.gen.lowOpeningRims;
    for (const fo of this.floorOpenings) {
      const set = new Set(fo.cells);
      for (const i of fo.cells) {
        const [x, y] = this.cellXY(i);
        for (const side of ["N", "E", "S", "W"] as const) {
          const [dx, dy] = side === "N" ? [0, -1] : side === "S" ? [0, 1] : side === "E" ? [1, 0] : [-1, 0];
          const j = this.idx(x + dx, y + dy);
          if (j < 0 || this.state[j] !== CELL.OPEN || set.has(j)) continue;
          if (((this.flags[j] as number) & CELL_FLAG.NO_FLOOR) !== 0) continue;
          const ed = this.sideEdge(x, y, side);
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
          if (fo.kind === "collapse" && h32(`${fo.seed}:rim:${x}:${y}:${side}`) / 4294967296 < 0.4) continue;
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
   * Generator 3, after the links: what lies under each floor opening of this level (the next level down), a plan issue
   * when it is not open floor, and the rubble the lower level heaps under a collapse (placed with its generated features).
   */
  linkOpenings(below: LevelSteps | undefined): void {
    for (const fo of this.floorOpenings) {
      const xy = fo.cells.map((i) => this.cellXY(i) as Vec2);
      const path = `/levels/${this.li}/terrain`;
      if (!below) {
        this.issue("warning", "opening_no_floor_below", `floor opening "${fo.id}" has no level below it to look into`, {
          path,
          elementId: fo.id,
          hint: "add a level one storey (2.5) lower with a room under the opening, or use an area with floor none for an open pit",
        });
        continue;
      }
      fo.below = below.level.id;
      fo.floorBelow = xy.filter(([x, y]) => below.hasFloorAt(x, y)).length;
      if (fo.floorBelow < Math.ceil(xy.length * 0.6)) {
        const first = xy.find(([x, y]) => !below.hasFloorAt(x, y)) ?? xy[0];
        this.issue(
          "warning",
          "opening_no_floor_below",
          `floor opening "${fo.id}" on ${this.level.id}: only ${fo.floorBelow} of its ${xy.length} cells have open floor on ${below.level.id} under them (e.g. ${first?.[0]},${first?.[1]} is solid rock, void or another hole); you would look into rock`,
          {
            path,
            elementId: fo.id,
            ...(first ? { cell: first } : {}),
            hint: `put a room of ${below.level.id} under the opening (same x,y cells), or move the opening over the room below`,
          },
        );
      }
      if (fo.rubble) below.rubbleUnder.push({ id: fo.id, cells: xy, seed: fo.seed });
      if (fo.rubble && this.gen.rubbleMounds) below.moundUnder(xy, fo.seed);
    }
  }

  /**
   * Generator 4: the heap under a collapse is a mound, not a flat layer. Floor cells under the hole rise in half-tile
   * steps from the skirt (level) to a crown up to a tile high (rock surface), never beside a wall, a stair or a link, and
   * never more than half a tile between neighbours, so it can be walked. Runs before the features of the level so
   * everything standing in the heap rides on it.
   */
  private moundUnder(xy: Vec2[], seed: number): void {
    const wanted = new Set<number>();
    for (const [x, y] of xy) {
      const i = this.idx(x, y);
      if (i < 0 || !this.hasFloorAt(x, y)) continue;
      const f = this.flags[i] as number;
      if ((f & (CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.BRIDGE | CELL_FLAG.WATER | CELL_FLAG.STAIRWELL)) !== 0)
        continue;
      if (this.hasWallAround(x, y)) continue;
      wanted.add(i);
    }
    if (wanted.size < 6) return;
    const dist = this.innerDistance([...wanted]);
    const noise = new ValueNoise(subSeed(seed, "mound"));
    for (const i of wanted) {
      const d = dist.get(i) ?? 1;
      const [x, y] = this.cellXY(i);
      const lift = d <= 1 ? 0 : d === 2 ? 2 : noise.sample(x / 1.7, y / 1.7) < 0.35 ? 2 : 4;
      if (lift === 0) continue;
      this.height[i] = (this.height[i] as number) + lift;
      this.setMaterial(i, "rock");
    }
  }

  /**
   * Generator 4: low broken pieces dropped on the floor along the edge of a collapse: debris (nothing taller than half a
   * tile, never blocking) on most rim cells, thinning one cell further back. The hole itself stays open.
   */
  private stepOpeningRimDebris(): void {
    if (!this.gen.lowOpeningRims) return;
    for (const fo of this.floorOpenings) {
      if (fo.kind !== "collapse" || fo.rim !== "none" || fo.rimCells.length === 0) continue;
      const holes = new Set(fo.cells);
      const u = (i: number, k: string): number => h32(`${fo.seed}:rimdebris:${k}:${i}`) / 4294967296;
      const info = featureInfo("debris");
      const size = rotatedSize(info.size, 0);
      let n = 0;
      const drop = (i: number): void => {
        const c = this.cellXY(i) as Vec2;
        if (this.featureProblem("debris", c, size, undefined) !== null) return;
        const rf: ResolvedFeature = {
          id: `${fo.id}#rim${n++}`,
          type: "debris",
          generatedBy: fo.id,
          at: c,
          size,
          rot: 0,
          rotFine: (h32(`${fo.seed}:rimrot:${i}`) % 24) * 15,
          baseHeight: this.featureBase(i, 0),
          theme: this.themes[this.theme[i] as number] ?? this.levelTheme,
          blocking: info.blocking,
        };
        const ar = this.disp[i] as number;
        if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
        this.addFeatureCells(rf);
      };
      const rim = [...new Set(fo.rimCells)].sort((a, b) => a - b);
      const back = new Set<number>();
      for (const i of rim) {
        if (u(i, "on") < 0.75) drop(i);
        const [x, y] = this.cellXY(i);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const j = this.idx(x + dx, y + dy);
          if (j >= 0 && !holes.has(j) && !rim.includes(j) && this.hasFloorAt(x + dx, y + dy)) back.add(j);
        }
      }
      for (const j of [...back].sort((a, b) => a - b)) if (u(j, "back") < 0.22) drop(j);
    }
  }

  /**
   * Generator 4, rough interiors (level base solid, dungeon wall styles): rubble at the foot of the walls and either
   * side of about half the doorways, so the join of wall and floor is soft (about 1 pile per 10 floor tiles of a room,
   * the reference interior has 1.1). Low debris mostly; blocking rubble only in a corner or at a jamb of a room, never
   * in a corridor. Never on a link, steps, a doorway cell, a cell that holds a feature, or a collapse rim.
   */
  private stepWallFootRubble(): void {
    if (!this.gen.wallFootRubble || this.level.base.type !== "solid" || this.structs) return;
    const seed = elementSeed(this.plan.seed, `${this.level.id}~footrubble`, undefined);
    const u = (k: string, i: number): number => h32(`${seed}:${k}:${i}`) / 4294967296;
    const roughSide = (x: number, y: number, s: Side): boolean => {
      const se = this.sideEdge(x, y, s);
      return se !== null && se.e.kind[se.i] === EDGE.WALL && isUnevenWallStyle(se.e.style[se.i]);
    };
    const sides: Side[] = ["N", "E", "S", "W"];
    const plain = (i: number): boolean => {
      if (i < 0 || this.state[i] !== CELL.OPEN || (this.occ[i] as number) > 0) return false;
      const f = this.flags[i] as number;
      if (f & (CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.FEATURE | CELL_FLAG.STAIRWELL | CELL_FLAG.BRIDGE | CELL_FLAG.WATER))
        return false;
      // only a rough interior has rubble at the wall foot: not a kept-up timber or plaster room (unless abandoned), and
      // not a cell outside every room (the same rule the compiler reads back, resolve/wallTops.ts roughCells)
      const ar = this.disp[i] as number;
      if (ar <= 0 || !(this.areas[ar - 1] as AreaInfo).rough) return false;
      const [x, y] = this.cellXY(i);
      for (const s of sides) {
        const k = this.edgeKindAt(x, y, s);
        if (k === EDGE.OPENING || k === EDGE.STAIR) return false;
      }
      return true;
    };
    const rims = new Set<number>();
    for (const fo of this.floorOpenings) for (const c of fo.rimCells) rims.add(c);
    const info = { debris: featureInfo("debris"), rubble: featureInfo("rubble") };
    const placed = new Set<number>();
    let n = 0;
    const put = (i: number, type: "debris" | "rubble"): boolean => {
      if (placed.has(i) || rims.has(i) || !plain(i)) return false;
      const [x, y] = this.cellXY(i);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (placed.has(this.idx(x + dx, y + dy))) return false;
      const size = rotatedSize(info[type].size, 0);
      const c: Vec2 = [x, y];
      if (this.featureProblem(type, c, size, undefined) !== null) return false;
      const rf: ResolvedFeature = {
        id: `walls#foot${n++}`,
        type,
        generatedBy: "walls",
        at: c,
        size,
        rot: 0,
        rotFine: (h32(`${seed}:rot:${i}`) % 24) * 15,
        baseHeight: this.featureBase(i, 0),
        theme: this.themes[this.theme[i] as number] ?? this.levelTheme,
        blocking: info[type].blocking,
      };
      const ar = this.disp[i] as number;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      this.addFeatureCells(rf);
      placed.add(i);
      return true;
    };
    const inCorridor = (i: number): boolean => {
      const s = this.struct[i] as number;
      return s > 0 && (this.areas[s - 1] as AreaInfo).kind === "corridor";
    };
    // the foot of the walls
    for (let i = 0; i < this.n; i++) {
      if (!plain(i)) continue;
      const [x, y] = this.cellXY(i);
      const walls = sides.filter((s) => roughSide(x, y, s)).length;
      if (walls === 0) continue;
      const p = walls >= 2 ? 0.5 : 0.28;
      if (u("foot", i) >= p) continue;
      const block = walls >= 2 && !inCorridor(i) && u("blk", i) < 0.35;
      put(i, block ? "rubble" : "debris");
    }
    // either side of about half the doorways: the cells flanking the opening along its wall
    this.openings.forEach((op, k) => {
      if (op.kind === "open" || u("jamb", k + 7919) >= 0.5) return;
      const [sx, sy] = op.start;
      const flank: Vec2[] =
        op.orientation === "h"
          ? [[sx - 1, sy - 1], [sx - 1, sy], [sx + op.width, sy - 1], [sx + op.width, sy]]
          : [[sx - 1, sy - 1], [sx, sy - 1], [sx - 1, sy + op.width], [sx, sy + op.width]];
      const picks = flank
        .map((c, j) => ({ c, j, r: u("jc", k * 4 + j) }))
        .filter(({ c, j }) => {
          // the cell must stand against the wall the opening is in: even flanks lie north (west) of the line, so the wall is on their S (E) side
          const side: Side = op.orientation === "h" ? (j % 2 === 0 ? "S" : "N") : j % 2 === 0 ? "E" : "W";
          return roughSide(c[0], c[1], side);
        })
        .sort((a, b) => a.r - b.r)
        .slice(0, 2);
      for (const { c, j } of picks) {
        const i = this.idx(c[0], c[1]);
        if (i < 0) continue;
        put(i, !inCorridor(i) && j % 2 === 0 ? "rubble" : "debris");
      }
    });
  }

  /** Generator 3: rubble heaped on the floor under a collapse of the level above: densest and biggest at the centre. */
  private stepOpeningRubble(): void {
    for (const r of this.rubbleUnder) {
      const cells = r.cells.filter(([x, y]) => this.hasFloorAt(x, y));
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
        if (this.featureProblem(type, c, size, undefined) !== null) return false;
        const anchor = this.idx(c[0], c[1]);
        const rf: ResolvedFeature = {
          id: `${r.id}#rubble${n++}`,
          type,
          generatedBy: r.id,
          at: c,
          size,
          rot: 0,
          rotFine: (h32(`${r.seed}:rot:${c[0]}:${c[1]}`) % 24) * 15,
          baseHeight: this.featureBase(anchor, 0),
          theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
          blocking: info.blocking,
        };
        const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
        if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
        this.addFeatureCells(rf);
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

  /**
   * After the building pads are flattened: the cells between a pavement and a building face (the wall ring the pad
   * flattened, a 1-cell setback) take the pavement's height and material, so no strip at road level runs along a
   * frontage. Footprints, porches, stair and link cells and anything higher than the pavement (a plinth) keep theirs.
   */
  private stepPavementFronts(): void {
    if (!this.gen.roads || !this.structs) return;
    type Road =(typeof this.pendingRoads)[number];
    const owner = new Map<number, Road>();
    for (const r of this.pendingRoads) for (const p of r.pave) owner.set(p.i, r);
    if (owner.size === 0) return;
    const footprint = this.structs.occupied();
    const keep = new Set<string>(footprint.keys());
    for (const b of this.structs.buildings)
      for (const p of b.porches) for (const c of p.cells) keep.add(`${c[0]},${c[1]}`);
    const nearFootprint = (x: number, y: number): boolean => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (footprint.has(`${x + dx},${y + dy}`)) return true;
      return false;
    };
    const carriage = new Set<number>();
    for (const r of this.pendingRoads) for (const i of r.cells) carriage.add(i);
    const add: Array<{ i: number; h: number; r: Road }> = [];
    for (let i = 0; i < this.state.length; i++) {
      if (owner.has(i) || carriage.has(i) || this.state[i] !== CELL.OPEN) continue;
      const [x, y] = this.cellXY(i);
      if (keep.has(`${x},${y}`) || !nearFootprint(x, y)) continue;
      const f = this.flags[i] as number;
      if (
        (f & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS)) !==
        0
      )
        continue;
      // the highest pavement beside it (a pavement height is current only while the cell still holds it)
      let best: { h: number; r: Road } | null = null;
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const j = this.idx(x + dx, y + dy);
        const r = j >= 0 ? owner.get(j) : undefined;
        if (!r || j < 0) continue;
        const h = this.height[j] as number;
        if (r.pave.some((p) => p.i === j && p.h === h) && (!best || h > best.h)) best = { h, r };
      }
      // (a building pad now stands level with the pavement: an equal-height ring cell is paved too)
      if (!best || (this.height[i] as number) > best.h) continue;
      add.push({ i, h: best.h, r: best.r });
    }
    for (const { i, h, r } of add) {
      const sw = r.op.sidewalk;
      if (!sw) continue;
      this.setMaterial(i, sw.material);
      this.height[i] = h;
      r.pave.push({ i, h });
    }
  }

  /** Lays the pavements of this layer's roads: beside the carriageway, never on any road's carriageway or a building. */
  private stepPavements(layer: "under" | "over"): void {
    if (!this.gen.roads) return;
    const carriage = new Set<number>();
    for (const r of this.pendingRoads) for (const i of r.cells) carriage.add(i);
    const paved = new Set<number>();
    for (const r of this.pendingRoads) for (const p of r.pave) paved.add(p.i);
    const lots = this.structs?.occupied();
    for (const r of this.pendingRoads) {
      const sw = r.op.sidewalk;
      if (r.layer !== layer || !sw) continue;
      const raise = Math.round((sw.raise ?? 0.25) * 4);
      // a building's lot: its footprint and the ring of cells around it (its walls and pad)
      const inLot = (x: number, y: number): boolean => {
        const i = this.idx(x, y);
        return (
          i >= 0 &&
          (lots?.has(`${x},${y}`) === true || this.areas[(this.struct[i] as number) - 1]?.kind === "building")
        );
      };
      const lot = (x: number, y: number): boolean => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) if (inLot(x + dx, y + dy)) return true;
        return false;
      };
      const lay = (x: number, y: number): void => {
        const i = this.idx(x, y);
        if (i < 0 || carriage.has(i) || paved.has(i) || this.state[i] !== CELL.OPEN) return;
        if (((this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.NO_FLOOR)) !== 0)
          return;
        if (lot(x, y)) return;
        this.setMaterial(i, sw.material);
        const h = (this.height[i] as number) + raise;
        this.height[i] = h;
        paved.add(i);
        r.pave.push({ i, h });
      };
      forEachMaskCell(rasterPolyline(r.axis, r.op.width + 2 * sw.width, this.rasterClip()), lay);
      // the pavement runs on up to a building front that stands up to three cells beyond it (its wall ring included):
      // no strip of bare ground between the pavement and the lot
      for (const { i } of r.pave.slice()) {
        const [x, y] = this.cellXY(i);
        for (const [dx, dy] of [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ] as const) {
          for (let k = 1; k <= 3; k++) {
            const j = this.idx(x + dx * k, y + dy * k);
            if (j < 0 || carriage.has(j)) break;
            if (lot(x + dx * k, y + dy * k)) {
              for (let q = 1; q < k; q++) lay(x + dx * q, y + dy * q);
              break;
            }
          }
        }
      }
    }
  }

  /** Road records and their kerbs (after the edges): continuous kerb lines, gaps at crossings and junction mouths. */
  private stepRoads(): void {
    if (this.pendingRoads.length === 0) return;
    const k = (i: number): string => {
      const [x, y] = this.cellXY(i);
      return `${x},${y}`;
    };
    const carriage = new Set<string>();
    const claimed = new Set<number>();
    const pavedAll = new Set<string>();
    const crossingAll = new Set<string>();
    const recs = this.pendingRoads.map((r) => {
      const carriageway = r.cells.filter((i) => !claimed.has(i) && this.isFloor(i));
      for (const i of carriageway) claimed.add(i);
      for (const i of r.cells) carriage.add(k(i));
      // a pavement cell a building pad (or a later op) changed is no longer pavement
      const sw = r.op.sidewalk;
      const pave = r.pave
        .filter(
          (p) =>
            this.isFloor(p.i) &&
            this.height[p.i] === p.h &&
            sw &&
            this.mat[p.i] === materialOrdinal(sw.material),
        )
        .map((p) => p.i);
      for (const i of pave) pavedAll.add(k(i));
      const cw = carriageway.map((i) => this.cellXY(i) as Vec2);
      const crossings = crossingCells(r.axis, cw, r.op.crossings ?? []);
      for (const c of crossings) for (const [x, y] of c.cells) crossingAll.add(`${x},${y}`);
      return { r, carriageway, cw, pave, crossings };
    });
    for (const { r, carriageway, cw, pave, crossings } of recs) {
      const sw = r.op.sidewalk;
      const pv = pave.map((i) => this.cellXY(i) as Vec2);
      const { kerbLines, corners } = kerbLinesAndCorners(pv, carriage, crossingAll, pavedAll);
      this.roads.push({
        id: r.op.id,
        axis: r.axis.map((p) => [p[0], p[1]] as Vec2),
        width: r.op.width,
        carriageway: cw,
        pavement: pv,
        pavementMaterial: sw?.material ?? null,
        pavementRaise: sw ? Math.round((sw.raise ?? 0.25) * 4) : 0,
        kerbLines,
        corners,
        crossings,
      });
      // kerb pieces: on by default with a sidewalk; along every carriageway edge that meets pavement (or, without a
      // sidewalk, any other floor), never on a crossing nor across a junction mouth
      if (r.op.kerb === false || (r.op.kerb !== true && !sw)) continue;
      for (const i of carriageway) {
        const [x, y] = this.cellXY(i);
        if (crossingAll.has(`${x},${y}`)) continue;
        for (const side of ["N", "E", "S", "W"] as const) {
          const [nx, ny] =
            side === "N" ? [x, y - 1] : side === "S" ? [x, y + 1] : side === "E" ? [x + 1, y] : [x - 1, y];
          const j = this.idx(nx, ny);
          if (j < 0 || carriage.has(`${nx},${ny}`) || !this.isFloor(j)) continue;
          if (sw && !pavedAll.has(`${nx},${ny}`)) continue;
          if (Math.abs((this.height[j] as number) - (this.height[i] as number)) > 2) continue;
          const ed = this.sideEdge(x, y, side);
          if (!ed || (ed.e.kind[ed.i] !== EDGE.NONE && ed.e.kind[ed.i] !== EDGE.LEDGE)) continue;
          this.kerbs.push({ at: [x, y], side, material: sw?.material ?? r.op.material });
        }
      }
    }
  }

  /** Cells of `connect` (area anchors, feature cells, explicit cells) joined by L-shaped legs. */
  private connectPoints(
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
      const ai = this.areaIndexById.get(c);
      // an under-layer path runs before the areas claim cells: fall back to the area's own shape
      const info = ai !== undefined ? this.areas[ai] : undefined;
      const cell =
        ai !== undefined && info
          ? (this.anchorOf(this.areaCells(ai)) ??
            (info.isRoute
              ? null
              : this.anchorOf(
                  rasterCellsOf(
                    rasterizeShape(info.area.shape, { planSeed: this.plan.seed, clip: this.rasterClip() }),
                    (x, y) => this.idx(x, y),
                  ),
                )))
          : null;
      const feat = this.level.features.find((f) => f.id === c);
      const p = cell ?? (feat ? feat.at : null);
      if (p) at.push(p);
      else
        this.issue("warning", "ref_unknown", `path "${id}" connects to unknown "${c}"`, {
          path: `${path}/connect`,
          elementId: id,
          hint: `use area ids or feature ids on ${this.level.id}, or [x,y] cells`,
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

  /** Kerbs along kerbed paths: every edge of a path cell that meets non-path floor at (about) the same height. */
  private stepKerbs(): void {
    for (const k of this.pendingKerbs) {
      const noise = new ValueNoise(subSeed(k.seed, "kerb"));
      const nearAnchor = (x: number, y: number): boolean =>
        k.anchors.some(([ax, ay]) => Math.max(Math.abs(ax - x), Math.abs(ay - y)) <= 2);
      const before = this.kerbs.length;
      for (const i of k.cells) {
        if (!this.isFloor(i) || ((this.flags[i] as number) & CELL_FLAG.PATH) === 0) continue;
        const [x, y] = this.cellXY(i);
        for (const side of ["N", "E", "S", "W"] as const) {
          const [nx, ny] =
            side === "N" ? [x, y - 1] : side === "S" ? [x, y + 1] : side === "E" ? [x + 1, y] : [x - 1, y];
          const j = this.idx(nx, ny);
          if (j < 0 || k.cells.has(j) || !this.isFloor(j)) continue;
          if (Math.abs((this.height[j] as number) - (this.height[i] as number)) > 1) continue;
          const ed = this.sideEdge(x, y, side);
          if (!ed || ed.e.kind[ed.i] !== EDGE.NONE) continue;
          if (this.gen.naturalPaths && k.natural) {
            // broken runs (about 40% of the edge), none at junctions or where the path meets what it joins
            if (nearAnchor(x, y)) continue;
            const off = side === "N" ? 0.3 : side === "S" ? 0.6 : side === "E" ? 0.9 : 0.1;
            if (noise.sample(x / 2.5 + off, y / 2.5 + off) < 0.58) continue;
          }
          this.kerbs.push({ at: [x, y], side, material: k.material });
        }
      }
      if (this.gen.naturalPaths && k.natural) {
        // never both sides of the same cell (that reads as a rail); keep the one on the noisier side
        const added = this.kerbs.splice(before);
        const byCell = new Map<string, Array<(typeof added)[number]>>();
        for (const kb of added) {
          const key = `${kb.at[0]},${kb.at[1]}`;
          byCell.set(key, [...(byCell.get(key) ?? []), kb]);
        }
        for (const list of byCell.values()) {
          const ns = list.some((q) => q.side === "N") && list.some((q) => q.side === "S");
          const ew = list.some((q) => q.side === "E") && list.some((q) => q.side === "W");
          const drop = new Set<string>();
          const at = list[0]?.at ?? [0, 0];
          const h = h32(`${k.seed}:${at[0]},${at[1]}`) % 2;
          if (ns) drop.add(h === 0 ? "N" : "S");
          if (ew) drop.add(h === 0 ? "E" : "W");
          for (const q of list) if (!drop.has(q.side)) this.kerbs.push(q);
        }
      }
    }
  }

  // ── bridges (after the over-layer terrain, before the edges) ──

  /**
   * Bridge pass: every bridge (areas of kind "bridge" in area order, then chasm bridges in op order) records what
   * lies under its cells, then lays the deck: height = explicit floorHeight or the highest floor it touches, its own
   * floor material, CELL_FLAG.BRIDGE, no walls toward open cells. Broken and crumbled cells become holes.
   */
  private stepBridges(): void {
    const reqs: BridgeRequest[] = [];
    for (const info of this.areas) {
      if (!info.isBridge) continue;
      const cells = this.areaCells(info.index);
      if (cells.length === 0) continue;
      const a = info.area;
      const broken: number[] = [];
      (a.broken ?? []).forEach((c, k) => {
        const i = this.idx(c[0], c[1]);
        if (i >= 0 && this.struct[i] === info.index + 1) broken.push(i);
        else
          this.issue(
            "warning",
            "no_effect",
            `broken cell ${c[0]},${c[1]} of bridge "${a.id}" is not part of the bridge`,
            {
              path: `/levels/${this.li}/areas/${info.index}/broken/${k}`,
              elementId: a.id,
              cell: c,
              hint: "list only cells of the bridge's own shape",
            },
          );
      });
      const req: BridgeRequest = {
        id: a.id,
        elementId: a.id,
        path: `/levels/${this.li}/areas/${info.index}`,
        cells,
        floorMat: info.floorNone ? materialOrdinal("flagstone") : info.floorMat,
        deck: a.floorHeight !== undefined ? Math.round(a.floorHeight * 4) : null,
        railing: a.railing === "none" ? null : a.railing,
        broken,
        crumble: a.crumble ?? 0,
        seed: subSeed(elementSeed(this.plan.seed, a.id), "crumble"),
        ...(a.span !== undefined ? { span: a.span } : {}),
        ...(a.arch !== undefined ? { arch: a.arch } : {}),
      };
      if (a.name !== undefined) req.label = a.name;
      reqs.push(req);
    }
    reqs.push(...this.bridgeReqs);
    // raised decks (explicit height) first, so spans that climb to them meet their real height
    const ordered = [...reqs.filter((r) => r.deck !== null), ...reqs.filter((r) => r.deck === null)];
    for (const r of ordered) this.layBridge(r);
    for (const check of this.deckChecks) check();
  }

  private layBridge(r: BridgeRequest): void {
    const k = this.bridges.length + 1;
    const cells = r.cells.filter((i) => this.bridgeOf[i] === 0);
    if (cells.length === 0) return;
    const inThis = new Set(cells);
    // deck height: explicit, else the highest open floor it touches (its ends)
    let touch = -Infinity;
    for (const i of cells) {
      for (const j of this.neighbours4(i)) {
        if (j < 0 || inThis.has(j) || this.state[j] !== CELL.OPEN) continue;
        if ((this.flags[j] as number) & CELL_FLAG.NO_FLOOR) continue;
        touch = Math.max(touch, this.height[j] as number);
      }
    }
    let deck =
      r.deck ?? (Number.isFinite(touch) ? touch : Math.max(...cells.map((i) => this.height[i] as number)));
    deck = Math.max(PLAN_LIMITS.minHeight * 4, Math.min(PLAN_LIMITS.maxHeight * 4, deck));
    // anchor cells: deck cells next to walkable floor within a 0.5 step of the deck (where you get on and off)
    const anchorCells: number[] = [];
    for (const i of cells) {
      const ok = this.neighbours4(i).some(
        (j) =>
          j >= 0 &&
          !inThis.has(j) &&
          this.state[j] === CELL.OPEN &&
          ((this.flags[j] as number) & CELL_FLAG.NO_FLOOR) === 0 &&
          Math.abs((this.height[j] as number) - deck) <= 2,
      );
      if (ok) anchorCells.push(i);
    }
    // anchored at both ends = the anchors form at least two groups that are far apart (not one side of a pier)
    const under: number[] = [];
    const underMaterial: ResolvedBridge["underMaterial"] = [];
    for (const i of cells) {
      under.push(this.height[i] as number);
      const noFloor = ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) !== 0 || this.state[i] !== CELL.OPEN;
      const m = this.mat[i] as number;
      underMaterial.push(noFloor || m === 0 ? null : (MATERIALS[m - 1] as Material));
    }
    // span: arched / sagging deck along its axis, in 0.25 steps no more than 0.5 apart (walkable)
    const deckMat = MATERIALS[r.floorMat - 1] as Material;
    const span: BridgeSpan =
      r.span ?? (WOOD_DECKS.has(deckMat) ? "plank" : NATURAL_DECKS.has(deckMat) ? "natural" : "arch");
    const cxy = cells.map((i) => this.cellXY(i));
    const bx0 = Math.min(...cxy.map((c) => c[0]));
    const bx1 = Math.max(...cxy.map((c) => c[0]));
    const by0 = Math.min(...cxy.map((c) => c[1]));
    const by1 = Math.max(...cxy.map((c) => c[1]));
    const axis = r.axis ?? (bx1 - bx0 >= by1 - by0 ? "h" : "v");
    const p0 = axis === "h" ? bx0 : by0;
    const len = (axis === "h" ? bx1 - bx0 : by1 - by0) + 1;
    const along = (i: number): number => {
      const [x, y] = this.cellXY(i);
      return (axis === "h" ? x : y) - p0;
    };
    // the floor beyond each end of the deck (along its axis): an inclined span joins two different heights
    const endHeight = (p: number, step: -1 | 1): number | null => {
      let best: number | null = null;
      for (const i of cells) {
        if (along(i) !== p) continue;
        const [x, y] = this.cellXY(i);
        const j = axis === "h" ? this.idx(x + step, y) : this.idx(x, y + step);
        if (j < 0 || inThis.has(j) || !this.isFloor(j)) continue;
        // a raised deck at the far end counts at its deck height, even before it is laid
        best = Math.max(
          best ?? -Infinity,
          this.bridgeOf[j] === 0
            ? (this.deckHeightOf(j) ?? (this.height[j] as number))
            : (this.height[j] as number),
        );
      }
      return best;
    };
    const h0 = endHeight(0, -1);
    const h1 = endHeight(len - 1, 1);
    const inclined = r.deck === null && h0 !== null && h1 !== null && h0 !== h1;
    const prof: number[] = [];
    if (inclined) {
      // inclined span: the deck climbs evenly from one end's floor to the other's; steps over 0.5 become stairs
      deck = h0;
      for (let p = 0; p < len; p++) prof.push(Math.round(((h1 - h0) * (len > 1 ? p + 1 : 1)) / (len + 1)));
    } else {
      const archQ = r.arch !== undefined ? Math.round(r.arch * 4) : len >= 4 ? SPAN_ARCH_Q[span] : 0;
      for (let p = 0; p < len; p++) {
        const t = len > 1 ? p / (len - 1) : 0.5;
        const u = 2 * t - 1;
        prof.push(Math.round(archQ * (1 - u * u)));
      }
      for (let pass = 0; pass < len; pass++)
        for (let p = 1; p < len; p++) {
          const a = prof[p - 1] as number;
          const b = prof[p] as number;
          if (b - a > 2) prof[p] = a + 2;
          if (a - b > 2) prof[p - 1] = b + 2;
        }
    }
    for (const i of cells) {
      this.state[i] = CELL.OPEN;
      this.height[i] = deck + (prof[along(i)] ?? 0);
      this.mat[i] = r.floorMat;
      this.flags[i] =
        ((this.flags[i] as number) & ~(CELL_FLAG.NO_FLOOR | CELL_FLAG.WATER | CELL_FLAG.PATH)) |
        CELL_FLAG.BRIDGE;
      this.bridgeOf[i] = k;
    }
    if (inclined) {
      const stepQ = Math.abs(h1 - h0) / (len + 1);
      if (stepQ > 4)
        this.issue(
          "warning",
          "stairs_invalid",
          `bridge "${r.id}" climbs ${stepQ / 4} tiles per cell: steeper than a stair`,
          {
            path: r.path,
            elementId: r.elementId,
            hint: "make the span longer, or meet a lower point of the higher floor",
          },
        );
      // stair edges on the deck (and onto the floors at its ends) wherever a step is more than 0.5
      for (const i of cells)
        for (const j of this.neighbours4(i)) {
          if (j < 0 || !this.isFloor(j)) continue;
          const [ix, iy] = this.cellXY(i);
          const [jx, jy] = this.cellXY(j);
          if (axis === "h" ? jy !== iy : jx !== ix) continue; // only along the span
          if (Math.abs((this.height[j] as number) - (this.height[i] as number)) > 2) this.addStairEdge(i, j);
        }
      // anchors are where the deck meets floor at its own height or one step from it
      anchorCells.splice(0, anchorCells.length);
      for (const i of cells) {
        const ok = this.neighbours4(i).some(
          (j) =>
            j >= 0 &&
            !inThis.has(j) &&
            this.isFloor(j) &&
            (Math.abs((this.height[j] as number) - (this.height[i] as number)) <= 4 ||
              this.stairEdges.has(i < j ? `${i},${j}` : `${j},${i}`)),
        );
        if (ok) anchorCells.push(i);
      }
    }
    // broken cells: explicit, then crumble (seeded, never cutting the way between the anchors)
    const broken = new Set<number>(r.broken.filter((i) => inThis.has(i)));
    const anchorSet = new Set(anchorCells);
    const connected = (): boolean => {
      const live = anchorCells.filter((i) => !broken.has(i));
      if (live.length <= 1) return true;
      const seen = new Set<number>([live[0] as number]);
      const q = [live[0] as number];
      while (q.length > 0) {
        const i = q.pop() as number;
        for (const j of this.neighbours4(i))
          if (j >= 0 && inThis.has(j) && !broken.has(j) && !seen.has(j)) {
            seen.add(j);
            q.push(j);
          }
      }
      return live.every((i) => seen.has(i));
    };
    const target = Math.round(Math.min(0.6, Math.max(0, r.crumble)) * cells.length);
    if (target > 0) {
      const rng = createPrng(r.seed);
      // outer cells (next to the drop) crumble first, then the rest
      const outer = cells.filter(
        (i) => !anchorSet.has(i) && this.neighbours4(i).some((j) => j < 0 || !inThis.has(j)),
      );
      const inner = cells.filter((i) => !anchorSet.has(i) && !outer.includes(i));
      let n = 0;
      for (const i of [...rng.shuffle(outer), ...rng.shuffle(inner)]) {
        if (n >= target) break;
        if (broken.has(i)) continue;
        broken.add(i);
        if (connected()) n++;
        else broken.delete(i);
      }
    }
    for (const i of broken) {
      this.flags[i] = (this.flags[i] as number) | CELL_FLAG.NO_FLOOR;
      this.mat[i] = 0;
    }
    const sorted = cells.map((i, j) => ({ i, j })).sort((a, b) => a.i - b.i);
    // piers: arch and flat spans of 5+ cells stand on stone piers at a third and two thirds of the way across
    const piers: Vec2[] = [];
    // a raised deck on supports (watchtower, gallows, scaffold, pier): explicit height, a tile or more above the
    // ground beneath it: posts at its corners
    if (r.deck !== null) {
      const corners = new Set([
        this.idx(bx0, by0),
        this.idx(bx1, by0),
        this.idx(bx0, by1),
        this.idx(bx1, by1),
      ]);
      sorted.forEach(({ i, j }) => {
        if (corners.has(i) && underMaterial[j] !== null && deck - (under[j] as number) >= 4 && !broken.has(i))
          piers.push(this.cellXY(i));
      });
    } else if ((span === "arch" || span === "flat") && len >= 5) {
      const at = new Set([Math.round((len - 1) / 3), Math.round((2 * (len - 1)) / 3)]);
      sorted.forEach(({ i, j }) => {
        if (at.has(along(i)) && underMaterial[j] !== null && !broken.has(i)) piers.push(this.cellXY(i));
      });
    }
    // a crumbling bridge sheds rubble at its ends
    if (r.crumble > 0) {
      const rng = createPrng(subSeed(r.seed, "rubble"));
      const spots: Vec2[] = [];
      for (const i of anchorCells)
        for (const j of this.neighbours4(i))
          if (j >= 0 && !inThis.has(j) && this.isFloor(j) && this.bridgeOf[j] === 0)
            spots.push(this.cellXY(j));
      const pickN = Math.min(spots.length, 1 + Math.round(r.crumble * 4));
      rng
        .shuffle(spots)
        .slice(0, pickN)
        .forEach((at, n) => this.bridgeRubble.push({ id: `${r.id}#rubble${n}`, at }));
    }
    this.bridgeCrumble.set(k, { crumble: r.crumble, seed: r.seed });
    const rec: ResolvedBridge = {
      id: r.id,
      cells: sorted.map(({ i }) => this.cellXY(i)),
      broken: [...broken].sort((a, b) => a - b).map((i) => this.cellXY(i)),
      deck,
      under: sorted.map(({ j }) => under[j] as number),
      underMaterial: sorted.map(({ j }) => underMaterial[j] ?? null),
      railing: r.railing === undefined ? SPAN_RAILING[span] : r.railing,
      span,
    };
    if (piers.length > 0) rec.piers = piers;
    if (r.label !== undefined) rec.label = r.label;
    this.bridges.push(rec);
    // ends: a real bridge touches walkable floor on two sides that are not next to each other
    const groups = this.groupCount(anchorCells);
    const anchors = anchorCells.length;
    // anchored = walkable floor beyond BOTH ends along the span (within a step of the deck there, or by stairs)
    const endOk = (p: number, step: -1 | 1): boolean =>
      cells.some((i) => {
        if (along(i) !== p || broken.has(i)) return false;
        const [x, y] = this.cellXY(i);
        const j = axis === "h" ? this.idx(x + step, y) : this.idx(x, y + step);
        if (j < 0 || inThis.has(j) || !this.isFloor(j)) return false;
        return (
          Math.abs((this.height[j] as number) - (this.height[i] as number)) <= 2 ||
          this.stairEdges.has(i < j ? `${i},${j}` : `${j},${i}`)
        );
      });
    // a raised deck (explicit height) needs one way on and off: a flight of stairs, floor beside it within a step,
    // or another bridge that climbs to it (checked after every bridge is laid)
    const reached = (): boolean =>
      cells.some(
        (i) =>
          !broken.has(i) &&
          this.neighbours4(i).some(
            (j) =>
              j >= 0 &&
              !inThis.has(j) &&
              this.isFloor(j) &&
              (Math.abs((this.height[j] as number) - (this.height[i] as number)) <= 2 ||
                this.stairEdges.has(i < j ? `${i},${j}` : `${j},${i}`)),
          ),
      );
    const warn = (): void => {
      const first = this.cellXY(cells[0] as number);
      this.issue(
        "warning",
        "bridge_unanchored",
        anchors === 0
          ? `bridge "${r.id}" touches no walkable floor at deck height ${deck / 4}: nobody can get onto it`
          : `bridge "${r.id}" reaches walkable floor at one end only`,
        {
          path: r.path,
          elementId: r.elementId,
          cell: first,
          hint:
            r.deck !== null
              ? "add a stairs terrain op from the ground to its edge, or a bridge that climbs to it"
              : "make it span from floor to floor (extend it over the whole drop), or set floorHeight to the height of the floor at its ends",
        },
      );
    };
    if (r.deck !== null)
      this.deckChecks.push(() => {
        if (!reached()) warn();
      });
    else if (!(endOk(0, -1) && endOk(len - 1, 1)) && (anchors === 0 || groups < 2)) warn();
  }

  /** Number of groups of anchor cells, where anchors within 2 cells (Chebyshev) of each other count as one group. */
  private groupCount(anchors: number[]): number {
    const xy = anchors.map((i) => this.cellXY(i));
    const group = new Int32Array(xy.length).fill(-1);
    let g = 0;
    for (let s = 0; s < xy.length; s++) {
      if (group[s] !== -1) continue;
      group[s] = g;
      const q = [s];
      while (q.length > 0) {
        const a = q.pop() as number;
        const pa = xy[a] as [number, number];
        for (let b = 0; b < xy.length; b++) {
          if (group[b] !== -1) continue;
          const pb = xy[b] as [number, number];
          if (Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1])) <= 2) {
            group[b] = g;
            q.push(b);
          }
        }
      }
      g++;
    }
    return g;
  }

  /** Railings: a WALL (the bridge's railing style, 1 tile) on every intact deck edge that faces a drop. */
  private stepRailings(): void {
    this.bridges.forEach((b, bi) => {
      if (b.railing === null) return;
      const k = bi + 1;
      for (const [x, y] of b.cells) {
        const i = this.idx(x, y);
        if (i < 0 || (this.flags[i] as number) & CELL_FLAG.NO_FLOOR) continue;
        for (const side of ["N", "E", "S", "W"] as const) {
          const [nx, ny] =
            side === "N" ? [x, y - 1] : side === "S" ? [x, y + 1] : side === "E" ? [x + 1, y] : [x - 1, y];
          const j = this.idx(nx, ny);
          if (j < 0 || this.state[j] !== CELL.OPEN || this.bridgeOf[j] === k) continue;
          const drop =
            ((this.flags[j] as number) & CELL_FLAG.NO_FLOOR) !== 0 ||
            (this.height[j] as number) < Math.min(b.deck, this.height[i] as number) - 2;
          if (!drop) continue;
          // a crumbling bridge has gaps in its parapet too
          const cr = this.bridgeCrumble.get(k);
          if (cr && cr.crumble > 0 && h32(`${cr.seed}:parapet:${x}:${y}:${side}`) / 4294967296 < cr.crumble)
            continue;
          const ed = this.sideEdge(x, y, side);
          if (!ed) continue;
          ed.e.kind[ed.i] = EDGE.WALL;
          ed.e.style[ed.i] = b.railing;
          ed.e.height[ed.i] = RAILING_HEIGHT;
          // the railing stands on the deck: host on the deck cell (first = N/W cell of the edge)
          ed.e.hostSet[ed.i] = side === "N" || side === "W" ? 1 : 0;
        }
      }
    });
  }

  // ───────────────────────────── phase 2: steps 8–10 ─────────────────────────────

  /**
   * Floor that scatter/dress may furnish. Generator 2 also keeps generated props off lava and off bridge decks
   * (a deck must stay walkable, and its railings are not walls to hang torches on).
   */
  private placeable(i: number): boolean {
    if (!this.isFloor(i)) return false;
    if (!this.gen.scatterKeepsClear) return true;
    if (this.structs?.reservedCell(i)) return false;
    if ((this.flags[i] as number) & (CELL_FLAG.BRIDGE | CELL_FLAG.STEPS)) return false;
    // keep the approach to bridges and stairs clear: no generated props on a cell beside a deck or a flight
    if (
      this.neighbours4(i).some(
        (j) => j >= 0 && ((this.flags[j] as number) & (CELL_FLAG.BRIDGE | CELL_FLAG.STEPS)) !== 0,
      )
    )
      return false;
    return this.mat[i] !== LAVA_ORDINAL;
  }

  private rampCells(): Set<number> {
    if (!this.rampSet) {
      this.rampSet = new Set<number>();
      for (const r of this.ramps) for (const [x, y] of r.cells) this.rampSet.add(this.idx(x, y));
    }
    return this.rampSet;
  }

  grid(): PlacementGrid {
    return {
      inBounds: (x, y) => this.idx(x, y) >= 0,
      isFloor: (x, y) => this.placeable(this.idx(x, y)),
      flags: (x, y) => {
        const i = this.idx(x, y);
        return i < 0 ? 0 : (this.flags[i] as number);
      },
      area: (x, y) => {
        const i = this.idx(x, y);
        return i < 0 ? 0 : (this.disp[i] as number);
      },
      occupied: (x, y) => {
        const i = this.idx(x, y);
        return i >= 0 && (this.occ[i] as number) > 0;
      },
      edge: (x, y, s) => this.edgeKindAt(x, y, s),
      landmark: (x, y) => this.landmarkCells.has(this.idx(x, y)),
      vehicle: (x, y) => this.vehicleCells.has(this.idx(x, y)),
      keepClear: (x, y) => this.crossingClear().has(this.idx(x, y)),
      // generator 2: rock ramp cells (no path flag) stay clear of the band and other dressing
      ramp: (x, y) => this.gen.ramps && this.rampCells().has(this.idx(x, y)),
      generator: this.plan.generator,
      // the band's pieces at their real size; undefined where the theme has no such piece (no band)
      ...(this.gen.realPieceSizes
        ? { pieceSize: (t: FeatureType) => this.ctx.palette.pieceSize(this.levelTheme, t) }
        : {}),
      // the real outline of those pieces, and the cells off the board (void or outside the bounds)
      ...(this.gen.realPieceOutlines
        ? {
            pieceExtent: (t: FeatureType) => this.ctx.palette.pieceSize(this.levelTheme, t, true),
            void: (x: number, y: number) => {
              const i = this.idx(x, y);
              return i < 0 || this.state[i] === CELL.VOID;
            },
          }
        : {}),
      // the board's water plane in tiles above the level floor (the scale of `height`): dressing sinks stones to it
      ...(this.gen.waterBody
        ? {
            waterSurface: () => {
              const s = this.waterSurface(false);
              return s === null ? undefined : s - this.level.elevation - 0.5;
            },
          }
        : {}),
      // floor height in tiles: set pieces put focal pieces on high ground and keep big pieces off height steps
      height: (x, y) => {
        const i = this.idx(x, y);
        // a void cell (cut away by the outline) keeps a stale height; the ground there is the base plane
        if (i < 0 || (this.state[i] === CELL.VOID && this.gen.voidIsBasePlane)) return 0;
        return (this.height[i] as number) / 4;
      },
      // what the room recipes need (gen/rooms4.ts)
      ...(this.gen.roomRecipes
        ? {
            piece4: (t: FeatureType, v?: string) => this.ctx.palette.roomPiece(this.levelTheme, t, v),
            wallHosted: (x: number, y: number, s: Side) => {
              const ed = this.sideEdge(x, y, s);
              if (!ed) return false;
              const [a, b] = this.edgeCells(ed.orient, ed.i);
              const forced = ed.e.hostSet[ed.i] as number;
              const host = forced >= 0 ? forced : this.hostOf(a, b, ed.e.run[ed.i] === 1);
              return host === (s === "N" || s === "W" ? 1 : 0);
            },
            wallHeight: (x: number, y: number, s: Side) => {
              const ed = this.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.height[ed.i] as number) : 0;
            },
            wallStyle: (x: number, y: number, s: Side) => {
              const ed = this.sideEdge(x, y, s);
              return ed && ed.e.kind[ed.i] === EDGE.WALL ? (ed.e.style[ed.i] ?? "wall") : undefined;
            },
            lightCells: () =>
              this.features.filter((f) => LIGHT_FEATURES.has(f.type)).map((f) => [f.at[0], f.at[1]] as const),
            roomMemory: this.roomMemory,
          }
        : {}),
    };
  }

  /** Road crossings and the pavement cells at their ends: generated dressing keeps off them (built lazily). */
  private crossingClear(): Set<number> {
    if (this.crossingClearCache) return this.crossingClearCache;
    const out = new Set<number>();
    for (const r of this.roads)
      for (const c of r.crossings)
        for (const [x, y] of c.cells) {
          out.add(this.idx(x, y));
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
            const j = this.idx(x + (dx as number), y + (dy as number));
            if (j >= 0) out.add(j);
          }
        }
    this.crossingClearCache = out;
    return out;
  }

  private nearestFree(
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
          if (this.featureProblem(type, p, size, wall) === null) return p;
        }
      }
    }
    return null;
  }

  runPhase2(): void {
    this.stepExplicitFeatures();
    this.stepMarket();
    this.stepBridgeRubble();
    this.stepOpeningRubble();
    this.stepOpeningRimDebris();
    // generator 4: rooms the plan left bare are dressed from their purpose, and every room is lit. Before the loose
    // rubble and the scatters, so those fill what the furniture leaves and never take a wall run from it.
    if (this.gen.roomRecipes && this.level.roomDress !== false) this.stepRoomRecipes();
    this.stepWallFootRubble();
    this.stepGeneratedFeatures();
  }

  /**
   * Generator 4: the default dressing of rooms (gen/rooms4.ts). An area of kind room whose name, tags or notes name a
   * purpose, that no dress op covers and that the plan furnished lightly (under 2 features per 10 floor tiles), gets
   * that purpose's furniture, things on it and lights. A room with no purpose, or one the plan furnished itself, still
   * gets its torches; a passage a few. Abandoned places (a crypt, cells, a ruin) stay sparse and keep one light at most.
   * `roomDress: false` on the level turns it off.
   */
  private stepRoomRecipes(): void {
    const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
    const dressed = new Set<string>();
    for (const op of this.level.terrain) if (op.op === "dress" && op.area !== undefined) dressed.add(op.area);
    const baseGrid = this.grid();
    if (baseGrid.piece4 === undefined) return;
    for (const info of this.areas) {
      if (info.kind !== "room" && info.kind !== "corridor") continue;
      const area = info.area;
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < this.n; i++) if (this.disp[i] === info.index + 1 && this.isFloor(i)) cells.push(this.cellXY(i));
      if (cells.length < 6) continue;
      const theme = info.theme;
      const grid: PlacementGrid = {
        ...baseGrid,
        piece4: (t: FeatureType, v?: string) => this.ctx.palette.roomPiece(theme, t, v),
      };
      const seed = subSeed(elementSeed(this.plan.seed, `${this.level.id}~${area.id}~room`, undefined), "room");
      const own = this.features.filter((f) => f.area === area.id && f.generatedBy === undefined && f.type !== "torch_wall").length;
      const lightly = own * 10 < 2 * cells.length;
      // a corridor is never furnished, but its name still says whether it is kept up ("Crypt passage" stays dark)
      const { purpose, abandoned } = info.room;
      const ruin = purpose === "ruin";
      let res: { placements: GeneratedPlacement[]; capped: boolean } | null = null;
      if (info.kind === "room" && furnishedPurpose(purpose) && lightly && !dressed.has(area.id)) {
        res = dressRoom(grid, {
          purpose,
          abandoned,
          areaIndex: info.index + 1,
          areaCells: cells,
          density: 1,
          seed,
          remaining: cap - this.generated,
          have: this.features.filter((f) => f.area === area.id && f.generatedBy === undefined).map((f) => f.type),
        });
      }
      // no recipe (no purpose, the plan's own furnishing, or no pieces to dress with): torches only, never in a ruin or
      // a room a dress op already composed
      if (res === null && !ruin && !dressed.has(area.id)) {
        res = lightArea(grid, {
          areaIndex: info.index + 1,
          areaCells: cells,
          seed,
          remaining: cap - this.generated,
          every: info.kind === "corridor" ? 18 : 12,
          abandoned,
        });
      }
      if (res === null) continue;
      this.commitGenerated(`${area.id}~room`, res.placements);
      if (res.capped) break;
    }
  }

  /** A cell a market piece may stand on: open floor nothing else holds (no building, feature, link, water or crossing). */
  private marketCellOk(x: number, y: number, reserved = true): boolean {
    const i = this.idx(x, y);
    if (i < 0 || this.state[i] !== CELL.OPEN) return false;
    const f = this.flags[i] as number;
    if (
      f &
      (CELL_FLAG.NO_FLOOR | CELL_FLAG.LINK | CELL_FLAG.STEPS | CELL_FLAG.FEATURE | CELL_FLAG.WATER | CELL_FLAG.BRIDGE)
    )
      return false;
    const sa = this.struct[i] as number;
    if ((this.occ[i] as number) > 0 || this.areas[sa - 1]?.kind === "building" || (reserved && this.structs?.reservedCell(i)))
      return false;
    return !this.crossingClear().has(i);
  }

  /** Commit a market piece as a generated feature; `occupy` false keeps its cells free for other dressing (a line). */
  private commitMarket(
    id: string,
    p: {
      type: FeatureType;
      at: [number, number];
      size: [number, number];
      rot?: number;
      rotFine?: number;
      variant?: string;
      lift?: number;
      offset?: [number, number];
      stall?: StallBuild;
    },
    occupy: boolean,
  ): void {
    const anchor = this.idx(p.at[0], p.at[1]);
    const info = featureInfo(p.type);
    const rf: ResolvedFeature = {
      id,
      type: p.type,
      generatedBy: id.split("#")[0] as string,
      at: p.at,
      size: p.size,
      rot: (p.rot ?? 0) as ResolvedFeature["rot"],
      rotFine: p.rotFine ?? p.rot ?? 0,
      baseHeight: this.featureBase(anchor, p.lift ?? 0),
      theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
      blocking: occupy && info.blocking,
    };
    if (p.variant !== undefined) rf.variant = p.variant;
    if (p.stall !== undefined) rf.stall = p.stall;
    if (p.offset !== undefined)
      rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
    const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
    if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
    if (occupy) this.addFeature(rf, this.footprint(p.at, p.size).cells);
    else this.features.push(rf);
    this.generated++;
  }

  /**
   * Generator 3, markets: rows of stalls (`Level.stalls`), goods on the bare-table stalls (also on stalls the plan
   * placed itself), overhead lines (`Level.lines`) anchored on building walls or posts, and the props a trade puts
   * outside its door. Everything stands only on cells nothing else holds.
   */
  private stepMarket(): void {
    const stallRows = this.level.stalls ?? [];
    const lineList = this.level.lines ?? [];
    if (!this.gen.stallsAndLines) {
      if (stallRows.length + lineList.length > 0)
        this.issue("warning", "no_effect", `stalls and lines need generator 3; this plan is generator ${this.plan.generator}`, {
          hint: 'set "generator": 3 on the plan',
        });
      return;
    }
    const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
    const seedOf = (id: string): number => elementSeed(this.plan.seed, `${this.level.id}~${id}`, undefined);
    const ok = (x: number, y: number): boolean => this.marketCellOk(x, y);
    // goods on a bare-table stall: two pieces resting on the table top (its real height; nothing floats)
    const putGoods = (stallId: string, st: { at: [number, number]; size: [number, number] }, kind: string): void => {
      const set = stallKindInfo(kind).tableGoods;
      if (set === undefined) return;
      const ext = this.ctx.palette.pieceSize(this.levelTheme, "stall", true, "empty");
      if (!ext) return;
      const rng = createPrng(subSeed(seedOf(stallId), "goods"));
      const cells: Array<[number, number]> = [];
      for (let y = st.at[1]; y < st.at[1] + st.size[1]; y++)
        for (let x = st.at[0]; x < st.at[0] + st.size[0]; x++) cells.push([x, y]);
      cells.forEach((c, n) => {
        if (this.generated >= cap) return;
        this.commitMarket(
          `${stallId}#g${n}`,
          {
            type: "goods",
            at: c,
            size: [1, 1],
            rotFine: rng.int(24) * 15,
            variant: set,
            lift: ext.h,
            offset: [(rng.next() - 0.5) * 0.3, (rng.next() - 0.5) * 0.3],
          },
          false,
        );
      });
    };
    for (const f of [...this.features]) {
      if (f.type === "stall" && f.generatedBy === undefined) putGoods(f.id, { at: [f.at[0], f.at[1]], size: [f.size[0], f.size[1]] }, f.variant ?? "empty");
    }
    // generator 4: covered stalls when the theme's palette has the parts (else the table stall of generator 3)
    const forms = this.gen.coveredStalls ? this.ctx.palette.stallForms(this.levelTheme) : [];
    stallRows.forEach((row, k) => {
      let placed;
      if (forms.length > 0) {
        // a stall stands on one level of ground: only the most common floor height of the rectangle takes one
        const heights = new Map<number, number>();
        for (let y = row.area.y; y < row.area.y + row.area.h; y++)
          for (let x = row.area.x; x < row.area.x + row.area.w; x++) {
            const i = this.idx(x, y);
            if (i >= 0 && ok(x, y)) heights.set(this.height[i] as number, (heights.get(this.height[i] as number) ?? 0) + 1);
          }
        const level = [...heights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
        const flat = (x: number, y: number): boolean => ok(x, y) && this.height[this.idx(x, y)] === level;
        placed = layoutStalls4(row, flat, seedOf(`stalls${k}~${row.seed ?? 0}`), forms);
      } else placed = layoutStalls(row, ok, seedOf(`stalls${k}~${row.seed ?? 0}`));
      if (placed.length === 0)
        this.issue("warning", "no_effect", `stall row "${row.id}" placed no stall`, {
          elementId: row.id,
          hint: "its rectangle is taken (buildings, features, water) or too small: a stall needs 2 free cells in a line",
        });
      placed.forEach((p, n) => {
        if (this.generated >= cap) return;
        const id = `${row.id}#${n}`;
        this.commitMarket(
          id,
          { type: "stall", at: p.at, size: p.size, rot: p.rot, variant: p.kind, ...(p.build ? { stall: p.build } : {}) },
          true,
        );
        // a covered stall carries its own goods (the realizer puts them on its counters); a table gets them here
        if (!p.build) putGoods(id, p, p.kind);
      });
      // stock beside the stalls goes in once every stall of the row stands (it takes only cells they left free)
      placed.forEach((p, n) => {
        if (p.build) this.stallClutter(`${row.id}#${n}`, p, p.build, cap);
      });
    });
    lineList.forEach((line, k) => {
      this.stepLine(line, k, cap);
    });
    // outside a front door the lot's reserved ring is exactly where trade props stand (the door approach stays free)
    this.stepTradeProps(cap, (x, y) => this.marketCellOk(x, y, false));
  }

  /**
   * Generator 4: loose stock behind or beside a covered stall (a crate, barrel or sack on a free cell touching it),
   * on about half of them. Never in front: the lane stays clear.
   */
  private stallClutter(id: string, p: { at: [number, number]; size: [number, number]; kind: string }, b: StallBuild, cap: number): void {
    if (this.generated >= cap) return;
    const rng = createPrng(subSeed(elementSeed(this.plan.seed, `${this.level.id}~${id}`, undefined), "clutter"));
    if (rng.next() > 0.5) return;
    const cands: Array<[number, number]> = [];
    for (let lx = 0; lx < b.w; lx++) cands.push(stallCell(b.front, p.at, p.size, lx, b.d));
    cands.push(stallCell(b.front, p.at, p.size, -1, b.d - 1), stallCell(b.front, p.at, p.size, b.w, b.d - 1));
    const types = stallKindInfo(p.kind).stock;
    const type = types[rng.int(types.length)] as FeatureType;
    const free = cands.filter(([x, y]) => this.marketCellOk(x, y) && this.featureProblem(type, [x, y], [1, 1], undefined) === null);
    const at = free[rng.int(Math.max(1, free.length))];
    if (!at) return;
    this.commitMarket(`${id}#stock`, { type, at, size: [1, 1], rot: rng.int(4) * 90 }, true);
  }

  /** One overhead line: straightness, two anchors (a building wall within 3 cells beyond the end, else a post), pieces. */
  private stepLine(line: NonNullable<Level["lines"]>[number], k: number, cap: number): void {
    const bad = (msg: string, hint: string): void => {
      this.issue("warning", "line_unanchored", `line "${line.id}" ${msg}; it was dropped`, {
        path: `/levels/${this.li}/lines/${k}`,
        elementId: line.id,
        hint,
      });
    };
    const [x0, y0] = line.from;
    const [x1, y1] = line.to;
    if (x0 !== x1 && y0 !== y1) {
      bad("is not straight", "give from and to on one row or one column of cells");
      return;
    }
    const alongX = y0 === y1;
    const lane = alongX ? y0 : x0;
    const lo = Math.min(alongX ? x0 : y0, alongX ? x1 : y1);
    const hi = Math.max(alongX ? x0 : y0, alongX ? x1 : y1);
    if (hi - lo < 2) {
      bad("is shorter than 3 cells", "a line spans at least 3 cells");
      return;
    }
    const cellAt = (a: number): [number, number] => (alongX ? [a, lane] : [lane, a]);
    const building = (a: number): boolean => {
      const [x, y] = cellAt(a);
      // a footprint cell (a porch or stoop beside it is not a wall)
      return this.structs?.buildings.some((b) => b.cellSet.has(`${x},${y}`)) === true;
    };
    const anchor = (end: number, dir: 1 | -1): { kind: "wall" | "post"; at: number } | null => {
      for (let d = 0; d <= 3; d++) if (building(end + dir * d)) return { kind: "wall", at: end + dir * d };
      for (let d = 0; d <= 1; d++) {
        const a = end - dir * d;
        const [x, y] = cellAt(a);
        if (this.marketCellOk(x, y) && this.featureProblem("line_post", [x, y], [1, 1], undefined) === null)
          return { kind: "post", at: a };
      }
      return null;
    };
    const aLo = anchor(lo, -1);
    const aHi = anchor(hi, 1);
    if (!aLo || !aHi) {
      bad(
        "has no building wall within 3 cells of an end and no free cell for a post there",
        "end it beside a building wall, or on a free cell",
      );
      return;
    }
    for (let a = aLo.at + 1; a < aHi.at; a++)
      if (building(a)) {
        bad("passes through a building", "end it at the building's wall");
        return;
      }
    if (aHi.at - aLo.at < 3) {
      bad("is shorter than 3 cells between its anchors", "make the span longer");
      return;
    }
    // generator 4: a covered stall's canopy rises above a rope's height; the line runs along the aisle, not through it
    if (this.gen.coveredStalls)
      for (let a = aLo.at + 1; a < aHi.at; a++) {
        const [cx, cy] = cellAt(a);
        if (
          this.features.some(
            (f) =>
              f.stall !== undefined &&
              cx >= f.at[0] &&
              cx < f.at[0] + f.size[0] &&
              cy >= f.at[1] &&
              cy < f.at[1] + f.size[1],
          )
        ) {
          bad("passes through a covered stall", "run it along the aisle or the street, clear of the stalls' footprints");
          return;
        }
      }
    // 2.6 clears the awnings of shop fronts (2 to 2.5 up); a wall must reach it, else the verifier says the line is not held
    const height = Math.max(2, Math.min(3, line.height ?? 2.6));
    // the posts (an anchor that is not a wall)
    const anchors: ResolvedLine["anchors"] = [
      { kind: aLo.kind, at: cellAt(aLo.at) },
      { kind: aHi.kind, at: cellAt(aHi.at) },
    ];
    [aLo, aHi].forEach((an, n) => {
      if (an.kind === "post") this.commitMarket(`${line.id}#post${n}`, { type: "line_post", at: cellAt(an.at), size: [1, 1] }, true);
    });
    const start = aLo.kind === "wall" ? aLo.at + 1 : aLo.at + 0.65;
    const end = aHi.kind === "wall" ? aHi.at : aHi.at + 0.35;
    const pieces = layoutLine({ alongX, lane, start, end }, line.kind ?? "lanterns", line.spacing ?? 3);
    pieces.forEach((p, n) => {
      if (this.generated >= cap) return;
      this.commitMarket(
        `${line.id}#${n}`,
        { type: "overhead", at: p.at, size: p.size, rotFine: p.rotFine, variant: p.variant, lift: height, offset: p.offset },
        false,
      );
    });
    this.resolvedLines.push({ id: line.id, a: cellAt(aLo.at), b: cellAt(aHi.at), height, anchors });
  }

  /** Props a trade puts outside its front door (not in front of the door itself, never in the carriageway). */
  private stepTradeProps(cap: number, ok: (x: number, y: number) => boolean): void {
    if (!this.structs) return;
    const carriage = new Set<number>();
    for (const r of this.pendingRoads) for (const i of r.cells) carriage.add(i);
    const STEP: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
    const TURN: Record<Side, number> = { S: 0, W: 90, N: 180, E: 270 };
    for (const b of this.structs.buildings) {
      const trade = tradeOf(b.st.use);
      if (!trade || (b.st.style ?? "cottage") === "modern") continue;
      const side = b.frontage.side;
      const [dx, dy] = STEP[side];
      const cands: Array<[number, number]> = [];
      // a door (not a window) on the front edge of cell (cx, cy) or of a cell beside it along the frontage
      const doorOn = (cx: number, cy: number): boolean =>
        this.openings.some((o) => {
          if (o.kind === "window" || o.kind === "arrow_slit" || o.kind === "bars") return false;
          const [sx, sy] = o.start;
          if (o.orientation === "h") {
            const ey = side === "S" ? cy + 1 : cy;
            return (side === "S" || side === "N") && sy === ey && cx >= sx && cx < sx + o.width;
          }
          const ex = side === "E" ? cx + 1 : cx;
          return (side === "E" || side === "W") && sx === ex && cy >= sy && cy < sy + o.width;
        });
      const doorNear = (cx: number, cy: number): boolean =>
        [-1, 0, 1].some((d) => (dx === 0 ? doorOn(cx + d, cy) : doorOn(cx, cy + d)));
      for (const [cx, cy] of b.cells) {
        const ox = cx + dx;
        const oy = cy + dy;
        if (b.cellSet.has(`${ox},${oy}`)) continue;
        const i = this.idx(ox, oy);
        if (i < 0 || carriage.has(i) || !ok(ox, oy)) continue;
        // keep the doorway's approach clear: no prop on or beside a door's cell (windows do not count)
        if (doorNear(cx, cy)) continue;
        cands.push([ox, oy]);
      }
      const rng = createPrng(subSeed(elementSeed(this.plan.seed, `${this.level.id}~${b.st.id}`, undefined), "trade"));
      for (let i = cands.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [cands[i], cands[j]] = [cands[j] as [number, number], cands[i] as [number, number]];
      }
      const want = Math.min(cands.length, 1 + rng.int(3));
      const table = TRADE_PROPS[trade];
      const total = table.reduce((a, [, w]) => a + w, 0);
      const taken: Array<[number, number]> = [];
      for (const c of cands) {
        if (taken.length >= want || this.generated >= cap) break;
        if (taken.some((t) => Math.abs(t[0] - c[0]) + Math.abs(t[1] - c[1]) < 2)) continue;
        let r = rng.next() * total;
        let type = table[0]?.[0] as FeatureType;
        for (const [t, w] of table) {
          r -= w;
          if (r < 0) {
            type = t;
            break;
          }
        }
        const sz = rotatedSize(featureInfo(type).size, TURN[side]);
        // a wide piece lies along the frontage from its cell
        let at: [number, number] = [c[0], c[1]];
        if (sz[0] * sz[1] > 1) {
          const along: [number, number] = dy === 0 ? [0, 1] : [1, 0];
          const cells: Array<[number, number]> = [];
          for (let a = 0; a < Math.max(sz[0], sz[1]); a++) cells.push([c[0] + along[0] * a, c[1] + along[1] * a]);
          if (!cells.every(([x, y]) => ok(x, y) && cands.some((q) => q[0] === x && q[1] === y))) continue;
          at = [c[0], c[1]];
        }
        if (this.featureProblem(type, at, sz, undefined) !== null) continue;
        this.commitMarket(`${b.st.id}~trade#${taken.length}`, { type, at, size: sz, rot: TURN[side] }, true);
        taken.push(c);
      }
    }
  }

  /** Rubble at the ends of crumbling bridges (generated features "<bridgeId>#rubble<n>"). */
  private stepBridgeRubble(): void {
    const info = featureInfo("rubble");
    for (const r of this.bridgeRubble) {
      const size = rotatedSize(info.size, 0);
      if (this.featureProblem("rubble", r.at, size, undefined) !== null) continue;
      const anchor = this.idx(r.at[0], r.at[1]);
      const rf: ResolvedFeature = {
        id: r.id,
        type: "rubble",
        generatedBy: r.id.split("#")[0] as string,
        at: r.at,
        size,
        rot: 0,
        rotFine: (h32(r.id) % 24) * 15,
        baseHeight: this.featureBase(anchor, 0),
        theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
        blocking: info.blocking,
      };
      const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      this.addFeatureCells(rf);
    }
  }

  /**
   * A vehicle the plan put on a pavement or across a carriageway (owner's model test, 2026-11-20: taxis half on the
   * pavement, a bus across the road): park it in the nearest kerb lane, its long side along the road, one lane deep.
   * Vehicles away from roads (a car park, a yard) keep what the plan gave. Returns the new anchor and size, or null.
   */
  private parkVehicle(
    at: Vec2,
    size: readonly [number, number],
  ): { at: Vec2; size: [number, number] } | null {
    if (!this.gen.roads || this.roads.length === 0) return null;
    const k = (x: number, y: number): string => `${x},${y}`;
    const cw = new Set<string>();
    const pave = new Set<string>();
    const cross = new Set<string>();
    for (const r of this.roads) {
      for (const [x, y] of r.carriageway) cw.add(k(x, y));
      for (const [x, y] of r.pavement) pave.add(k(x, y));
      for (const c of r.crossings) for (const [x, y] of c.cells) cross.add(k(x, y));
    }
    const cells: Vec2[] = [];
    for (let y = at[1]; y < at[1] + size[1]; y++)
      for (let x = at[0]; x < at[0] + size[0]; x++) cells.push([x, y]);
    const onPave = cells.some(([x, y]) => pave.has(k(x, y)));
    const onRoad = cells.some(([x, y]) => cw.has(k(x, y)));
    if (!onPave && !onRoad) return null;
    // on the carriageway and already lying along its road (a stalled car mid-lane): leave it
    if (!onPave) {
      const road = this.roads.find((r) =>
        cells.some(([x, y]) => r.carriageway.some((c) => c[0] === x && c[1] === y)),
      );
      const a = road?.axis;
      const horizontalRoad =
        a !== undefined &&
        a.length > 1 &&
        Math.abs((a[1] as Vec2)[0] - (a[0] as Vec2)[0]) >= Math.abs((a[1] as Vec2)[1] - (a[0] as Vec2)[1]);
      if (size[0] !== size[1] && size[0] > size[1] === horizontalRoad) return null;
    }
    // the road it is on or beside, and whether the vehicle already lies along it in one lane against a kerb
    const len = Math.max(size[0], size[1]);
    let best: { at: Vec2; size: [number, number]; d: number } | null = null;
    for (const r of this.roads)
      for (const kl of r.kerbLines) {
        const [dx, dy] =
          kl.side === "N" ? [0, -1] : kl.side === "S" ? [0, 1] : kl.side === "E" ? [1, 0] : [-1, 0];
        const horiz = kl.side === "N" || kl.side === "S";
        const n = Math.max(Math.abs(kl.to[0] - kl.from[0]), Math.abs(kl.to[1] - kl.from[1])) + 1;
        const sx = Math.sign(kl.to[0] - kl.from[0]);
        const sy = Math.sign(kl.to[1] - kl.from[1]);
        for (let t = 0; t + len <= n; t++) {
          // lane cells: one step from the kerb into the carriageway, `len` long
          const lane: Vec2[] = [];
          for (let u = 0; u < len; u++)
            lane.push([kl.from[0] + sx * (t + u) + dx, kl.from[1] + sy * (t + u) + dy]);
          if (!lane.every(([x, y]) => cw.has(k(x, y)) && !cross.has(k(x, y)))) continue;
          if (lane.some(([x, y]) => (this.occ[this.idx(x, y)] as number) > 0)) continue;
          const x0 = Math.min(...lane.map((c) => c[0]));
          const y0 = Math.min(...lane.map((c) => c[1]));
          const d = Math.abs(x0 - at[0]) + Math.abs(y0 - at[1]);
          if (!best || d < best.d) best = { at: [x0, y0], size: horiz ? [len, 1] : [1, len], d };
        }
      }
    if (!best) return null;
    if (best.at[0] === at[0] && best.at[1] === at[1] && best.size[0] === size[0] && best.size[1] === size[1])
      return null;
    return { at: best.at, size: best.size };
  }

  private stepExplicitFeatures(): void {
    this.level.features.forEach((f, k) => {
      const info = featureInfo(f.type);
      const rot = f.rot ?? 0;
      let size = rotatedSize(f.size ?? info.size, rot);
      if (f.type === "vehicle") {
        const parked = this.parkVehicle(f.at, size);
        if (parked) {
          this.issue(
            "info",
            "feature_moved",
            `vehicle "${f.id}" at ${f.at[0]},${f.at[1]} stood on the pavement or across the road: parked at ${parked.at[0]},${parked.at[1]} in the kerb lane, along the road`,
            { path: `/levels/${this.li}/features/${k}`, elementId: f.id, cell: parked.at },
          );
          f = { ...f, at: parked.at };
          size = parked.size;
        }
      }
      let wall = info.wallMounted ? (f.wall ?? "N") : f.wall;
      // generator 3: a wall-mounted piece asked for a cell or side without a wall snaps to the nearest wall face within
      // one cell (same side first, then the other sides), instead of failing
      if (info.wallMounted && this.gen.wallMountSnap && this.featureProblem(f.type, f.at, size, wall) !== null) {
        let snapped: { at: Vec2; wall: Side } | null = null;
        const sides: Side[] = [wall as Side, "N", "E", "S", "W"].filter((s, n, a) => a.indexOf(s) === n) as Side[];
        const offs: Array<[number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
        search: for (const [dx, dy] of offs) {
          for (const s of sides) {
            const p: Vec2 = [f.at[0] + dx, f.at[1] + dy];
            if (this.featureProblem(f.type, p, size, s) === null) {
              snapped = { at: p, wall: s };
              break search;
            }
          }
        }
        if (snapped) {
          this.issue(
            "info",
            "feature_moved",
            `${f.type} "${f.id}" had no wall at ${f.at[0]},${f.at[1]} (${wall}): snapped to the ${snapped.wall} wall of ${snapped.at[0]},${snapped.at[1]}`,
            { path: `/levels/${this.li}/features/${k}`, elementId: f.id, cell: snapped.at },
          );
          f = { ...f, at: snapped.at };
          wall = snapped.wall;
        }
      }
      const problem = this.featureProblem(f.type, f.at, size, wall);
      if (problem) {
        const near = this.nearestFree(f.type, f.at, size, wall);
        const code = problem.includes("another feature") ? "feature_overlap" : "feature_blocked";
        this.issue("error", code, `feature "${f.id}" (${f.type}) at ${f.at[0]},${f.at[1]}: ${problem}`, {
          path: `/levels/${this.li}/features/${k}`,
          elementId: f.id,
          cell: f.at,
          ...(near ? { hint: `nearest free spot is [${near[0]},${near[1]}]` } : {}),
        });
      }
      const anchor = this.idx(f.at[0], f.at[1]);
      const rf: ResolvedFeature = {
        id: f.id,
        type: f.type,
        at: [f.at[0], f.at[1]],
        size,
        rot,
        rotFine: rot,
        baseHeight: this.featureBase(anchor, f.lift ?? 0),
        theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
        blocking: info.blocking,
      };
      if (wall !== undefined) rf.wall = wall;
      if (f.variant !== undefined) rf.variant = f.variant;
      if (f.hint !== undefined) rf.hint = f.hint;
      if (f.label !== undefined) rf.label = f.label;
      const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      if (f.gmOnly ?? info.gmOnly) rf.gmOnly = true;
      this.addFeature(rf, this.footprint(f.at, size).cells);
    });
  }

  private commitGenerated(opId: string, list: GeneratedPlacement[]): void {
    list.forEach((p, n) => {
      const info = featureInfo(p.type);
      const anchor = this.idx(p.at[0], p.at[1]);
      const rf: ResolvedFeature = {
        id: `${opId}#${n}`,
        type: p.type,
        generatedBy: opId,
        at: p.at,
        size: p.size,
        rot: p.rot,
        rotFine: p.rotFine,
        // generator 2: a generated piece may stand above (or sink below) the floor, e.g. a second course of rock
        baseHeight: this.featureBase(
          anchor,
          this.gen.featureLift ? ((p as { lift?: number }).lift ?? 0) : 0,
        ),
        theme: this.themes[anchor >= 0 ? (this.theme[anchor] as number) : 0] ?? this.levelTheme,
        blocking: info.blocking,
      };
      if (p.wall !== undefined) rf.wall = p.wall;
      if (p.variant !== undefined) rf.variant = p.variant;
      // generator 3: a sub-cell shift (each axis within half a tile)
      if (p.offset !== undefined && this.gen.subCellOffsets)
        rf.offset = [Math.max(-0.5, Math.min(0.5, p.offset[0])), Math.max(-0.5, Math.min(0.5, p.offset[1]))];
      // generator 3: a furnishing set against a wall stands clear of it (a preset's bed, coffin or brazier is a little
      // wider than its cell and would sink into the wall, verify_prop_in_wall): shifted 0.45 tile off each wall it touches
      if (this.gen.furnitureOffWalls && rf.offset === undefined && !info.wallMounted && !info.organic && info.blocking) {
        const [x0, y0] = p.at;
        const [x1, y1] = [p.at[0] + p.size[0] - 1, p.at[1] + p.size[1] - 1];
        let ox = 0;
        let oy = 0;
        for (let x = x0; x <= x1; x++) {
          if (this.edgeKindAt(x, y0, "N") === EDGE.WALL) oy = 0.45;
          if (this.edgeKindAt(x, y1, "S") === EDGE.WALL) oy = oy === 0.45 ? 0 : -0.45;
        }
        for (let y = y0; y <= y1; y++) {
          if (this.edgeKindAt(x0, y, "W") === EDGE.WALL) ox = 0.45;
          if (this.edgeKindAt(x1, y, "E") === EDGE.WALL) ox = ox === 0.45 ? 0 : -0.45;
        }
        if (ox !== 0 || oy !== 0) rf.offset = [ox, oy];
      }
      const ar = anchor >= 0 ? (this.disp[anchor] as number) : 0;
      if (ar > 0) rf.area = (this.areas[ar - 1] as AreaInfo).area.id;
      if (info.gmOnly) rf.gmOnly = true;
      this.addFeature(rf, this.footprint(p.at, p.size).cells);
      this.generated++;
    });
  }

  /**
   * Generator 4: cells the natural cave passes (ragged outlines, floor shelves) must leave as the plan drew them:
   * explicit features, openings, link ends, stairs runs and the shapes of shaping terrain ops, each with a ring of
   * `ring` cells.
   */
  private caveKeep(ring: number): Set<number> {
    const keep = new Set<number>();
    const addRing = (gx: number, gy: number, r: number): void => {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const i = this.idx(gx + dx, gy + dy);
          if (i >= 0) keep.add(i);
        }
    };
    for (const ft of this.level.features)
      for (const c of this.footprint(ft.at, ft.size ?? [1, 1]).cells) {
        const [x, y] = this.cellXY(c);
        addRing(x, y, ring);
      }
    for (const o of this.level.openings) if (o.at) addRing(o.at.x, o.at.y, ring + 1);
    // the ends of a link, and every cell its run, stairwell and landing cover (plan/links.ts `linkGeometry`)
    for (const l of this.plan.links)
      for (const end of [l.from, l.to])
        if (end.level === this.level.id && end.at) addRing(end.at[0], end.at[1], ring + 1);
    for (const [x, y] of linkCellsOnLevel(this.plan, this.level.id)) addRing(x, y, ring);
    const clip = this.rasterClip();
    for (const op of this.level.terrain) {
      if (op.op === "stairs") {
        forEachMaskCell(rasterPolyline([op.from, op.to], 1, clip), (x, y) => {
          addRing(x, y, ring + 1);
        });
        continue;
      }
      if (op.op !== "platform" && op.op !== "outcrop" && op.op !== "floor_opening" && op.op !== "height") continue;
      forEachMaskCell(rasterizeShape(op.shape, { planSeed: this.plan.seed, clip }), (x, y) => {
        addRing(x, y, ring);
      });
    }
    return keep;
  }

  /**
   * Generator 4: chambers and corridors with natural rock walls get ragged, bulging outlines (resolve/caveOutline.ts),
   * passages at least two cells wide, every connection kept. Runs right after the areas are claimed.
   */
  private stepCaveOutlines(): void {
    const keep = this.caveKeep(1);
    const zoneAt = (i: number): boolean => {
      const d = this.disp[i] as number;
      return d > 0 && (this.areas[d - 1] as AreaInfo).isZone;
    };
    for (const info of this.areas) {
      if (info.isZone || info.isBridge || !isNaturalWallStyle(info.wallStyle) || info.mode === "none") continue;
      const cells = this.areaCells(info.index);
      if (cells.length < 6) continue;
      const ai1 = info.index + 1;
      const r = raggedCaveOutline(
        {
          w: this.w,
          h: this.h,
          owner: (i) => this.struct[i] as number,
          open: (i) => this.state[i] === CELL.OPEN,
          rock: (i) => this.state[i] === CELL.SOLID && this.struct[i] === 0 && this.disp[i] === 0,
          keep: (i) => keep.has(i) || zoneAt(i),
        },
        ai1,
        cells,
        elementSeed(this.plan.seed, `${info.area.id}~caveoutline`),
      );
      for (const i of r.open) this.claim(i, info);
      for (const i of r.close) {
        this.state[i] = CELL.SOLID;
        this.struct[i] = 0;
        this.disp[i] = 0;
        this.mat[i] = 0;
        this.flags[i] = 0;
        this.height[i] = 0;
        this.heightSet[i] = 0;
      }
    }
    this.recountStruct();
  }

  /**
   * Generator 4: a cave floor the plan left flat (CAVE_RELIEF.flatShare of its dry cave floor at one height) gets a
   * few half-tile shelves (resolve/caveRelief.ts): low by the water, rising toward the back of side chambers. Never
   * under explicit features, bridges, links, openings or the pool edge, never beside another step.
   */
  private stepCaveRelief(): void {
    const cave = (i: number): boolean => {
      const s = this.struct[i] as number;
      if (s <= 0 || this.state[i] !== CELL.OPEN) return false;
      const info = this.areas[s - 1] as AreaInfo;
      return isNaturalWallStyle(info.wallStyle) && !info.isBridge;
    };
    const dry = (i: number): boolean =>
      ((this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE)) === 0;
    const floor: number[] = [];
    const count = new Map<number, number>();
    for (let i = 0; i < this.n; i++)
      if (cave(i) && dry(i)) {
        floor.push(i);
        count.set(this.height[i] as number, (count.get(this.height[i] as number) ?? 0) + 1);
      }
    if (floor.length < CAVE_RELIEF.minCells) return;
    let flat = 0;
    let most = 0;
    for (const [hq, n] of count)
      if (n > most) {
        most = n;
        flat = hq;
      }
    if (most / floor.length < CAVE_RELIEF.flatShare) return;
    // what stays: plan-made cells and their rings, water and its banks, bridges, any other step and the cells by it
    const keep = this.caveKeep(1);
    const near = (i: number, r: number, test: (j: number) => boolean): boolean => {
      const [x, y] = this.cellXY(i);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const j = this.idx(x + dx, y + dy);
          if (j >= 0 && test(j)) return true;
        }
      return false;
    };
    const bridgeArea = (j: number): boolean => {
      const s = this.struct[j] as number;
      return s > 0 && (this.areas[s - 1] as AreaInfo).isBridge;
    };
    const cells = floor.filter(
      (i) =>
        this.height[i] === flat &&
        !keep.has(i) &&
        !near(i, 2, (j) => ((this.flags[j] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) !== 0 || bridgeArea(j)) &&
        !near(i, 1, (j) => this.state[j] === CELL.OPEN && this.height[j] !== flat),
    );
    // low ground: the water; with none, the heart of the largest cave chamber
    let low: number[] = [];
    for (let i = 0; i < this.n; i++)
      if (this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.WATER) !== 0) low.push(i);
    if (low.length === 0) {
      let best = -1;
      let size = 0;
      for (const info of this.areas) {
        if (info.isZone || !isNaturalWallStyle(info.wallStyle)) continue;
        const n = this.areaCells(info.index).length;
        if (n > size) {
          size = n;
          best = info.index;
        }
      }
      if (best < 0) return;
      const d = this.innerDistance(this.areaCells(best));
      const top = Math.max(...d.values());
      low = [...d].filter(([, v]) => v >= top - 1).map(([i]) => i);
    }
    const shelves = caveShelves(
      this.organicGrid(),
      cells,
      low,
      (i) => this.state[i] === CELL.OPEN && ((this.flags[i] as number) & CELL_FLAG.NO_FLOOR) === 0,
      elementSeed(this.plan.seed, `${this.level.id}~caverelief`),
    );
    for (const [i, t] of shelves) if (t > 0) this.height[i] = (this.height[i] as number) + 2 * t;
  }

  /**
   * Generator 2, open-air natural levels: the board gets a ragged, rounded outline (about 80–90% of its rectangle,
   * stepping in 2-cell blocks) with a strip of low ground about 2 cells wide inside it, so a rise never meets the
   * board edge. Cells outside become void. Paths, water, areas, structures and explicit features keep their cells,
   * so roads and rivers still reach the true edge. Built-up levels (buildings or roads) keep their rectangle.
   */
  private stepOutline(): void {
    const base = this.level.base;
    if (!this.gen.naturalLevelOutline || base.type !== "ground" || this.level.outline === "rect") return;
    if (!NATURAL_PATH.has(base.material)) return;
    if (this.pendingRoads.length > 0) return;
    if (
      (this.level.structures ?? []).some((st) => st.kind !== "enclosure") &&
      (this.level.structures ?? []).length >= 3
    )
      return;
    if (this.w < 16 || this.h < 16) return;
    const noise = new ValueNoise(subSeed(elementSeed(this.plan.seed, `${this.level.id}~outline`), "outline"));
    const keep = (i: number): boolean => {
      const f = this.flags[i] as number;
      if ((f & (CELL_FLAG.PATH | CELL_FLAG.WATER | CELL_FLAG.BRIDGE | CELL_FLAG.LINK)) !== 0) return true;
      if ((this.struct[i] as number) > 0) return true;
      return this.structs?.reservedCell(i) === true;
    };
    for (const ft of this.level.features)
      for (const c of this.footprint(ft.at, ft.size ?? [1, 1]).cells) this.outlineKeep.add(c);
    // inset from each edge in 2-cell blocks: 2..6 cells, wandering with noise along the edge
    const inside = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const [x, y] = this.cellXY(i);
      const lx = x - this.bx;
      const ly = y - this.by;
      const bx2 = Math.floor(lx / 2);
      const by2 = Math.floor(ly / 2);
      const d = Math.min(lx, ly, this.w - 1 - lx, this.h - 1 - ly);
      const n = noise.sample(bx2 / 3.2, by2 / 3.2);
      const inset = n > 0.62 ? 4 : n > 0.42 ? 2 : 0;
      // corners round off: the inset grows where two edges are near
      const corner = Math.min(lx, this.w - 1 - lx) + Math.min(ly, this.h - 1 - ly) < 5 ? 2 : 0;
      inside[i] = d >= inset + corner ? 1 : 0;
    }
    // the open board: inside the outline, plus whatever must reach the edge
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== CELL.OPEN) continue;
      if (inside[i] || keep(i) || this.outlineKeep.has(i)) continue;
      this.state[i] = CELL.VOID;
    }
    // (a low apron round the outline, lowering raised ground near the void, is deferred: it cut routes on plans
    // that put a plateau against the board edge; see handoff-terrain.md)
  }

  /**
   * Generator 2: paths lead somewhere. When a level has natural paths, the focal piece (the first landmark-class
   * feature) and the front of each building get a spur trail from the nearest path cell unless a path already passes
   * within 3 cells. The spur is a 1-cell winding trail of the same material.
   */
  private stepPathSpurs(): void {
    if (!this.gen.naturalPaths) return;
    const trails = this.level.terrain.filter(
      (t): t is Extract<TerrainOp, { op: "path" }> =>
        t.op === "path" &&
        !WATER_MATS.has(t.material) &&
        t.sidewalk === undefined &&
        t.crossings === undefined,
    );
    if (trails.length === 0) return;
    const material = (trails[0] as Extract<TerrainOp, { op: "path" }>).material;
    const pathCells: Array<[number, number]> = [];
    for (let i = 0; i < this.n; i++)
      if (((this.flags[i] as number) & CELL_FLAG.PATH) !== 0) pathCells.push(this.cellXY(i));
    if (pathCells.length === 0) return;
    const targets: Array<{ id: string; at: Vec2; exact?: boolean }> = [];
    const focal =
      this.level.features.find((ft) => SPUR_PRIMARY.has(ft.type)) ??
      this.level.features.find((ft) => SPUR_FOCAL.has(ft.type));
    if (focal)
      targets.push({
        id: focal.id,
        at: focal.at,
        ...(this.gen.spursReachTargets ? { exact: true } : {}),
      });
    for (const st of this.level.structures ?? []) {
      if (st.kind === "enclosure") continue;
      // the building's first wing, first ground volume, or its bare rectangle
      const bare = st as { x?: number; y?: number; w?: number; h?: number };
      const w0 =
        st.wings?.[0] ??
        st.volumes?.find((v) => v.on === undefined) ??
        (bare.x !== undefined && bare.y !== undefined && bare.w !== undefined && bare.h !== undefined
          ? { x: bare.x, y: bare.y, w: bare.w, h: bare.h }
          : undefined);
      if (!w0) continue;
      // generator 3: the trail ends at the cell outside the building's door
      const doorOpening = this.gen.spursReachTargets
        ? this.level.openings.find(
            (o) =>
              o.id.startsWith(`${st.id}~`) &&
              (o.kind === "door" || o.kind === "double_door" || o.kind === "locked_door") &&
              o.at !== undefined,
          )
        : undefined;
      if (doorOpening?.at) {
        const d = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[doorOpening.at.side];
        targets.push({
          id: st.id,
          at: [doorOpening.at.x + (d[0] as number), doorOpening.at.y + (d[1] as number)],
          exact: true,
        });
        continue;
      }
      const side = st.front ?? "S";
      const at: Vec2 =
        side === "N"
          ? [w0.x + Math.floor(w0.w / 2), w0.y - 2]
          : side === "S"
            ? [w0.x + Math.floor(w0.w / 2), w0.y + w0.h + 1]
            : side === "W"
              ? [w0.x - 2, w0.y + Math.floor(w0.h / 2)]
              : [w0.x + w0.w + 1, w0.y + Math.floor(w0.h / 2)];
      targets.push({ id: st.id, at });
    }
    const clip = this.rasterClip();
    for (const t of targets) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const p of pathCells) {
        const d = Math.max(Math.abs(p[0] - t.at[0]), Math.abs(p[1] - t.at[1]));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      // generator 3 (exact targets): a path must touch the door cell or the focal piece, not merely pass near
      if (!best || bestD <= (t.exact ? 1 : 3)) continue;
      const seed = subSeed(elementSeed(this.plan.seed, t.id), "spur");
      for (const [x, y] of trailCells([best, t.at], 1, 0.4, seed, clip)) {
        const i = this.idx(x, y);
        if (i < 0 || this.state[i] !== CELL.OPEN) continue;
        if (((this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.PATH)) !== 0) continue;
        if (this.areas[(this.struct[i] as number) - 1]?.kind === "building") continue;
        this.setMaterial(i, material);
        this.flags[i] = (this.flags[i] as number) | CELL_FLAG.PATH;
        pathCells.push([x, y]);
      }
      if (t.exact) {
        const i = this.idx(t.at[0], t.at[1]);
        if (
          i >= 0 &&
          this.state[i] === CELL.OPEN &&
          ((this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.PATH)) === 0 &&
          this.areas[(this.struct[i] as number) - 1]?.kind !== "building"
        ) {
          this.setMaterial(i, material);
          this.flags[i] = (this.flags[i] as number) | CELL_FLAG.PATH;
          pathCells.push([t.at[0], t.at[1]]);
        }
      }
    }
  }

  /** A dress op over the whole level: the open ground (no area) and each zone area, each dressed as one region. */
  private dressWholeLevel(
    op: Extract<TerrainOp, { op: "dress" }>,
    path: string,
    grid: ReturnType<LevelSteps["grid"]>,
    cap: number,
    capWarn: (id: string, path: string) => void,
  ): void {
    const regions: Array<{ index: number; cells: Array<[number, number]> }> = [];
    const byIndex = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== CELL.OPEN) continue;
      const d = this.disp[i] as number;
      const a = d > 0 ? this.areas[d - 1] : undefined;
      if (d > 0 && a?.kind !== "zone") continue;
      const list = byIndex.get(d) ?? [];
      list.push(this.cellXY(i));
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
        seed: subSeed(elementSeed(this.plan.seed, op.id, op.seed), `region${r.index}`),
        remaining: cap - this.generated,
      });
      this.commitGenerated(op.id, res.placements);
      placed += res.placements.length;
      if (res.capped) {
        capWarn(op.id, path);
        break;
      }
    }
    if (placed === 0)
      this.issue("warning", "no_effect", `dress "${op.id}" placed nothing on level "${this.level.id}"`, {
        path,
        elementId: op.id,
        hint: "the level has no free open ground; raise density or dress a named area",
      });
  }

  private stepGeneratedFeatures(): void {
    const grid = this.grid();
    const cap = PLAN_LIMITS.generatedFeaturesPerLevel;
    const ops = this.level.terrain.map((op, k) => ({ op, k }));
    const capWarn = (id: string, path: string): void => {
      this.issue(
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
    this.stepDefaultCliffBands(grid, cap);
    for (const { op, k } of ops) {
      if (op.op !== "dress") continue;
      const path = `/levels/${this.li}/terrain/${k}`;
      if (op.area === undefined || op.area === this.level.id) {
        // generator 2: the whole level, region by region (the open ground outside areas, then each zone)
        if (this.gen.dressWholeLevel) this.dressWholeLevel(op, path, grid, cap, capWarn);
        continue;
      }
      const ai = this.areaIndexById.get(op.area);
      if (ai === undefined) {
        this.issue("error", "ref_unknown", `dress "${op.id}" names unknown area "${op.area}"`, {
          path: `${path}/area`,
          elementId: op.id,
          hint: `areas on ${this.level.id}: ${this.level.areas.map((a) => a.id).join(", ")}`,
        });
        continue;
      }
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < this.n; i++) if (this.disp[i] === ai + 1) cells.push(this.cellXY(i));
      const res = dressArea(grid, {
        preset: op.preset,
        areaIndex: ai + 1,
        areaCells: cells,
        density: op.density ?? 0.5,
        seed: elementSeed(this.plan.seed, op.id, op.seed),
        remaining: cap - this.generated,
        abandoned: (this.areas[ai] as AreaInfo).room.abandoned,
      });
      this.commitGenerated(op.id, res.placements);
      if (res.capped) capWarn(op.id, path);
      if (res.placements.length === 0 && !res.capped)
        this.issue("warning", "no_effect", `dress "${op.id}" placed nothing in "${op.area}"`, {
          path,
          elementId: op.id,
          hint: "the area has no free floor (too small, or full of features, links and water); dress a larger area or raise density",
        });
    }
    for (const { op, k } of ops) {
      if (op.op !== "scatter") continue;
      const path = `/levels/${this.li}/terrain/${k}`;
      const region = op.shape
        ? this.shapeCells(op.shape, "scatter", `${path}/shape`, op.id)
        : Array.from({ length: this.n }, (_, i) => i);
      const excluded = new Set<number>();
      (op.exclude ?? []).forEach((s) => {
        forEachMaskCell(rasterizeShape(s, { planSeed: this.plan.seed, clip: this.rasterClip() }), (x, y) => {
          const i = this.idx(x, y);
          if (i >= 0) excluded.add(i);
        });
      });
      const info = featureInfo(op.feature);
      const params = {
        feature: op.feature,
        candidates: region.filter((i) => !excluded.has(i)).map((i) => this.cellXY(i)),
        density: op.density,
        minSpacing: op.minSpacing ?? 1,
        avoid: new Set<AvoidKind>(op.avoid ?? ["water", "walls", "features", "links"]),
        randomRotation: op.randomRotation ?? info.organic,
        seed: elementSeed(this.plan.seed, op.id, op.seed),
        remaining: cap - this.generated,
        // generator 2: natural pieces scatter in drifts and clumps, never an even lattice
        drift: this.gen.naturalScatter && info.organic,
        supported: this.gen.naturalScatter,
      };
      const res = scatterFeatures(grid, op.variants ? { ...params, variants: op.variants } : params);
      this.commitGenerated(op.id, res.placements);
      if (res.capped) capWarn(op.id, path);
      if (res.placements.length === 0 && !res.capped && op.density > 0)
        this.issue("warning", "no_effect", `scatter "${op.id}" placed no ${op.feature}`, {
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
  private stepDefaultCliffBands(grid: PlacementGrid, cap: number): void {
    if (!this.gen.defaultCliffBands || this.level.cliffBands === false) return;
    const base = this.level.base;
    if (base.type !== "ground" || !NATURAL_PATH.has(base.material)) return;
    if ((this.level.structures ?? []).some((st) => st.kind !== "enclosure")) return;
    const byIndex = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== CELL.OPEN) continue;
      const d = this.disp[i] as number;
      const a = d > 0 ? this.areas[d - 1] : undefined;
      if (d > 0 && a?.kind !== "zone") continue;
      const list = byIndex.get(d) ?? [];
      list.push(this.cellXY(i));
      byIndex.set(d, list);
    }
    // every region is planned before any piece is committed: rocks of neighbouring zones overlap on purpose, and a
    // committed piece would read as a feature in the way of the next zone's band
    const planned: Array<{ id: string; placements: GeneratedPlacement[] }> = [];
    let room = cap - this.generated;
    for (const [index, cells] of [...byIndex.entries()].sort((p, q) => p[0] - q[0])) {
      const res = defaultCliffBands(grid, {
        areaIndex: index,
        areaCells: cells,
        seed: elementSeed(this.plan.seed, `${this.level.id}~cliffbands~${index}`),
        remaining: room,
      });
      planned.push({ id: `${this.level.id}~bands${index}`, placements: res.placements });
      room -= res.placements.length;
      if (res.capped || room <= 0) break;
    }
    for (const r of planned) this.commitGenerated(r.id, r.placements);
  }

  // ───────────────────────────── step 10 + output ─────────────────────────────

  toResolved(): ResolvedLevel {
    const { w, h, n } = this;
    // materials in first-appearance order (row-major)
    const materials: Material[] = [];
    const matMap = new Map<number, number>();
    const material: number[] = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (!this.isFloor(i)) continue;
      const m = this.mat[i] as number;
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
    for (let i = 0; i < n; i++) height[i] = this.state[i] === CELL.OPEN ? (this.height[i] as number) : 0;

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
          const [a, b] = this.edgeCells(orient, i);
          const forced = e.hostSet[i] as number;
          host[i] = forced >= 0 ? forced : this.hostOf(a, b, e.run[i] === 1);
        } else host[i] = 0;
      }
      return { kind, ref, height: hgt, host };
    };
    const hEdges = grid("h", this.hE);
    const vEdges = grid("v", this.vE);

    // areas
    const dispCells: number[][] = this.areas.map(() => []);
    for (let i = 0; i < n; i++) {
      const d = this.disp[i] as number;
      if (d > 0) (dispCells[d - 1] as number[]).push(i);
    }
    const areas: ResolvedArea[] = this.areas.map((info) => {
      const cells = dispCells[info.index] as number[];
      const openCells = cells.filter((i) => this.state[i] === CELL.OPEN);
      if (cells.length === 0) {
        this.issue(
          "error",
          "area_empty",
          info.isRoute
            ? `corridor "${info.area.id}" has no cells: its endpoints already touch or every cell on its path belongs to another area`
            : `area "${info.area.id}" has no cells (its shape is empty, outside the level, or covered by later areas)`,
          {
            path: `/levels/${this.li}/areas/${info.index}`,
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
        const [x, y] = this.cellXY(i);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const bbox =
        cells.length > 0
          ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
          : { x: this.bx, y: this.by, w: 0, h: 0 };
      const anchor = this.anchorOf(openCells.length > 0 ? openCells : cells) ?? [this.bx, this.by];
      const set = new Uint8Array(n);
      for (const i of cells) set[i] = 1;
      const outline =
        cells.length > 0
          ? traceRings(
              bbox.w,
              bbox.h,
              (ux, uy) => set[(bbox.y - this.by + uy) * w + (bbox.x - this.bx + ux)] === 1,
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
      if (this.gen.roomClassification) {
        if (info.room.purpose !== undefined) ra.purpose = info.room.purpose;
        if (info.room.abandoned) ra.abandoned = true;
        ra.finish = info.rough ? "rough" : "tidy";
      }
      return ra;
    });

    const lvl: ResolvedLevel = {
      id: this.level.id,
      name: this.level.name,
      elevation: this.level.elevation,
      bounds: { x: this.bx, y: this.by, w, h },
      cells: {
        state: Array.from(this.state),
        area: Array.from(this.disp),
        material,
        height,
        flags: Array.from(this.flags),
        theme: Array.from(this.theme),
      },
      areaIds: this.areas.map((a) => a.area.id),
      materials,
      themes: this.themes.slice(),
      wallStyles,
      hEdges,
      vEdges,
      areas,
      openings: this.openings,
      features: this.features,
      labels: this.level.labels.map((l) => ({
        id: l.id,
        text: l.text,
        at: [l.at[0], l.at[1]] as Vec2,
        size: l.size ?? "m",
      })),
    };
    if (this.bridges.length > 0) lvl.bridges = this.bridges;
    if (this.outcrops.length > 0) lvl.outcrops = this.outcrops;
    if (this.kerbs.length > 0) lvl.kerbs = this.kerbs;
    if (this.roads.length > 0) lvl.roads = this.roads;
    if (this.ramps.length > 0) lvl.ramps = this.ramps;
    if (this.gen.cliffRockBand) {
      const cliffs = cliffRuns(lvl);
      if (cliffs.length > 0) lvl.cliffs = cliffs;
    }
    if (this.gen.foundation) {
      lvl.foundation = this.level.foundation ?? (this.level.base.type === "ground" ? 2 : 0);
      const wl = this.waterSurface();
      if (wl !== null) lvl.waterLevel = wl;
    }
    if (this.gen.floorOpenings && this.floorOpenings.length > 0)
      lvl.floorOpenings = this.floorOpenings.map((fo) => ({
        id: fo.id,
        kind: fo.kind,
        cells: fo.cells.map((i) => this.cellXY(i) as Vec2),
        ...(fo.below !== undefined ? { below: fo.below } : {}),
        floorBelow: fo.floorBelow,
        hiddenEdge: fo.hiddenEdge,
        edgeCells: fo.edgeCells,
      }));
    if (this.gen.wanderingChannels) {
      if (this.channels.length > 0) lvl.channels = this.channels;
      if (this.falls.length > 0) lvl.falls = this.falls;
      if (this.waterRange !== null) lvl.waterRange = this.waterRange;
    }
    if (this.resolvedLines.length > 0) lvl.lines = this.resolvedLines;
    if (this.structs) Object.assign(lvl, this.structs.finish(this.level.elevation));
    // the walls of a built interior vary in height (resolve/wallTops.ts)
    if (this.gen.interiorWallTops && this.level.base.type === "solid") {
      if (!this.structs) roughWallTops(lvl, String(elementSeed(this.plan.seed, `${this.level.id}~walltops`, undefined)));
      // stepRoomFloors raises rooms in every solid-based level: the walls beside them are shortened by the step
      settleWallHeights(lvl);
    }
    return lvl;
  }

  /**
   * The level's water surface (absolute tiles), for TaleSpire's board-wide water plane: half a tile below the
   * lowest dry floor that touches water, but at least a quarter tile above the highest water bed. Warns when other dry
   * walkable floor (a dry pit, a lava rift, a cellar) lies below it, since the plane would flood it.
   */
  private nearWater(i: number, r: number): boolean {
    const [x, y] = this.cellXY(i);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const j = this.idx(x + dx, y + dy);
        if (j >= 0 && ((this.flags[j] as number) & CELL_FLAG.WATER) !== 0) return true;
      }
    return false;
  }

  private waterSurface(report = true): number | null {
    const water: number[] = [];
    // the upper reaches of a stepped river lie above the board plane: they do not set it
    for (let i = 0; i < this.n; i++)
      if (this.isFloor(i) && (this.flags[i] as number) & CELL_FLAG.WATER && !this.upperReach.has(i))
        water.push(i);
    if (water.length === 0) return null;
    const top = (i: number): number => this.level.elevation + (this.height[i] as number) / 4 + 0.5;
    let bank = Infinity;
    let bed = -Infinity;
    for (const i of water) {
      bed = Math.max(bed, top(i));
      for (const j of this.neighbours4(i))
        if (j >= 0 && this.isFloor(j) && ((this.flags[j] as number) & CELL_FLAG.WATER) === 0)
          bank = Math.min(bank, top(j));
    }
    if (this.falls.length > 0) {
      const lo = bed + 0.25;
      this.waterRange = [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
    }
    // aim half a tile below the lowest bank (room for an imprecise setting either way), never below the beds
    const surface = Number.isFinite(bank) ? Math.max(bed + 0.25, bank - 0.5) : bed + 0.25;
    let low: number | null = null;
    let lowCount = 0;
    const checks = this.gen.waterLevelChecks;
    for (let i = 0; i < this.n; i++) {
      if (!this.isFloor(i) || (this.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) continue;
      if (top(i) < surface) {
        // generator 3: a trail cell on a channel's bed beside water is a ford; it is meant to be wet
        if (
          checks &&
          ((this.flags[i] as number) & CELL_FLAG.PATH) !== 0 &&
          this.nearWater(i, 2)
        )
          continue;
        lowCount++;
        low ??= i;
      }
    }
    // generator 3: water cells above the plane stay dry in game (the upper reaches of a stepped river): the slab cannot
    // carry a second water level and the palettes have no piece that reads as water, so say so
    if (checks) {
      let dry = 0;
      let first: number | null = null;
      for (const i of this.upperReach) {
        if (this.isFloor(i) && ((this.flags[i] as number) & CELL_FLAG.WATER) !== 0 && top(i) >= surface + 0.25 - 1e-6) {
          dry++;
          first ??= i;
        }
      }
      if (report && dry > 0 && first !== null) {
        const [x, y] = this.cellXY(first);
        this.issue(
          "warning",
          "water_level",
          `${dry} water cell${dry > 1 ? "s lie" : " lies"} above the level's water surface (${surface} tiles) and will stay dry in game: TaleSpire has one flat water plane and the palettes have no piece that reads as water, so the upper reaches of a stepped river are dry beds`,
          {
            elementId: this.level.id,
            cell: [x, y],
            hint: "keep a river on one level, on the low ground or in a cut, with terraces beside it; step it only if dry upper reaches suit the scene",
          },
        );
      }
    }
    if (report && low !== null) {
      const [x, y] = this.cellXY(low);
      this.issue(
        "warning",
        "water_level",
        `${lowCount} dry floor cell${lowCount > 1 ? "s lie" : " lies"} below this level's water surface (${surface} tiles): TaleSpire's water plane is one height for the whole board and would flood ${lowCount > 1 ? "them" : "it"}`,
        {
          elementId: this.level.id,
          cell: [x, y],
          hint: "keep water and floor that must stay dry apart in height (raise the dry part, or lower the water's channel), or make that floor water too",
        },
      );
    }
    return surface;
  }
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
