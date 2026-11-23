/**
 * Structures (generator 2): buildings and enclosures.
 *
 * A building's GROUND STOREY becomes an ordinary area of kind "building" (id = the building's id) with its doors and
 * windows as ordinary openings, so walkability, playability checks, the 2D view, the room key and hit-testing treat
 * it like any building. An enclosure becomes a yard area plus fence edges and gates. What only the build needs
 * (wall courses, upper storeys, roof, chimneys, porches, lights) goes into ResolvedLevel.structures and is built by
 * compile/structure.ts.
 *
 * Rules a kind of building follows come from its style profile (structureStyles.ts); choices the plan leaves open are
 * drawn from the profile's ranges with the building's seed, so two buildings of one style differ and the same plan
 * always builds the same building.
 *
 * Hooks in the level resolver (resolve/level.ts, resolve/level/*): `expandStructures` (the `ResolveGrid` constructor,
 * resolve/level/grid.ts), `StructureWork.afterAreas` / `afterTerrain` (flatten the
 * pad), `afterOpenings` (force hosts outside, reserve cells, build the records), `reservedCell` (dressing),
 * `finish` (records + issue paths) — nothing else in the resolver knows about structures.
 */
import type {
  Area,
  Building,
  Enclosure,
  Level,
  MapPlan,
  Opening,
  PlanIssue,
  Plinth,
  RoofType,
  Side,
  Structure,
  TerrainOp,
  Vec2,
  Volume,
  WallRun,
  WallStyle,
} from "../contracts/plan";
import { BUILD_CONSTANTS } from "../contracts/plan";
import type { ResolvedLevel, ResolvedStructure, ResolvedVolume } from "../contracts/resolved";
import { wallStyleInfo } from "../gen/wallStyles";
import type { PaletteView } from "../palette/view";
import { own } from "../util/own";
import { roofKitInfo, roofTone } from "./roofKits";
import { roofInfo } from "./roofTypes";
import { themeRange, type ThemeRange } from "./themeRange";
import { drawStructureOption } from "./recipes/treatments";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { OPPOSITE, SIDE_STEP as STEP, SIDES } from "../gen/gridGeometry";
import { forEachMaskCell } from "../gen/mask";
import { generatorProfile, type GeneratorProfile } from "../plan/generator";
import { withWings } from "../plan/building";
import { rasterizeShape } from "../gen/shapes";
import { elementSeed, subSeed } from "../util/hash";
import { applyCondition, buildingSubjectOf } from "./building/condition";
import { type CharacterMap, characterAt } from "./character";
import { applyWear } from "./building/wear";
import { frontCanopies, type FrontCanopy } from "./building/canopy";
import { startBuilding } from "./building/context";
import { BuildingFaces, drawFrontage, placeChimneys, placeOpenings, placeWindows } from "./building/faces";
import {
  doorLightsByLight,
  drawLighting,
  drawPlinth,
  drawRoofFurniture,
  placeDoorLights,
  reservedCells,
} from "./building/fittings";
import { isPassage, isSecret } from "../gen/openingKinds";
import { along, faceRuns, key, ringOf } from "./building/footprint";
import { placePorches } from "./building/porches";
import { splitGroundStorey } from "./building/rooms";
import { buildingKind, furnishedCharacter, programmeCharacter } from "../gen/buildingProgramme";
import type { RoomKind } from "../gen/roomPurpose";
import { THEME_WALL_STYLE } from "../gen/wallStyles";
import type { BuildingPlan, StoreyPlan, VolumePlan } from "./building/types";
import { groundFootprint, planVolumes, volumeSpecs } from "./building/volumes";
import {
  type BuildingDesign,
  type DesignSpace,
  type Weights,
  designable,
  designSpaceFor,
  drawDesign as drawDesignOf,
  expandDesign,
  lowerMassReachesMain,
} from "./structureVariety";
import { structureStyle } from "./structureStyles";
import { maxOf, minOf } from "../util/lists";

/** A building's ground floor plane (absolute tiles): its pad over the level's floor; storeys stand on it. */
const groundFloorBase = (b: BuildingPlan, elevation: number): number =>
  elevation + BUILD_CONSTANTS.floorThickness + (b.pad ?? 0) / 4;

interface EnclosurePlan {
  st: Enclosure;
  si: number;
  theme: string;
  cells: Array<[number, number]>;
  cellSet: Set<string>;
  fence: WallStyle | null;
  gates: Array<{ id: string; at: Vec2; side: Side }>;
}

/** Everything the level resolver needs to know about its structures. */
export class StructureWork {
  readonly buildings: BuildingPlan[] = [];
  readonly enclosures: EnclosurePlan[] = [];
  /** Ground cells of every building in the level (rects of wings / ground volumes), filled before planning, so a
   * building knows its neighbours: no windows or default door on a party wall. */
  readonly neighbours = new Map<string, string>();
  /** Generator 3: the entrance kind each building drew, in list order (the next one differs). */
  readonly entrances: string[] = [];
  /** Designs drawn from the style's design space (variety), and the building spec they expand into. */
  readonly designs = new Map<string, { design: BuildingDesign; building: Building }>();
  /** Generator 5 (`buildingRooms`): each ground-storey room's area id → the building it partitions. */
  readonly roomBuilding = new Map<string, string>();
  /** Generator 5 (`sleepingCorners`): a ground-storey room's area id → the other kinds it holds a zone of. */
  readonly roomZones = new Map<string, readonly RoomKind[]>();
  /** Generator 5 (`buildingRooms`): the interior doorways between a building's rooms (not ways in from outside). */
  readonly interiorOpenings = new Set<string>();
  /** Plan list lengths: synthetic areas / openings / wall runs come after these indices. */
  readonly planCounts: { areas: number; openings: number; walls: number; terrain: number };
  reservedMask: Uint8Array | null = null;
  private readonly li: number;
  private readonly levelId: string;
  private readonly issues: PlanIssue[];
  private readonly issueStart: number;

  constructor(
    level: Level,
    li: number,
    issues: PlanIssue[],
    private readonly gen: GeneratorProfile,
    /** Generator 5 (characterCascade): the level's characters (resolve/character.ts); null when off. */
    readonly characters: CharacterMap | null = null,
  ) {
    this.li = li;
    this.levelId = level.id;
    this.issues = issues;
    this.issueStart = issues.length;
    this.planCounts = {
      areas: level.areas.length,
      openings: level.openings.length,
      walls: level.walls.length,
      terrain: level.terrain.length,
    };
  }

  get empty(): boolean {
    return this.buildings.length === 0 && this.enclosures.length === 0;
  }

  issue(
    severity: PlanIssue["severity"],
    si: number,
    id: string,
    message: string,
    hint: string,
    cell?: Vec2,
  ): void {
    const is: PlanIssue = {
      severity,
      code: "structure_invalid",
      message,
      levelId: this.levelId,
      path: `/levels/${this.li}/structures/${si}`,
      elementId: id,
      hint,
    };
    if (cell) is.cell = cell;
    this.issues.push(is);
  }

  /** Every footprint / yard cell of every structure (for overlap checks). */
  occupied(): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of this.buildings) for (const c of b.cells) m.set(key(c[0], c[1]), b.st.id);
    return m;
  }

  // ───────────────────────────── resolver hooks ─────────────────────────────

  /** After the areas: flatten each building's pad (footprint, wall ring, porch) to one height. */
  afterAreas(w: LevelLike): void {
    for (const b of this.buildings) {
      // the pad sits at the median ground height under the footprint (a house on a slope is dug in on the high
      // side and stands on its footing on the low side, instead of towering over the lowest corner)
      const hs: number[] = [];
      for (const [x, y] of b.cells) {
        const i = w.idx(x, y);
        if (i >= 0) hs.push(w.height[i] as number);
      }
      hs.sort((p, q) => p - q);
      b.pad =
        (hs.length > 0 ? (hs[Math.floor((hs.length - 1) / 2)] as number) : 0) +
        Math.round((b.plinth?.height ?? 0) * 4);
      this.flatten(w, b);
    }
  }

  /** After the over-layer terrain (uneven ground, platforms…): the pad stays flat. */
  afterTerrain(w: LevelLike): void {
    for (const b of this.buildings) {
      // never below the ground in front of a door (a raised pavement): the floor is level with it or above
      const plinthQ = Math.round((b.plinth?.height ?? 0) * 4);
      // generator 5 (plinthUnderPorch): the ground in front is the first cell past the building's own pad (its porch
      // and plinth), never a cell of the pad itself, which afterAreas already raised by the plinth (counted twice, a
      // porch-fronted plinth stood two tiles up)
      const own = this.gen.plinthUnderPorch
        ? new Set<string>([
            ...b.cellSet,
            ...b.porches.flatMap((p) => p.cells.map((c) => key(c[0], c[1]))),
            ...(b.plinth?.cells ?? []).map((c) => key(c[0], c[1])),
          ])
        : null;
      let front = -Infinity;
      for (const g of b.ground) {
        if (!isPassage(g.kind)) continue;
        const [dx, dy] = STEP[g.side];
        for (let k = 0; k < g.width; k++) {
          const ax = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
          const ay = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
          let reach = 2 + (b.plinth ? b.plinth.margin : 0);
          while (own?.has(key(ax + dx * reach, ay + dy * reach)) === true && reach < 16) reach++;
          const i = w.idx(ax + dx * reach, ay + dy * reach);
          if (i >= 0 && w.state[i] === CELL.OPEN) front = Math.max(front, w.height[i] as number);
        }
      }
      if (Number.isFinite(front) && (b.pad ?? 0) - plinthQ < front) {
        b.ringPad ??= b.pad ?? 0;
        b.pad = front + plinthQ;
      }
      this.flatten(w, b);
    }
  }

  private flatten(w: LevelLike, b: BuildingPlan): void {
    const pad = b.pad ?? 0;
    const cells = new Set<string>([...b.cellSet, ...ringOf(b.cellSet)]);
    for (const p of b.porches) for (const c of p.cells) cells.add(key(c[0], c[1]));
    for (const c of b.plinth?.cells ?? []) cells.add(key(c[0], c[1]));
    // a pad raised to the pavement lifts the floor, not the ground round the other faces (an alley stays low)
    const lifted = new Set<string>([
      ...b.cellSet,
      ...b.porches.flatMap((p) => p.cells.map((c) => key(c[0], c[1]))),
    ]);
    for (const c of b.plinth?.cells ?? []) lifted.add(key(c[0], c[1]));
    for (const k of cells) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const i = w.idx(x, y);
      if (i < 0 || w.state[i] !== CELL.OPEN) continue;
      if ((w.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.BRIDGE)) continue;
      if (!b.cellSet.has(k) && this.otherFootprint(k, b.st.id)) continue;
      w.height[i] = lifted.has(k) || b.ringPad === undefined ? pad : b.ringPad;
    }
  }

  private otherFootprint(k: string, id: string): boolean {
    return this.buildings.some((o) => o.st.id !== id && o.cellSet.has(k));
  }

  /** After the openings: walls host outside the footprint, reserved cells, problems that need the grid. */
  afterOpenings(w: LevelLike): void {
    // a party wall between two buildings stands outside the earlier one (which builds it): host the later ones first
    for (const b of [...this.buildings].reverse()) forceHostsOutside(w, b.cellSet);
    // generator 4 (`partyWallsOutsideTaller`): unless the earlier one's walls there stop below the later one's ground
    // storey; they cannot close it then, so the later one builds its ground storey's wall itself (compile/structure.ts
    // `party`) on its own outside, and that is the wall the edge describes
    if (this.gen.partyWallsOutsideTaller)
      this.buildings.forEach((b, i) => {
        for (const o of this.buildings.slice(0, i)) hostOutsideWhereTaller(w, b, o);
      });
    for (const b of this.buildings) {
      for (const g of b.ground) {
        const [dx, dy] = STEP[g.side];
        for (let k = 0; k < g.width; k++) {
          const off = g.side === "N" || g.side === "S" ? [k, 0] : [0, k];
          const ox = g.at[0] + (off[0] as number) + dx;
          const oy = g.at[1] + (off[1] as number) + dy;
          const i = w.idx(ox, oy);
          if (isPassage(g.kind) && (i < 0 || w.state[i] !== CELL.OPEN)) {
            this.issue(
              "error",
              b.si,
              b.st.id,
              `building "${b.st.id}": the ${g.kind} on its ${g.side} face (${g.at[0]},${g.at[1]}) opens onto ${i < 0 ? "the level edge" : "rock or void"}`,
              "put the door on a face that looks onto open ground, or move the building away from the edge",
              g.at,
            );
            break;
          }
        }
      }
    }
    // facade details that stand at head height in the ring: corner piers, service pipes and units on the back
    for (const b of this.buildings) {
      const des = this.designs.get(b.st.id)?.design;
      if (!des) continue;
      const mark = (x: number, y: number): void => {
        const i = w.idx(x, y);
        if (i >= 0 && !b.cellSet.has(key(x, y))) w.flags[i] = (w.flags[i] as number) | CELL_FLAG.FEATURE;
      };
      if (des.details.includes("piers"))
        for (const k of b.cellSet) {
          const [cx, cy] = k.split(",").map(Number) as [number, number];
          for (const [dx, dy] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ] as const)
            if (
              !b.cellSet.has(key(cx + dx, cy)) &&
              !b.cellSet.has(key(cx, cy + dy)) &&
              !b.cellSet.has(key(cx + dx, cy + dy))
            ) {
              mark(cx + dx, cy + dy); // the pier stands over the diagonal ring cell only
            }
        }
      if (des.details.includes("services")) {
        const front = this.designs.get(b.st.id)?.building.front ?? "S";
        const back = OPPOSITE[front];
        const run = faceRuns(b.cellSet, back).sort((p, q) => q.cells.length - p.cells.length)[0];
        if (run && run.cells.length >= 2) {
          const [dx, dy] = STEP[back];
          for (const c of [
            run.cells[0],
            run.cells[run.cells.length - 1],
            run.cells[Math.floor(run.cells.length / 2)],
          ])
            if (c) mark(c[0] + dx, c[1] + dy);
        }
      }
    }
    // rubble and growth of a weathered or ruined building
    for (const b of this.buildings)
      for (const d of b.debris) {
        const i = w.idx(d.at[0], d.at[1]);
        if (i >= 0 && w.state[i] === CELL.OPEN) w.flags[i] = (w.flags[i] as number) | CELL_FLAG.FEATURE;
      }
    // generator 3: the ring cell outside a wall that vines or roots climb (the strands stand in it, hard against the wall)
    for (const b of this.buildings)
      for (const g of b.growth) {
        if ((g.kind !== "vine" && g.kind !== "root") || !g.side) continue;
        const [dx, dy] = STEP[g.side];
        const i = w.idx(g.at[0] + dx, g.at[1] + dy);
        if (i >= 0 && w.state[i] === CELL.OPEN) w.flags[i] = (w.flags[i] as number) | CELL_FLAG.FEATURE;
      }
    // chimney breasts stand in their ring cell: nothing else may stand or walk there
    for (const b of this.buildings)
      for (const c of b.chimneys) {
        const i = w.idx(c.at[0], c.at[1]);
        if (i >= 0) w.flags[i] = (w.flags[i] as number) | CELL_FLAG.FEATURE;
        // generator 3: the stack's foot is three wide: its two side cells are taken too (when they are outside the walls)
        if (b.valleys) {
          const [dx, dy] = STEP[c.side];
          for (const s of [1, -1]) {
            const lx = c.at[0] + Math.abs(dy) * s;
            const ly = c.at[1] + Math.abs(dx) * s;
            const j = w.idx(lx, ly);
            if (j >= 0 && !b.cellSet.has(key(lx, ly)) && w.state[j] === CELL.OPEN)
              w.flags[j] = (w.flags[j] as number) | CELL_FLAG.FEATURE;
          }
        }
      }
    // door lights hang in the ring cell beside the door
    for (const b of this.buildings)
      for (const l of b.lights) {
        const [dx, dy] = STEP[l.side];
        const i = w.idx(l.at[0] + dx, l.at[1] + dy);
        if (i >= 0) w.flags[i] = (w.flags[i] as number) | CELL_FLAG.FEATURE;
      }
    for (const e of this.enclosures) forceHostsOutside(w, e.cellSet);
    const mask = new Uint8Array(w.n);
    let any = false;
    for (const b of this.buildings)
      for (const k of b.reserve) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        if (b.cellSet.has(k)) continue;
        const i = w.idx(x, y);
        if (i >= 0) {
          mask[i] = 1;
          any = true;
        }
      }
    this.reservedMask = any ? mask : null;
  }

  reservedCell(i: number): boolean {
    return this.reservedMask !== null && this.reservedMask[i] === 1;
  }

  /**
   * Every building's canopies and awnings over its street front (resolve/building/canopy.ts, the answer realize lays
   * them by), at the heights `finish` gives the building: read once the pads are known (after `afterTerrain`).
   */
  canopies(elevation: number): Array<{ canopy: FrontCanopy; theme: string }> {
    return this.buildings.flatMap((b) => {
      const base = groundFloorBase(b, elevation);
      const foreign = new Set<string>();
      for (const o of this.buildings) if (o !== b) for (const k of o.cellSet) foreign.add(k);
      const design = this.designs.get(b.st.id)?.design;
      return frontCanopies(
        {
          cells: b.cells,
          frontage: b.frontage,
          condition: b.condition,
          design,
          storeys: b.storeys.map((s) => ({
            floorTop: base + s.relFloor,
            footing: s.footing,
            walls: s.walls,
          })),
        },
        foreign,
      ).map((canopy) => ({ canopy, theme: b.theme }));
    });
  }

  /** Records for ResolvedLevel and issue paths that point at synthetic elements (called once, from toResolved). */
  finish(elevation: number): Pick<ResolvedLevel, "structures" | "reserved"> {
    this.remapIssues();
    if (this.empty) return {};
    const out: ResolvedStructure[] = [];
    for (const e of this.enclosures) {
      out.push({
        id: e.st.id,
        kind: "enclosure",
        style: "enclosure",
        theme: e.theme,
        cells: e.cells.map(([x, y]) => [x, y] as Vec2),
        wings: [],
        storeys: [],
        openingIds: e.gates.map((g) => g.id),
        upperOpenings: [],
        roof: { type: "none", requested: "none", style: "", deck: false, broken: 0, parapet: null },
        chimneys: [],
        porches: [],
        fence: { style: e.fence, gates: e.gates.map((g) => ({ at: g.at, side: g.side })) },
        lights: [],
      });
    }
    for (const b of this.buildings) {
      const base = groundFloorBase(b, elevation);
      const storeys: ResolvedStructure["storeys"] = b.storeys.map((s) => ({
        floorTop: base + s.relFloor,
        footing: s.footing,
        walls: s.walls,
        wallHeight: s.wallHeight + (s.footing?.height ?? 0),
        floor: s.floor,
      }));
      const volumes: ResolvedVolume[] = b.volumes.map((v) => ({
        id: v.id,
        on: v.on,
        corners: v.corners,
        rects: v.rects.map((r) => ({ ...r })),
        storeys: v.storeys.map((s) => ({
          floorTop: base + s.relFloor,
          wallTop: base + s.relTop,
          cells: s.cells.map(([x, y]) => [x, y] as Vec2),
          rect: { ...s.rect },
          footing: s.footing,
          walls: s.walls,
          floor: s.floor,
          seam: s.seam,
        })),
        roof: {
          layers: v.roof.layers,
          deck: v.roof.deck,
          broken: v.roof.broken,
          ...(v.roof.gableOnly ? { gableOnly: v.roof.gableOnly } : {}),
        },
      }));
      const rec: ResolvedStructure = {
        id: b.st.id,
        kind: "building",
        style: b.profile.id,
        theme: b.theme,
        cells: b.cells.map(([x, y]) => [x, y] as Vec2),
        wings: b.wings,
        storeys,
        openingIds: b.ground.map((g) => g.id),
        upperOpenings: b.upper,
        roof: b.roof,
        chimneys: b.chimneys.map((c) => ({ at: c.at, side: c.side })),
        porches: b.porches.map((p) => ({
          cells: p.cells,
          side: p.side,
          floor: p.floor,
          roof: p.roof,
          ...(p.sag !== undefined ? { sag: p.sag } : {}),
          ...(p.posts !== undefined ? { posts: p.posts } : {}),
        })),
        ...(b.roofPatch ? { roofPatch: b.roofPatch } : {}),
        lights: b.lights,
        volumes,
        furniture: b.furniture,
        lighting: b.lighting,
        frontage: b.frontage,
        condition: b.condition,
        ...(b.valleys ? { valleys: true } : {}),
        ...(b.roofFill ? { roofFill: true } : {}),
        ...(b.debris.length > 0 ? { debris: b.debris } : {}),
        ...(b.growth.length > 0
          ? { growth: b.growth.map((g) => ({ ...g, from: base + g.from, to: base + g.to })) }
          : {}),
        ...(b.growthLevel ? { growthLevel: b.growthLevel } : {}),
        ...(b.ruin
          ? {
              ruin: {
                columns: b.ruin.columns.map((c) => ({
                  at: c.at,
                  side: c.side,
                  top: base + c.top,
                  full: base + c.full,
                })),
                holes: b.ruin.holes,
                anchor: b.ruin.anchor,
                loss: b.ruin.loss,
                ...(b.ruin.roofHoles ? { roofHoles: b.ruin.roofHoles } : {}),
                ...(b.ruin.weather ? { weather: b.ruin.weather } : {}),
                ...(b.ruin.arches ? { arches: b.ruin.arches } : {}),
                ...(b.ruin.keep !== undefined ? { keep: b.ruin.keep } : {}),
                ...(b.ruin.bays ? { bays: b.ruin.bays } : {}),
                ...(b.ruin.topRubble
                  ? { topRubble: b.ruin.topRubble.map((t) => ({ ...t, top: base + t.top })) }
                  : {}),
              },
            }
          : {}),
        ...(this.designs.get(b.st.id)
          ? { design: (this.designs.get(b.st.id) as { design: BuildingDesign }).design }
          : {}),
        seed: b.seed,
      };
      if (b.plinth)
        rec.plinth = {
          height: b.plinth.height,
          face: b.plinth.face,
          rim: b.plinth.rim,
          cells: b.plinth.cells,
        };
      out.push(rec);
    }
    const res: Pick<ResolvedLevel, "structures" | "reserved"> = { structures: out };
    if (this.reservedMask) {
      const r: number[] = [];
      for (let i = 0; i < this.reservedMask.length; i++) if (this.reservedMask[i]) r.push(i);
      res.reserved = r;
    }
    return res;
  }

  /** Issues about synthetic areas / openings / wall runs point at their structure instead. */
  private remapIssues(): void {
    const owners = new Map<string, number>();
    for (const b of this.buildings) {
      owners.set(b.st.id, b.si);
      for (const g of b.ground) owners.set(g.id, b.si);
      for (const p of b.porches) owners.set(p.id, b.si);
    }
    for (const e of this.enclosures) {
      owners.set(e.st.id, e.si);
      for (const g of e.gates) owners.set(g.id, e.si);
    }
    const synthetic = (path: string | undefined): boolean => {
      if (!path) return false;
      const m = /^\/levels\/(\d+)\/(areas|openings|walls|terrain)\/(\d+)/.exec(path);
      if (!m || Number(m[1]) !== this.li) return false;
      const list = m[2] as "areas" | "openings" | "walls" | "terrain";
      return Number(m[3]) >= this.planCounts[list];
    };
    for (let k = this.issueStart; k < this.issues.length; k++) {
      const is = this.issues[k] as PlanIssue;
      if (is.levelId !== undefined && is.levelId !== this.levelId) continue;
      const id = is.elementId ?? "";
      const base = id.includes("~") ? id.slice(0, id.indexOf("~")) : id;
      const si = owners.get(id) ?? owners.get(base);
      if (si === undefined || !(synthetic(is.path) || id.includes("~"))) continue;
      is.elementId = base;
      is.path = `/levels/${this.li}/structures/${si}`;
    }
  }
}

/** The parts of the resolver's `ResolveGrid` the hooks use (keeps this module independent of the resolver class). */
export interface LevelLike {
  readonly n: number;
  readonly state: Uint8Array;
  readonly height: Int16Array;
  readonly flags: Uint8Array;
  idx(x: number, y: number): number;
  sideEdge(
    x: number,
    y: number,
    side: Side,
  ): { e: { kind: Uint8Array; hostSet: Int8Array }; i: number } | null;
}

/**
 * The top of a building's walls over one of its cells (above the level's ground: its pad and the storey's top), the
 * highest storey standing on the cell, or only the ground storey of the ground volume standing on it.
 */
function wallTopAt(b: BuildingPlan, k: string, groundOnly: boolean): number {
  let top = -Infinity;
  for (const v of b.volumes)
    v.storeys.forEach((sp, s) => {
      if (sp.cellSet.has(k) && (!groundOnly || (s === 0 && v.on === null))) top = Math.max(top, sp.relTop);
    });
  return top + (b.pad ?? 0) / 4;
}

/**
 * Party edges of the later building `b` against the earlier `o`: hosted outside `b` (in `o`'s cell) where `o`'s walls
 * stop below the top of `b`'s ground storey.
 */
function hostOutsideWhereTaller(w: LevelLike, b: BuildingPlan, o: BuildingPlan): void {
  for (const k of b.cellSet) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const side of SIDES) {
      const [dx, dy] = STEP[side];
      const n = key(x + dx, y + dy);
      if (!o.cellSet.has(n) || wallTopAt(o, n, false) >= wallTopAt(b, k, true) - 1e-6) continue;
      const ed = w.sideEdge(x, y, side);
      if (!ed) continue;
      const kind = ed.e.kind[ed.i] as number;
      if (kind !== EDGE.WALL && kind !== EDGE.OPENING) continue;
      ed.e.hostSet[ed.i] = side === "N" || side === "W" ? 0 : 1;
    }
  }
}

function forceHostsOutside(w: LevelLike, cells: ReadonlySet<string>): void {
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const side of SIDES) {
      const [dx, dy] = STEP[side];
      if (cells.has(key(x + dx, y + dy))) continue;
      const ed = w.sideEdge(x, y, side);
      if (!ed) continue;
      const kind = ed.e.kind[ed.i] as number;
      if (kind !== EDGE.WALL && kind !== EDGE.OPENING) continue;
      // first cell of an edge is the north (h) / west (v) one
      ed.e.hostSet[ed.i] = side === "N" || side === "W" ? 0 : 1;
    }
  }
}

// ───────────────────────────── expansion ─────────────────────────────

/**
 * Turns the level's structures into synthetic areas, openings and wall runs (appended after the plan's own, so the
 * plan's indices are unchanged) plus the StructureWork that finishes them. Generator 1 levels are returned as is.
 */
export function expandStructures(
  plan: MapPlan,
  level: Level,
  li: number,
  issues: PlanIssue[],
  inBounds: (x: number, y: number) => boolean,
  characters: CharacterMap | null = null,
  /** The palettes as the resolver sees them (generator 5's style draw asks a theme's own range); absent: not asked. */
  palette: PaletteView | null = null,
): { level: Level; work: StructureWork | null } {
  const list = (level.structures ?? []).map(withWings);
  if (list.length === 0 || !generatorProfile(plan).buildings) return { level, work: null };
  const x = startExpansion(plan, level, li, issues, inBounds, list, characters, palette);
  addEnclosureYards(x);
  markNeighbourPlots(x);
  drawDesigns(x);
  followDrawnDesigns(x.work);
  addBuildings(x);
  addFencesAndGates(x);
  return expandedLevel(x);
}

/**
 * What every expansion step reads (the plan, the level, its structures, the shape rasterizer) and the record they fill:
 * the StructureWork and the synthetic areas, openings, wall runs and terrain, appended in step order.
 */
function startExpansion(
  plan: MapPlan,
  level: Level,
  li: number,
  issues: PlanIssue[],
  inBounds: (x: number, y: number) => boolean,
  list: Structure[],
  characters: CharacterMap | null,
  palette: PaletteView | null,
) {
  const work = new StructureWork(level, li, issues, generatorProfile(plan), characters);
  const areas: Area[] = [];
  const openings: Opening[] = [];
  const walls: WallRun[] = [];
  const terrain: TerrainOp[] = [];
  const clip = {
    x0: level.bounds.x - 1,
    y0: level.bounds.y - 1,
    x1: level.bounds.x + level.bounds.w,
    y1: level.bounds.y + level.bounds.h,
  };
  const cellsOfShape = (s: Parameters<typeof rasterizeShape>[0]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    forEachMaskCell(rasterizeShape(s, { planSeed: plan.seed, clip }), (x, y) => {
      if (inBounds(x, y)) out.push([x, y]);
    });
    return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  };
  const levelTheme = level.theme ?? plan.theme;
  return {
    plan,
    level,
    inBounds,
    list,
    work,
    areas,
    openings,
    walls,
    terrain,
    cellsOfShape,
    levelTheme,
    palette,
  };
}

type Expansion = ReturnType<typeof startExpansion>;

/** Enclosures first (painter order: buildings and porches claim their cells on top of a yard): a yard area each. */
function addEnclosureYards({ plan, list, work, areas, cellsOfShape, levelTheme }: Expansion): void {
  const quietZones = generatorProfile(plan).quietYardZones;
  list.forEach((st, si) => {
    if (st.kind !== "enclosure") return;
    const cells = cellsOfShape(st.shape);
    if (cells.length === 0) {
      work.issue(
        "error",
        si,
        st.id,
        `enclosure "${st.id}" covers no cell of the level`,
        "move its shape inside the level bounds",
      );
      return;
    }
    const cellSet = new Set(cells.map(([x, y]) => key(x, y)));
    const e: EnclosurePlan = {
      st,
      si,
      theme: st.theme ?? levelTheme,
      cells,
      cellSet,
      fence: st.wall === "none" ? null : (st.wall ?? "fence"),
      gates: [],
    };
    const zone = st.floor === undefined;
    // a zone takes no walls field (areas.ts warns that it does nothing); the fence is built from the enclosure's walls
    const yard: Area = {
      id: st.id,
      kind: zone ? "zone" : "courtyard",
      shape: st.shape,
      ...(zone && quietZones ? {} : { walls: "none" as const }),
    };
    if (st.floor !== undefined) yard.floor = st.floor;
    if (st.name !== undefined) yard.name = st.name;
    if (st.key !== undefined) yard.key = st.key;
    if (st.theme !== undefined) yard.theme = st.theme;
    if (st.notes !== undefined) yard.notes = st.notes;
    areas.push(yard);
    work.enclosures.push(e);
  });
}

/** Every building's plot as written (ground volumes, wings or footprint) in the neighbour map, before any is drawn. */
function markNeighbourPlots({ list, work, cellsOfShape }: Expansion): void {
  for (const st of list) {
    if (st.kind === "enclosure") continue;
    const rects = st.volumes?.filter((v) => v.on === undefined) ?? st.wings ?? [];
    for (const r of rects)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) work.neighbours.set(key(x, y), st.id);
    if (rects.length === 0 && st.footprint)
      for (const [x, y] of cellsOfShape(st.footprint)) work.neighbours.set(key(x, y), st.id);
  }
}

/**
 * Variety: draw a design for every building whose shape and looks the plan leaves to its style, in list order,
 * re-rolling while it would repeat a neighbour (within two cells) on archetype + material or storey count.
 */
function drawDesigns({ plan, level, list, work, levelTheme, palette }: Expansion): void {
  const placed: Array<{
    r: { x: number; y: number; w: number; h: number };
    d: BuildingDesign;
    space: unknown;
    look: StreetLook;
  }> = [];
  const designedCount = list.filter(
    (st) => st.kind !== "enclosure" && structureStyle(st.style)?.design && designable(st),
  ).length;
  for (const st of list) {
    if (st.kind === "enclosure") continue;
    const style0 = structureStyle(st.style);
    const base0 = style0?.design;
    // generator 3: the style's buildingVariety overrides (roof share, attic tops) apply
    const space = base0 ? designSpaceFor(base0, generatorProfile(plan).buildingVariety) : undefined;
    const r = designable(st);
    if (!space || !r) continue;
    const near = placed.filter(
      (p) =>
        p.r.x - 2 < r.x + r.w && r.x - 2 < p.r.x + p.r.w && p.r.y - 2 < r.y + r.h && r.y - 2 < p.r.y + p.r.h,
    );
    const front = st.front ?? facingOpen(level, r, st.id, work.neighbours);
    const seed = elementSeed(plan.seed, st.id, st.seed);
    const back = OPPOSITE[front];
    const profile = generatorProfile(plan);
    const expand = (dd: BuildingDesign): Building =>
      expandDesign(
        st,
        dd,
        r,
        front,
        profile,
        dd.roofKit !== undefined && dd.roofKit !== "" ? dd.roofKit : space.pitchedKit,
        {
          ...(space.parapetFor ? { parapetFor: space.parapetFor } : {}),
          ...(space.atticHeight !== undefined ? { atticHeight: space.atticHeight } : {}),
          ...(space.maxFootprint !== undefined ? { maxFootprint: space.maxFootprint } : {}),
          ...(space.roofShare && style0
            ? { roofBalance: { footing: style0.footing ? style0.footingHeight : 0, deck: style0.roof.deck } }
            : {}),
          rearOpen: openDepth(level, r, back, st.id, work.neighbours, 3) >= 2.5,
        },
      );
    // generator 4 (`lowMassesOffNeighbours`): a design whose lower ground mass would stand against another building
    // is drawn again, like one that repeats its neighbour
    const footing = style0?.footing ? style0.footingHeight : 0;
    const lowAgainst = (dd: BuildingDesign): boolean =>
      (profile.lowMassesOffNeighbours &&
        lowMassAgainstNeighbour(expand(dd), st.id, work.neighbours, footing)) ||
      // generator 5 (`leanUnderMain`): a lower mass reaching the main ridge is drawn again too
      (profile.leanUnderMain &&
        lowerMassReachesMain(expand(dd), { footing, deck: style0?.roof.deck ?? false }));
    // generator 5 (`themeOwnRange`): the theme's own walls and roofs first (resolve/themeRange.ts)
    const theme = st.theme ?? levelTheme;
    const range = profile.themeOwnRange && palette ? themeRange(palette, theme, profile.ownWallsFirst) : null;
    const drawSpace = range ? ownRangeSpace(space, range, profile.roofFormsFit) : space;
    const look = (dd: BuildingDesign): StreetLook =>
      streetLook(dd, space, style0?.roof.kit ?? "", profile, range);
    // generator 5 (`roofFormsFit`): a roof form deeper than its type allows (a shed over a house's depth) is a gable
    const depth = front === "N" || front === "S" ? r.h : r.w;
    // and a skirt (a ring of slopes round a flat top) in a kit whose corner piece is a spiked tip is a gable, as a hip
    // in one is (`roofKitFacts`): its four corners stood as spikes
    const kitOf = (dd: BuildingDesign): string =>
      dd.roofKit !== undefined && dd.roofKit !== ""
        ? dd.roofKit
        : (space.pitchedKit ?? style0?.roof.kit ?? "");
    const fit = (dd: BuildingDesign): BuildingDesign =>
      profile.roofFormsFit &&
      (depth > (roofInfo(designRoofType(dd.roof))?.maxSpan ?? Infinity) ||
        (dd.roof === "skirt" && roofKitInfo(kitOf(dd))?.cornerTip === true))
        ? { ...dd, roof: "gable" }
        : dd;
    const drawDesign = (...args: Parameters<typeof drawDesignOf>): BuildingDesign =>
      fit(drawDesignOf(...args));
    let d = drawDesign(drawSpace, subSeed(seed, "design0"), st.use, r.w, r.h, st.character);
    if (profile.readableNeighbours) {
      // generator 5 (`readableNeighbours`): two axes read from the street apart from every neighbour and every
      // building of the same built wall; the earlier rules still hold; the draw with the fewest failures is kept
      const failures = (dd: BuildingDesign): number => {
        const mine = look(dd);
        const unread = placed.filter((p) => {
          const theirs = p.look;
          const nearby =
            p.r.x - NEAR_STREET < r.x + r.w &&
            r.x - NEAR_STREET < p.r.x + p.r.w &&
            p.r.y - NEAR_STREET < r.y + r.h &&
            r.y - NEAR_STREET < p.r.y + p.r.h;
          return (nearby || theirs.wall === mine.wall) && lookAxesApart(theirs, mine) < 2;
        }).length;
        const old = near.some(
          (p) =>
            (p.d.archetype === dd.archetype && p.d.material === dd.material) || p.d.storeys === dd.storeys,
        );
        return unread * 2 + (old ? 1 : 0) + (lowAgainst(dd) ? 4 : 0);
      };
      let best = d;
      let bestN = failures(d);
      for (let k = 1; k < 16 && bestN > 0; k++) {
        const next = drawDesign(drawSpace, subSeed(seed, `design${k}`), st.use, r.w, r.h, st.character);
        const n = failures(next);
        if (n < bestN) {
          best = next;
          bestN = n;
        }
      }
      d = lowAgainst(best) ? { ...best, archetype: "box" } : best;
      placed.push({ r, d, space, look: look(d) });
      work.designs.set(st.id, { design: d, building: expand(d) });
      continue;
    }
    for (let k = 1; k < 16; k++) {
      // tone: neighbours differ in wall tone, and at most a share of the street is dark-walled
      const tone = (x: BuildingDesign): string => space.tones?.[x.material] ?? "mid";
      const darkCap = Math.max(1, Math.floor(designedCount * (space.darkShare ?? 1 / 3)));
      const darkNow = placed.filter((p) => p.space === space && tone(p.d) === "dark").length;
      // generator 3: a street never repeats one wall-and-roof pair (material, base and roof kit) within ten cells
      const alike =
        generatorProfile(plan).buildingVariety && space.roofKits !== undefined
          ? placed.some(
              (p) =>
                p.space === space &&
                Math.abs(p.r.x + p.r.w / 2 - (r.x + r.w / 2)) < 10 + (p.r.w + r.w) / 2 &&
                Math.abs(p.r.y + p.r.h / 2 - (r.y + r.h / 2)) < 10 + (p.r.h + r.h) / 2 &&
                p.d.material === d.material &&
                p.d.baseMaterial === d.baseMaterial &&
                p.d.roofKit === d.roofKit,
            )
          : false;
      const clash =
        alike ||
        near.some(
          (p) =>
            (p.d.archetype === d.archetype && p.d.material === d.material) ||
            p.d.storeys === d.storeys ||
            // roofs differ from above too (a GM mostly looks down)
            (p.d.roofSurface === d.roofSurface && space.roofSurfaces !== undefined) ||
            (space.tones !== undefined && tone(p.d) === tone(d)),
        ) ||
        (space.tones !== undefined && tone(d) === "dark" && darkNow >= darkCap) ||
        lowAgainst(d);
      if (!clash) break;
      d = drawDesign(drawSpace, subSeed(seed, `design${k}`), st.use, r.w, r.h, st.character);
    }
    // every draw put a low mass against a neighbour: the last one keeps one mass (a plain box)
    if (lowAgainst(d)) d = { ...d, archetype: "box" };
    placed.push({ r, d, space, look: look(d) });
    work.designs.set(st.id, { design: d, building: expand(d) });
  }
}

/** (sacredReads) A sacred building's raised base: a tile high, a cell out toward its street face, steps to the door. */
const SACRED_BASE = { height: 1, margin: 1, approach: "steps", rim: "none" } as const satisfies Omit<
  Plinth,
  "sides"
>;

/** (readableNeighbours) Buildings within this many cells of each other are neighbours on a street. */
const NEAR_STREET = 12;

/** What a building shows a street: its built wall, roof colour, roof form and storeys (the readable axes). */
interface StreetLook {
  readonly wall: string;
  readonly roofColour: string;
  readonly roofForm: string;
  readonly storeys: number;
}

/** How many readable axes two looks differ on. */
const lookAxesApart = (a: StreetLook, b: StreetLook): number =>
  (a.wall !== b.wall ? 1 : 0) +
  (a.roofColour !== b.roofColour ? 1 : 0) +
  (a.roofForm !== b.roofForm ? 1 : 0) +
  (a.storeys !== b.storeys ? 1 : 0);

/**
 * A design as the street reads it: the wall it is built in (a setting-kit material in the theme's own wall under
 * `ownWallsFirst`), its roof's colour (the kit's tone; a flat roof its surface) and form (a hip in a tipped kit is
 * built as a gable, `roofKitFacts`), its storeys.
 */
function streetLook(
  d: BuildingDesign,
  space: DesignSpace,
  styleKit: string,
  profile: GeneratorProfile,
  range: ThemeRange | null,
): StreetLook {
  const built = (m: string): string =>
    profile.ownWallsFirst && wallStyleInfo(m)?.settingKit === true && range?.ownWall(m) !== false
      ? THEME_WALL_STYLE
      : m;
  const kit = d.roofKit !== undefined && d.roofKit !== "" ? d.roofKit : (space.pitchedKit ?? styleKit);
  const info = roofInfo(designRoofType(d.roof));
  const flat = info?.flat === true || info?.bare === true;
  // (a cross gable is gables from the street: the form is the built type)
  const type = designRoofType(d.roof);
  const form = flat
    ? "flat"
    : profile.roofKitFacts && info?.ends === "hip" && roofKitInfo(kit)?.cornerTip === true
      ? "gable"
      : type;
  return {
    // (a house of one storey shows its ground storey's walls only)
    wall: d.storeys > 1 ? `${built(d.baseMaterial)}/${built(d.material)}` : built(d.baseMaterial),
    roofColour: flat ? `flat:${d.roofSurface}` : roofTone(kit),
    roofForm: form,
    storeys: d.storeys,
  };
}

/** The plan roof type a design's roof word builds (a cross gable is gables, a skirted spire starts with a skirt). */
const DESIGN_ROOF_TYPES: Readonly<Record<string, string>> = { gable_cross: "gable", skirt_spire: "skirt" };
const designRoofType = (roof: string): RoofType => (own(DESIGN_ROOF_TYPES, roof) ?? roof) as RoofType;

/** (themeOwnRange) Borrowed wall materials keep this share of their weight. */
const BORROWED_WALL = 1 / 3;
/** (themeOwnRange) A theme whose own roof is flat draws flat roofs at this share of the pitched roofs' weight. */
const OWN_FLAT = 0.8;

/** (roofFormsFit) A theme with no flat roof kit of its own draws flat roofs at this share of their weight. */
const FOREIGN_FLAT = 0.15;

/**
 * A design space drawn in the theme's own range first (see `themeOwnRange`); with `formsFit` (`roofFormsFit`), a theme
 * that has no flat roof kit of its own draws flat roofs at FOREIGN_FLAT of their weight.
 */
function ownRangeSpace(space: DesignSpace, range: ThemeRange, formsFit = false): DesignSpace {
  const scaled = (w: Weights | undefined): Weights | undefined =>
    w
      ? Object.fromEntries(Object.entries(w).map(([m, v]) => [m, range.ownWall(m) ? v : v * BORROWED_WALL]))
      : undefined;
  const out: { -readonly [K in keyof DesignSpace]: DesignSpace[K] } = { ...space };
  const materials = scaled(space.materials);
  if (materials) out.materials = materials;
  const baseMaterials = scaled(space.baseMaterials);
  if (baseMaterials) out.baseMaterials = baseMaterials;
  if (range.pitchedKits.length > 0 && space.roofKits)
    out.roofKits = Object.fromEntries(range.pitchedKits.map((k) => [k, space.roofKits?.[k] ?? 1]));
  const flatKit = range.flatKits[0];
  if (range.pitchedKits.length === 0 && flatKit !== undefined && space.roofs.flat === undefined) {
    const pitched = Object.entries(space.roofs)
      .filter(([k]) => roofInfo(designRoofType(k))?.pitched === true)
      .reduce((s, [, v]) => s + v, 0);
    out.roofs = { ...space.roofs, flat: pitched * OWN_FLAT };
    out.roofSurfaces = { [flatKit]: 1 };
  }
  const flatW = space.roofs.flat;
  if (formsFit && flatKit === undefined && flatW !== undefined)
    out.roofs = { ...out.roofs, flat: flatW * FOREIGN_FLAT };
  return out;
}

/**
 * A ground volume lower than the building's tallest (a lean-to, the second mass of a twin, an ell's wing) stands
 * against another building's plot: they would share a party wall that the lower one cannot carry (the neighbour's wall
 * above it is missing, and a lean-to's roof falls into the neighbour).
 */
function lowMassAgainstNeighbour(
  b: Building,
  id: string,
  neighbours: ReadonlyMap<string, string>,
  styleFooting: number,
): boolean {
  const ground = (b.volumes ?? []).filter((v) => v.on === undefined);
  // the wall top above the ground: the ground storey's footing course (the style's, unless the storey has none),
  // every storey's walls and the floors between them
  const heightOf = (v: Volume): number =>
    Array.isArray(v.storeys)
      ? v.storeys.reduce(
          (t, s, i) =>
            t +
            (s.height ?? 0) +
            (i > 0 ? BUILD_CONSTANTS.floorThickness : s.footing === "none" ? 0 : styleFooting),
          0,
        )
      : 0;
  const tallest = maxOf(ground.map(heightOf));
  return ground.some((v) => {
    if (heightOf(v) >= tallest) return false;
    for (let y = v.y - 1; y <= v.y + v.h; y++)
      for (let x = v.x - 1; x <= v.x + v.w; x++) {
        const inside = x >= v.x && x < v.x + v.w && y >= v.y && y < v.y + v.h;
        const o = neighbours.get(key(x, y));
        if (!inside && o !== undefined && o !== id) return true;
      }
    return false;
  });
}

/** The neighbour map follows the drawn designs (a small house leaves part of its plot open). */
function followDrawnDesigns(work: StructureWork): void {
  for (const [id, des] of work.designs) {
    for (const [k, o] of [...work.neighbours]) if (o === id) work.neighbours.delete(k);
    for (const v of des.building.volumes ?? [])
      if (v.on === undefined)
        for (let y = v.y; y < v.y + v.h; y++)
          for (let x = v.x; x < v.x + v.w; x++) work.neighbours.set(key(x, y), id);
  }
}

/** Plans every building (resolve/building), and adds its area, ground openings, porches and plinth elements. */
function addBuildings(x: Expansion): void {
  const { plan, list, work, areas, openings, walls, terrain, cellsOfShape, levelTheme, inBounds } = x;
  list.forEach((st, si) => {
    if (st.kind === "enclosure") return;
    const b = planBuilding(plan, st, si, work, cellsOfShape, levelTheme, inBounds);
    if (!b) return;
    work.buildings.push(b);
    const s0 = b.storeys[0] as StoreyPlan;
    const area: Area = {
      id: st.id,
      kind: "building",
      shape:
        b.wings.length === 1 && b.cells.length === (b.wings[0]?.w ?? 0) * (b.wings[0]?.h ?? 0)
          ? {
              type: "rect",
              x: b.wings[0]?.x ?? 0,
              y: b.wings[0]?.y ?? 0,
              w: b.wings[0]?.w ?? 1,
              h: b.wings[0]?.h ?? 1,
            }
          : maskShape(b.cells),
      walls: s0.walls === null ? "none" : "auto",
      // the lowest ground storey of the ground volumes (a lean-to beside the house): the shell height verify expects
      wallHeight: Math.min(
        minOf(
          b.volumes
            .filter((v) => v.on === null)
            .map((v) => (v.storeys[0]?.wallHeight ?? s0.wallHeight) + (v.storeys[0]?.footing?.height ?? 0)),
        ),
        s0.wallHeight + (s0.footing?.height ?? 0),
      ),
      floor: s0.floor,
    };
    if (s0.walls !== null) area.wallStyle = s0.walls;
    for (const f of ["name", "key", "theme", "notes", "readAloud", "encounter", "tags"] as const) {
      const v = st[f];
      if (v !== undefined) (area as unknown as Record<string, unknown>)[f] = v;
    }
    areas.push(area);
    for (const g of b.ground)
      openings.push({
        id: g.id,
        kind: g.kind,
        at: { x: g.at[0], y: g.at[1], side: g.side },
        width: g.width as 1 | 2 | 3,
      });
    for (const p of b.porches) {
      areas.push({ id: p.id, kind: "courtyard", walls: "none", floor: p.floor, shape: maskShape(p.cells) });
    }
    if (b.plinth) plinthElements(b, terrain, walls, work, inBounds);
    if (generatorProfile(plan).buildingRooms) addGroundRooms(x, b, area);
  });
}

/**
 * Generator 5 (`buildingRooms`): the building's ground storey split into the rooms of its programme
 * (resolve/building/rooms.ts), as synthetic room areas over its footprint (painted after the building's own area, so
 * they own its cells) and interior doorways. The walls between rooms come from the ordinary edge rule (two rooms with
 * walls "auto"); the shell keeps its outer edges. Left as a shell: a ruin, a building with no walls of its own, and a
 * building whose footprint the plan's own rooms or corridors already cover.
 */
function addGroundRooms(
  { level, work, areas, openings, walls, cellsOfShape }: Expansion,
  b: BuildingPlan,
  shell: Area,
): void {
  if (
    !furnishedCharacter(programmeCharacter(b, characterAt(work, b.st.id))) ||
    shell.walls === "none" ||
    shell.wallStyle === undefined
  )
    return;
  // the plan describes the ground storey itself: its own rooms or corridors in the footprint, a dress op over the
  // building, or furniture of its own inside
  const inside = (c: readonly [number, number]): boolean => b.cellSet.has(key(c[0], c[1]));
  const planned =
    level.areas.some(
      (a) =>
        (a.kind === "room" || a.kind === "corridor") &&
        a.shape.type !== "route" &&
        cellsOfShape(a.shape).some(inside),
    ) ||
    level.terrain.some((op) => op.op === "dress" && op.area === b.st.id) ||
    level.features.some((f) => inside(f.at));
  if (planned) return;
  const st = b.st;
  const split = splitGroundStorey({
    id: st.id,
    cells: b.cells,
    openings: b.ground,
    hearths: b.chimneys.map((c) => c.wall),
    kind: buildingKind({
      use: st.use,
      name: st.name,
      tags: st.tags,
      notes: st.notes,
      style: b.profile.id,
      shopfront: b.frontage.shopfront,
    }),
    seed: subSeed(b.seed, "rooms"),
  });
  if (!split) return;
  split.rooms.forEach((r, k) => {
    const id = `${st.id}~room${k}`;
    const room: Area = {
      id,
      kind: "room",
      shape: maskShape(r.cells),
      walls: "auto",
      wallStyle: shell.wallStyle as WallStyle,
      name: r.name,
    };
    if (shell.wallHeight !== undefined) room.wallHeight = shell.wallHeight;
    if (shell.floor !== undefined) room.floor = shell.floor;
    if (shell.theme !== undefined) room.theme = shell.theme;
    areas.push(room);
    work.roomBuilding.set(id, st.id);
    if (r.zones !== undefined) work.roomZones.set(id, r.zones);
    // generator 5 (characterCascade): the room's character, drawn from its building's
    work.characters?.addArea(room, st.id);
  });
  // the partitions: the theme's own wall (a light interior wall, not the shell's stone or brick, whose thick pieces
  // would stand into the rooms), the ground storey's height; zones stand open to each other
  if (split.programme !== "zones")
    partitionRuns(split.rooms).forEach((points, k) =>
      walls.push({
        id: `${st.id}~partition${k}`,
        op: "add",
        points,
        style: THEME_WALL_STYLE,
        ...(shell.wallHeight !== undefined ? { height: shell.wallHeight } : {}),
      }),
    );
  split.doorways.forEach((d, k) => {
    const id = `${st.id}~inner${k}`;
    openings.push({
      id,
      kind: d.kind,
      at: { x: d.at[0], y: d.at[1], side: d.side },
      width: d.width as 1 | 2 | 3,
    });
    work.interiorOpenings.add(id);
  });
}

/** The walls between rooms as straight runs of vertices (west/north edges of the second cell, in grid order). */
function partitionRuns(rooms: ReadonlyArray<{ cells: readonly Vec2[] }>): Vec2[][] {
  const roomAt = new Map<string, number>();
  rooms.forEach((r, i) => {
    for (const [x, y] of r.cells) roomAt.set(key(x, y), i);
  });
  // vertical edges by their x line, horizontal ones by their y line
  const lines = { v: new Map<number, number[]>(), h: new Map<number, number[]>() };
  for (const [k, i] of roomAt) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const east = roomAt.get(key(x + 1, y));
    if (east !== undefined && east !== i) lines.v.set(x + 1, [...(lines.v.get(x + 1) ?? []), y]);
    const south = roomAt.get(key(x, y + 1));
    if (south !== undefined && south !== i) lines.h.set(y + 1, [...(lines.h.get(y + 1) ?? []), x]);
  }
  const out: Vec2[][] = [];
  for (const orient of ["h", "v"] as const)
    for (const [line, list] of [...lines[orient]].sort((p, q) => p[0] - q[0])) {
      const along = [...list].sort((p, q) => p - q);
      let start = along[0] as number;
      along.forEach((a, j) => {
        const next = along[j + 1];
        if (next === a + 1) return;
        out.push(
          orient === "h"
            ? [
                [start, line],
                [a + 1, line],
              ]
            : [
                [line, start],
                [line, a + 1],
              ],
        );
        if (next !== undefined) start = next;
      });
    }
  return out;
}

/** Fences and gates, once the buildings are known: no fence where a building's own wall stands on the yard edge. */
function addFencesAndGates({ work, walls, openings }: Expansion): void {
  const builtCells = new Set<string>();
  for (const b of work.buildings) for (const k of b.cellSet) builtCells.add(k);
  for (const e of work.enclosures) {
    const st = e.st;
    if (!e.fence) continue;
    const fenceable = (c: readonly [number, number], side: Side): boolean => {
      const [dx, dy] = STEP[side];
      return !builtCells.has(key(c[0], c[1])) && !builtCells.has(key(c[0] + dx, c[1] + dy));
    };
    for (const side of SIDES)
      for (const run of faceRuns(e.cellSet, side)) {
        let seg: Array<[number, number]> = [];
        const flush = (): void => {
          const first = seg[0];
          const last = seg[seg.length - 1];
          seg = [];
          if (!first || !last) return;
          const pts: Vec2[] =
            side === "N"
              ? [
                  [first[0], first[1]],
                  [last[0] + 1, first[1]],
                ]
              : side === "S"
                ? [
                    [first[0], first[1] + 1],
                    [last[0] + 1, first[1] + 1],
                  ]
                : side === "W"
                  ? [
                      [first[0], first[1]],
                      [first[0], last[1] + 1],
                    ]
                  : [
                      [first[0] + 1, first[1]],
                      [first[0] + 1, last[1] + 1],
                    ];
          walls.push({
            id: `${st.id}~fence${walls.length}`,
            op: "add",
            points: pts,
            style: e.fence as WallStyle,
          });
        };
        for (const c of run.cells) {
          if (fenceable(c, side)) seg.push(c);
          else flush();
        }
        flush();
      }
    (st.gates ?? []).forEach((g, gi) => {
      const run = faceRuns(e.cellSet, g.side)[0];
      if (!run) {
        work.issue(
          "error",
          e.si,
          st.id,
          `enclosure "${st.id}" has no ${g.side} side for gate ${gi}`,
          "use a side the yard has",
        );
        return;
      }
      const width = Math.min(g.width ?? 1, run.cells.length);
      const a = along(run, g.position ?? 0.5, width);
      const c = run.cells[a] as [number, number];
      const id = `${st.id}~gate${gi}`;
      // "open" in the plan grid (walkable gap); the build hangs a gate there when the palette has one (gate.<fence>)
      openings.push({ id, kind: "open", at: { x: c[0], y: c[1], side: g.side }, width: width as 1 | 2 | 3 });
      e.gates.push({ id, at: [c[0], c[1]], side: g.side });
    });
  }
}

/** The level with the synthetic elements appended after the plan's own (so the plan's indices are unchanged). */
function expandedLevel({ level, work, areas, openings, walls, terrain }: Expansion): {
  level: Level;
  work: StructureWork | null;
} {
  if (work.empty) return { level, work };
  return {
    level: {
      ...level,
      areas: [...level.areas, ...areas],
      openings: [...level.openings, ...openings],
      walls: [...level.walls, ...walls],
      terrain: [...level.terrain, ...terrain],
    },
    work,
  };
}

/**
 * A plinth's synthetic terrain: its top painted with the face material (the sides are built from that material's
 * cliff/fill roles), a flight of steps from the ground up to each door, and a rim wall round its edge with a gap at
 * each flight.
 */
function plinthElements(
  b: BuildingPlan,
  terrain: TerrainOp[],
  walls: WallRun[],
  work: StructureWork,
  inBounds: (x: number, y: number) => boolean,
): void {
  const p = b.plinth;
  if (!p) return;
  const id = b.st.id;
  const porch = new Set(b.porches.flatMap((q) => q.cells.map(([x, y]) => key(x, y))));
  const pset = new Set(p.cells.map(([x, y]) => key(x, y)));
  const top = p.cells.filter(([x, y]) => !b.cellSet.has(key(x, y)) && !porch.has(key(x, y)));
  if (top.length > 0)
    terrain.push({ id: `${id}~plinth`, op: "paint", layer: "over", shape: maskShape(top), material: p.face });
  const gaps = new Set<string>(); // "x,y,side" of rim edges left open for a flight
  if (p.approach === "steps" && p.height > BUILD_CONSTANTS.floorThickness) {
    const n = Math.ceil(p.height);
    b.ground.forEach((g, gi) => {
      if (!isPassage(g.kind) || isSecret(g.kind)) return;
      const [dx, dy] = STEP[g.side];
      // the outermost plinth cell in front of the door, then n cells of steps outward
      let m = 1;
      while (pset.has(key(g.at[0] + dx * (m + 1), g.at[1] + dy * (m + 1)))) m++;
      const to: Vec2 = [g.at[0] + dx * m, g.at[1] + dy * m];
      const from: Vec2 = [g.at[0] + dx * (m + n), g.at[1] + dy * (m + n)];
      const width = g.side === "N" || g.side === "S" ? g.width : g.width;
      const ok = inBounds(from[0], from[1]) && !pset.has(key(from[0], from[1]));
      if (!ok) {
        work.issue(
          "warning",
          b.si,
          id,
          `building "${id}": no room for steps from the ${g.side} door down the plinth (${n} cells out)`,
          "move the building in from the level edge, or lower the plinth",
          [g.at[0], g.at[1]],
        );
        return;
      }
      terrain.push({ id: `${id}~steps${gi}`, op: "stairs", from, to, width });
      for (let k = 0; k < g.width; k++) {
        const ax = g.side === "N" || g.side === "S" ? to[0] + k : to[0];
        const ay = g.side === "N" || g.side === "S" ? to[1] : to[1] + k;
        gaps.add(`${ax},${ay},${g.side}`);
        for (let d = 1; d < n; d++) b.reserve.add(key(ax + dx * d, ay + dy * d));
      }
    });
  }
  if (!p.rim) return;
  for (const side of SIDES)
    for (const run of faceRuns(pset, side)) {
      let seg: Array<[number, number]> = [];
      const flush = (): void => {
        const first = seg[0];
        const last = seg[seg.length - 1];
        seg = [];
        if (!first || !last) return;
        const pts: Vec2[] =
          side === "N"
            ? [
                [first[0], first[1]],
                [last[0] + 1, first[1]],
              ]
            : side === "S"
              ? [
                  [first[0], first[1] + 1],
                  [last[0] + 1, first[1] + 1],
                ]
              : side === "W"
                ? [
                    [first[0], first[1]],
                    [first[0], last[1] + 1],
                  ]
                : [
                    [first[0] + 1, first[1]],
                    [first[0] + 1, last[1] + 1],
                  ];
        walls.push({
          id: `${id}~rim${walls.length}`,
          op: "add",
          points: pts,
          style: p.rim as WallStyle,
          height: 1,
        });
      };
      for (const c of run.cells) {
        if (gaps.has(`${c[0]},${c[1]},${side}`)) flush();
        else seg.push(c);
      }
      flush();
    }
}

/** A cells-mask shape for a cell list (≤ 64×64, which footprints and porches always are). */
function maskShape(cells: ReadonlyArray<readonly [number, number]>): Area["shape"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const set = new Set(cells.map(([x, y]) => key(x, y)));
  const rows: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += set.has(key(x, y)) ? "#" : ".";
    rows.push(r);
  }
  return { type: "cells", x: x0, y: y0, rows };
}

/**
 * Plans one building as a list of steps (resolve/building/*). Each step reads the building's context (`BuildingCtx`:
 * the building, its style after the street variety, seed and draw streams) and the hand-offs of the steps before it:
 *
 *   hand-off          made by                        read by
 *   VolumePlan[]      planVolumes                    the face steps, condition (breaks the roofs), the result
 *   GroundFootprint   groundFootprint                every later step
 *   BuildingFaces     new (faces.ts)                 openings, chimneys and windows take faces and add openings;
 *                                                    porches read the doors; condition drops windows and adds
 *                                                    breaches; door lights read the free faces
 *   Chimney[]         placeChimneys                  condition (a weathered building lost it); kept when intact
 *   Decay             applyCondition                 the fittings (lights, furniture, lighting) and the result
 *
 * Draws come from the streams in a fixed order (context.ts lists them), so the steps run in this order; a step that only
 * runs for some generators tests its switch (`b.gen`) where it starts.
 */
function planBuilding(
  plan: MapPlan,
  written: Building,
  si: number,
  work: StructureWork,
  cellsOfShape: (s: Parameters<typeof rasterizeShape>[0]) => Array<[number, number]>,
  levelTheme: string,
  inBounds: (x: number, y: number) => boolean,
): BuildingPlan | null {
  const b0 = startBuilding(plan, written, si, work, levelTheme, inBounds);

  // masses: volumes with their storeys and roofs, and the footprint they stand on
  const specs = volumeSpecs(b0, cellsOfShape);
  if (!specs) return null;
  const volumes = planVolumes(b0, specs);
  const main = volumes.find((v) => v.on === null) as VolumePlan;
  const fp = groundFootprint(b0, volumes);
  if (!fp) return null;

  // generator 5 (`sacredReads`): a sacred building's raised form, when its treatment draws it: the door at the middle
  // of its face, no hearth stack, a base with steps toward the street (drawPlinth below)
  const raised =
    b0.gen.sacredReads &&
    drawStructureOption(
      "sacredForm",
      buildingSubjectOf(b0, fp, volumes, b0.st.condition ?? b0.profile.condition ?? "intact"),
      `${b0.seed}|${b0.st.id}`,
    ) === "raised";
  const b = raised
    ? {
        ...b0,
        st: { ...b0.st, chimneys: b0.st.chimneys ?? [] },
        profile: {
          ...b0.profile,
          variety: { ...b0.profile.variety, doorPosition: [0.5, 0.5] as [number, number] },
        },
      }
    : b0;

  // faces: openings (with a default door), chimneys, the street face, windows, porches
  const faces = new BuildingFaces(b.st.id);
  const opens = placeOpenings(b, fp, main, faces);
  const chimneys = placeChimneys(b, fp, volumes, main, faces, opens);
  const frontage = drawFrontage(b, faces);
  placeWindows(b, fp, volumes, main, faces, frontage);
  const porches = placePorches(b, fp, faces.ground);

  // condition: a weathered or ruined building loses its chimney, roof pieces, doors; breaches, rubble, growth
  const decay = applyCondition(b, fp, volumes, main, faces, chimneys, porches);
  // generator 5: a worn or ramshackle building's roof patches and porch wear (each behind its switch)
  const roofPatch =
    b.gen.roofPatches || b.gen.porchWear
      ? applyWear(b, volumes, porches, decay.ruin, buildingSubjectOf(b, fp, volumes, decay.condition))
      : null;
  const standing = decay.condition === "intact" ? chimneys : [];

  // fittings, and the cells kept free of dressing
  const doorLights =
    decay.condition === "ruined" ? false : doorLightsByLight(b, b.st.lighting?.doors ?? b.profile.doorLight);
  const lights = placeDoorLights(fp, faces, doorLights);
  const plinth = drawPlinth(
    raised && b.st.plinth === undefined
      ? { ...b, st: { ...b.st, plinth: { ...SACRED_BASE, sides: [frontage.side] } } }
      : b,
    fp,
    porches,
  );
  const furniture = drawRoofFurniture(b, decay.ruin);
  const lighting = drawLighting(b, decay.condition, doorLights);
  const reserve = reservedCells(fp, faces.ground, standing, porches, plinth);

  return {
    st: b.st,
    si,
    profile: b.profile,
    // the level owns a theme-less building's theme, as it owns its cells': the building's ground storey is an area of
    // its own drawn over whatever area it stands in, and an area with no theme takes the level's (areas.ts), never
    // that of an area under it; so the building and its cells always agree
    theme: b.st.theme ?? levelTheme,
    seed: b.seed,
    cells: fp.cells,
    cellSet: fp.cellSet,
    wings: main.rects,
    storeys: main.storeys,
    roof: main.roof.summary,
    volumes,
    ground: faces.ground,
    upper: faces.upper,
    chimneys: standing,
    porches,
    lights,
    reserve,
    plinth,
    furniture,
    lighting,
    frontage,
    condition: decay.condition,
    valleys: b.gen.roofValleys,
    roofFill: b.gen.closedRoofs,
    debris: decay.debris,
    growth: decay.growth,
    ...(decay.growthLevel !== null ? { growthLevel: decay.growthLevel } : {}),
    ruin: decay.ruin,
    ...(roofPatch ? { roofPatch } : {}),
  };
}

/** Exported for tests. */
export const _internal = { faceRuns, ringOf, maskShape };
export type { Structure };

/**
 * The face of a rect that looks onto the most open ground (the street between two rows, not the next house or the
 * level edge): open cells within six cells of each face, each column stopping at a neighbour or the edge.
 */
function facingOpen(
  level: Level,
  r: { x: number; y: number; w: number; h: number },
  id: string,
  others: ReadonlyMap<string, string>,
): Side {
  let best: Side = "S";
  let bestN = -1;
  for (const side of ["S", "N", "E", "W"] as const) {
    const n = openDepth(level, r, side, id, others, 6);
    if (n > bestN + 1e-9) {
      bestN = n;
      best = side;
    }
  }
  return best;
}

/** Mean depth of open ground (up to `max` cells, in bounds, no other building) in front of one face of a rect. */
function openDepth(
  level: Level,
  r: { x: number; y: number; w: number; h: number },
  side: Side,
  id: string,
  others: ReadonlyMap<string, string>,
  max: number,
): number {
  const b = level.bounds;
  const inB = (x: number, y: number): boolean => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
  {
    const [dx, dy] = STEP[side];
    const alongX = side === "N" || side === "S";
    const len = alongX ? r.w : r.h;
    let n = 0;
    for (let i = 0; i < len; i++) {
      const x0 = alongX ? r.x + i : side === "E" ? r.x + r.w - 1 : r.x;
      const y0 = alongX ? (side === "S" ? r.y + r.h - 1 : r.y) : r.y + i;
      for (let d = 1; d <= max; d++) {
        const x = x0 + dx * d;
        const y = y0 + dy * d;
        const o = others.get(key(x, y));
        if (!inB(x, y) || (o !== undefined && o !== id)) break;
        n++;
      }
    }
    return n / len;
  }
}
