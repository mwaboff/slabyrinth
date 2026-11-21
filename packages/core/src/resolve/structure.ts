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
  Attachment,
  Building,
  Enclosure,
  Level,
  MapPlan,
  Material,
  Opening,
  OpeningKind,
  PlanIssue,
  Roof,
  RoofLayer,
  Side,
  Storey,
  Structure,
  TerrainOp,
  Vec2,
  WallRun,
  WallStyle,
} from "../contracts/plan";
import { BUILD_CONSTANTS } from "../contracts/plan";
import type { BuiltRoofType, ResolvedLevel, ResolvedStructure, ResolvedVolume } from "../contracts/resolved";
import { CELL, CELL_FLAG, EDGE } from "../contracts/resolved";
import { SIDE_STEP as STEP, SIDES } from "../gen/gridGeometry";
import { forEachMaskCell } from "../gen/mask";
import { generatorProfile } from "../plan/generator";
import { withWings } from "../plan/building";
import { rasterizeShape } from "../gen/shapes";
import { elementSeed, subSeed } from "../util/hash";
import { createPrng, type Prng } from "../util/prng";
import { type RoofWing, defaultRidge } from "./roof";
import { climbingGrowth } from "./growth";
import { type RuinProfile, ruinProfile, scatterTopRubble } from "./ruin";
import {
  type BuildingDesign,
  designable,
  designSpaceFor,
  drawDesign,
  expandDesign,
  windowPattern,
} from "./structureVariety";
import {
  DEFAULT_STRUCTURE_STYLE,
  STRUCTURE_STYLES,
  type StructureStyleProfile,
  WINDOW_SPACING,
  type WindowDensity,
  structureStyle,
} from "./structureStyles";

const BUILT_ROOFS = new Set(["gable", "hip", "shed", "flat", "none", "skirt", "stepped", "spire"]);
/** Layers that close a roof (nothing can stand on them). */
const CLOSING = new Set(["gable", "hip", "shed", "spire", "flat", "none"]);
const DOOR_KINDS = new Set<OpeningKind>([
  "door",
  "double_door",
  "locked_door",
  "secret_door",
  "archway",
  "open",
  "portcullis",
]);
const key = (x: number, y: number): string => `${x},${y}`;

/** A straight run of outside edges of a footprint on one face: cells along it, in increasing x (N/S) or y (E/W). */
interface FaceRun {
  side: Side;
  cells: Array<[number, number]>;
}

interface StoreyPlan {
  walls: WallStyle | null;
  footing: { style: WallStyle; height: number } | null;
  wallHeight: number;
  floor: Material;
  density: WindowDensity;
}

/** A volume as written (or the single "main" volume of a phase-1 building). */
interface VolumeSpec {
  id: string;
  on: string | null;
  cells: Array<[number, number]>;
  /** The volume rect, or null for a non-rectangular footprint. */
  rect: { x: number; y: number; w: number; h: number } | null;
  rects: RoofWing[];
  storeys: number | Storey[] | undefined;
  storeyHeight: number | undefined;
  corners: "square" | "chamfer";
  roof: Roof | "none" | undefined;
}

interface VStorey extends StoreyPlan {
  cells: Array<[number, number]>;
  cellSet: Set<string>;
  rect: { x: number; y: number; w: number; h: number };
  seam: "skirt" | "plain" | "crenellated" | null;
  /** Floor top and wall top relative to the ground floor top. */
  relFloor: number;
  relTop: number;
}

interface VolumePlan {
  id: string;
  on: string | null;
  corners: "square" | "chamfer";
  rects: RoofWing[];
  storeys: VStorey[];
  roof: ResolvedVolume["roof"] & { summary: ResolvedStructure["roof"] };
  /** Top of the roof deck relative to the ground floor top (where a volume "on" this one stands). */
  relRoofTop: number;
}

interface BuildingPlan {
  st: Building;
  si: number;
  profile: StructureStyleProfile;
  theme: string;
  seed: number;
  volumes: VolumePlan[];
  plinth: {
    height: number;
    margin: number;
    face: Material;
    rim: WallStyle | null;
    approach: "steps" | "none";
    cells: Vec2[];
  } | null;
  furniture: NonNullable<ResolvedStructure["furniture"]>;
  lighting: NonNullable<ResolvedStructure["lighting"]>;
  condition: NonNullable<ResolvedStructure["condition"]>;
  /** Generator 3: roofs that meet are merged into valleys (ResolvedStructure.valleys). */
  valleys: boolean;
  /** Generator 4: no open roof cell (ResolvedStructure.roofFill). */
  roofFill: boolean;
  debris: NonNullable<ResolvedStructure["debris"]>;
  /** Generator 3: growth attached to the walls (heights relative to the ground floor top). */
  growth: NonNullable<ResolvedStructure["growth"]>;
  /** Generator 3, weathered or ruined: how overgrown the building is (null otherwise). */
  growthLevel?: NonNullable<ResolvedStructure["growthLevel"]> | null;
  /** Wall tops and fallen floors of a weathered or ruined building, relative to the ground floor top. */
  ruin: RuinProfile | null;
  frontage: NonNullable<ResolvedStructure["frontage"]>;
  cells: Array<[number, number]>;
  cellSet: Set<string>;
  wings: ResolvedStructure["wings"];
  storeys: VStorey[];
  roof: ResolvedStructure["roof"];
  /** Ground-storey openings: synthetic ids, the face cell and side, kind and width. */
  ground: Array<{ id: string; kind: OpeningKind; at: Vec2; side: Side; width: number }>;
  upper: ResolvedStructure["upperOpenings"];
  chimneys: Array<{ at: Vec2; side: Side; wall: Vec2 }>;
  porches: Array<{ id: string; cells: Vec2[]; side: Side; floor: Material; roof: boolean }>;
  lights: Array<{ at: Vec2; side: Side }>;
  /** Cells kept free of generated dressing. */
  reserve: Set<string>;
  /** Pad height (quarter tiles) once the terrain is known. */
  pad?: number;
  /** The pad before it was raised to the ground in front of its doors: the wall ring keeps this height. */
  ringPad?: number;
}

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
  /** Plan list lengths: synthetic areas / openings / wall runs come after these indices. */
  readonly planCounts: { areas: number; openings: number; walls: number; terrain: number };
  reservedMask: Uint8Array | null = null;
  private readonly li: number;
  private readonly levelId: string;
  private readonly issues: PlanIssue[];
  private readonly issueStart: number;

  constructor(level: Level, li: number, issues: PlanIssue[]) {
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
      let front = -Infinity;
      for (const g of b.ground) {
        if (!DOOR_KINDS.has(g.kind)) continue;
        const [dx, dy] = STEP[g.side];
        for (let k = 0; k < g.width; k++) {
          const ax = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
          const ay = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
          const reach = 2 + (b.plinth ? b.plinth.margin : 0);
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
    for (const b of this.buildings) {
      for (const g of b.ground) {
        const [dx, dy] = STEP[g.side];
        for (let k = 0; k < g.width; k++) {
          const off = g.side === "N" || g.side === "S" ? [k, 0] : [0, k];
          const ox = g.at[0] + (off[0] as number) + dx;
          const oy = g.at[1] + (off[1] as number) + dy;
          const i = w.idx(ox, oy);
          if (DOOR_KINDS.has(g.kind) && (i < 0 || w.state[i] !== CELL.OPEN)) {
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
        const back: Side = front === "N" ? "S" : front === "S" ? "N" : front === "E" ? "W" : "E";
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
      const base = elevation + BUILD_CONSTANTS.floorThickness + (b.pad ?? 0) / 4;
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
        porches: b.porches.map((p) => ({ cells: p.cells, side: p.side, floor: p.floor, roof: p.roof })),
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

function ringOf(cells: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const kk = key(x + dx, y + dy);
        if (!cells.has(kk)) out.add(kk);
      }
  }
  return [...out].sort();
}

/** Straight runs of outside edges on one face, longest first (ties: smallest start). */
function faceRuns(cellSet: ReadonlySet<string>, side: Side): FaceRun[] {
  const [dx, dy] = STEP[side];
  const lines = new Map<number, number[]>();
  for (const k of cellSet) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (cellSet.has(key(x + dx, y + dy))) continue;
    const line = side === "N" || side === "S" ? y : x;
    const along = side === "N" || side === "S" ? x : y;
    const arr = lines.get(line) ?? [];
    arr.push(along);
    lines.set(line, arr);
  }
  const runs: FaceRun[] = [];
  for (const [line, list] of [...lines].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || (list[i] as number) !== (list[i - 1] as number) + 1) {
        const cells: Array<[number, number]> = [];
        for (let j = start; j < i; j++) {
          const a = list[j] as number;
          cells.push(side === "N" || side === "S" ? [a, line] : [line, a]);
        }
        runs.push({ side, cells });
        start = i;
      }
    }
  }
  // the outermost line first on its face, then longest
  const outer = (r: FaceRun): number => {
    const c = r.cells[0] as [number, number];
    return side === "N" ? c[1] : side === "S" ? -c[1] : side === "W" ? c[0] : -c[0];
  };
  return runs.sort((a, b) => b.cells.length - a.cells.length || outer(a) - outer(b));
}

/** First cell of a `width`-long stretch at fraction `pos` along a run. */
function along(run: FaceRun, pos: number, width: number): number {
  const n = run.cells.length;
  return Math.max(0, Math.min(n - width, Math.round(pos * (n - width))));
}

const pickRange = (prng: Prng, r: readonly [number, number]): number =>
  Math.round((r[0] + (r[1] - r[0]) * prng.next()) * 100) / 100;

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
): { level: Level; work: StructureWork | null } {
  const list = (level.structures ?? []).map(withWings);
  if (list.length === 0 || !generatorProfile(plan).buildings) return { level, work: null };
  const work = new StructureWork(level, li, issues);
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

  // enclosures first (painter order: buildings and porches claim their cells on top of a yard)
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
    const yard: Area = {
      id: st.id,
      kind: st.floor !== undefined ? "courtyard" : "zone",
      shape: st.shape,
      walls: "none",
    };
    if (st.floor !== undefined) yard.floor = st.floor;
    if (st.name !== undefined) yard.name = st.name;
    if (st.key !== undefined) yard.key = st.key;
    if (st.theme !== undefined) yard.theme = st.theme;
    if (st.notes !== undefined) yard.notes = st.notes;
    areas.push(yard);
    work.enclosures.push(e);
  });

  for (const st of list) {
    if (st.kind === "enclosure") continue;
    const rects = st.volumes?.filter((v) => v.on === undefined) ?? st.wings ?? [];
    for (const r of rects)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) work.neighbours.set(key(x, y), st.id);
    if (rects.length === 0 && st.footprint)
      for (const [x, y] of cellsOfShape(st.footprint)) work.neighbours.set(key(x, y), st.id);
  }
  // variety: draw a design for every building whose shape and looks the plan leaves to its style, in list order,
  // re-rolling while it would repeat a neighbour (within two cells) on archetype + material or storey count
  const placed: Array<{
    r: { x: number; y: number; w: number; h: number };
    d: BuildingDesign;
    space: unknown;
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
    let d = drawDesign(space, subSeed(seed, "design0"), st.use, r.w, r.h, st.character);
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
        (space.tones !== undefined && tone(d) === "dark" && darkNow >= darkCap);
      if (!clash) break;
      d = drawDesign(space, subSeed(seed, `design${k}`), st.use, r.w, r.h, st.character);
    }
    placed.push({ r, d, space });
    const back: Side = front === "N" ? "S" : front === "S" ? "N" : front === "E" ? "W" : "E";
    work.designs.set(st.id, {
      design: d,
      building: expandDesign(
        st,
        d,
        r,
        front,
        d.roofKit !== undefined && d.roofKit !== "" ? d.roofKit : space.pitchedKit,
        {
          ...(space.parapetFor ? { parapetFor: space.parapetFor } : {}),
          ...(space.atticHeight !== undefined ? { atticHeight: space.atticHeight } : {}),
          ...(space.maxFootprint !== undefined ? { maxFootprint: space.maxFootprint } : {}),
          ...(space.roofShare && style0
            ? { roofBalance: { footing: style0.footing ? style0.footingHeight : 0, deck: style0.roof.deck } }
            : {}),
          rearOpen: openDepth(level, r, back, st.id, work.neighbours, 3) >= 2.5,
        },
      ),
    });
  }
  // the neighbour map follows the drawn designs (a small house leaves part of its plot open)
  for (const [id, des] of work.designs) {
    for (const [k, o] of [...work.neighbours]) if (o === id) work.neighbours.delete(k);
    for (const v of des.building.volumes ?? [])
      if (v.on === undefined)
        for (let y = v.y; y < v.y + v.h; y++)
          for (let x = v.x; x < v.x + v.w; x++) work.neighbours.set(key(x, y), id);
  }
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
        ...b.volumes
          .filter((v) => v.on === null)
          .map((v) => (v.storeys[0]?.wallHeight ?? s0.wallHeight) + (v.storeys[0]?.footing?.height ?? 0)),
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
  });

  // fences and gates, once the buildings are known: no fence where a building's own wall stands on the yard edge
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
      if (!DOOR_KINDS.has(g.kind) || g.kind === "secret_door") return;
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

function planBuilding(
  plan: MapPlan,
  st: Building,
  si: number,
  work: StructureWork,
  cellsOfShape: (s: Parameters<typeof rasterizeShape>[0]) => Array<[number, number]>,
  levelTheme: string,
  inBounds: (x: number, y: number) => boolean,
): BuildingPlan | null {
  let profile = structureStyle(st.style);
  if (!profile) {
    work.issue(
      "warning",
      si,
      st.id,
      `building "${st.id}": unknown style "${st.style ?? ""}"; built as "${DEFAULT_STRUCTURE_STYLE}"`,
      `styles: ${Object.keys(STRUCTURE_STYLES).join(", ")}`,
    );
    profile = STRUCTURE_STYLES[DEFAULT_STRUCTURE_STYLE] as StructureStyleProfile;
  }
  const designed = work.designs.get(st.id);
  if (designed) {
    st = designed.building;
    profile = { ...profile, windows: { width: windowPattern(designed.design.windows).width } };
  }
  const seed = elementSeed(plan.seed, st.id, st.seed);
  const prng = createPrng(subSeed(seed, "structure"));
  // phase-2 draws come from their own stream, so phase-1 buildings keep their exact variety
  const prng2 = createPrng(subSeed(seed, "structure2"));
  // street variety (material, parapet, window width, storey count, shopfront, roof hut) on a third stream, drawn only
  // for styles that declare those ranges
  const prng3 = createPrng(subSeed(seed, "structure3"));
  {
    const pick = <T>(xs: readonly T[] | undefined): T | undefined =>
      xs && xs.length > 0 ? xs[prng3.int(xs.length)] : undefined;
    const wallVar = pick(profile.wallVariants);
    const parVar = pick(profile.parapets);
    const winVar = pick(profile.windowWidths);
    const walls = wallVar ?? profile.walls;
    if (wallVar !== undefined || parVar !== undefined || winVar !== undefined)
      profile = {
        ...profile,
        walls,
        upperWalls: wallVar ?? profile.upperWalls,
        roof: {
          ...profile.roof,
          parapet: parVar === undefined ? profile.roof.parapet : parVar === "walls" ? walls : parVar,
        },
        windows: { width: winVar ?? profile.windows.width },
      };
  }
  const storeyCountDraw = (): number => {
    const r = profile.storeyCount;
    return r ? r[0] + prng3.int(r[1] - r[0] + 1) : 1;
  };

  // ── volumes (a phase-1 building is one volume "main" over its wings / footprint) ──
  const ridgeOverride = st.roof !== undefined && st.roof !== "none" ? st.roof.ridge : undefined;
  const specs: VolumeSpec[] = [];
  if (st.volumes && st.volumes.length > 0) {
    const ids = new Set<string>();
    for (const v of st.volumes) {
      if (ids.has(v.id)) {
        work.issue(
          "error",
          si,
          st.id,
          `building "${st.id}": two volumes are called "${v.id}"`,
          "give every volume its own id",
        );
        return null;
      }
      if (v.on !== undefined && !ids.has(v.on)) {
        work.issue(
          "error",
          si,
          st.id,
          `building "${st.id}": volume "${v.id}" stands on "${v.on}", which is not an earlier volume`,
          `list the volume it stands on first; volumes so far: ${[...ids].join(", ") || "(none)"}`,
        );
        return null;
      }
      ids.add(v.id);
      const cells: Array<[number, number]> = [];
      for (let y = v.y; y < v.y + v.h; y++) for (let x = v.x; x < v.x + v.w; x++) cells.push([x, y]);
      specs.push({
        id: v.id,
        on: v.on ?? null,
        cells,
        rect: { x: v.x, y: v.y, w: v.w, h: v.h },
        rects: [
          { x: v.x, y: v.y, w: v.w, h: v.h, ridge: v.ridge ?? ridgeFrom(v.roof) ?? defaultRidge(v.w, v.h) },
        ],
        storeys: v.storeys ?? (ids.size === 1 && v.on === undefined ? st.storeys : undefined),
        storeyHeight: v.storeyHeight ?? st.storeyHeight,
        corners: v.corners ?? st.corners ?? profile.corners ?? "square",
        roof: v.roof ?? (ids.size === 1 ? st.roof : undefined),
      });
    }
  } else {
    let cells: Array<[number, number]>;
    const rects: RoofWing[] = [];
    if (st.wings && st.wings.length > 0) {
      const set = new Map<string, [number, number]>();
      for (const w of st.wings) {
        for (let y = w.y; y < w.y + w.h; y++)
          for (let x = w.x; x < w.x + w.w; x++) if (inBounds(x, y)) set.set(key(x, y), [x, y]);
        rects.push({
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          ridge: w.ridge ?? ridgeOverride ?? defaultRidge(w.w, w.h),
        });
      }
      cells = [...set.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    } else if (st.footprint) {
      cells = cellsOfShape(st.footprint);
      if (st.footprint.type === "rect") {
        const f = st.footprint;
        rects.push({ x: f.x, y: f.y, w: f.w, h: f.h, ridge: ridgeOverride ?? defaultRidge(f.w, f.h) });
      }
    } else return null; // validation reports it
    const rect = boundsOf(cells);
    specs.push({
      id: "main",
      on: null,
      cells,
      rect: rects.length === 1 && cells.length === rect.w * rect.h ? rect : null,
      rects,
      storeys: st.storeys,
      storeyHeight: st.storeyHeight,
      corners: st.corners ?? profile.corners ?? "square",
      roof: st.roof,
    });
  }
  const groundSpecs = specs.filter((v) => v.on === null);
  if (groundSpecs.length === 0) {
    work.issue(
      "error",
      si,
      st.id,
      `building "${st.id}" has no volume on the ground`,
      "give at least one volume without on",
    );
    return null;
  }

  // ── storeys of every volume (relative heights: the ground floor top is 0) ──
  const vplans: VolumePlan[] = [];
  const drawUpper = (): number => {
    const u = profile.upperWallHeight;
    if (u === undefined) return profile.wallHeight;
    if (typeof u === "number") return u;
    return Math.round((u[0] + (u[1] - u[0]) * prng2.next()) * 2) / 2;
  };
  const pickSeam = (): "skirt" | "plain" | "crenellated" => {
    const w = profile.seams ?? { plain: 1 };
    const entries = (["skirt", "plain", "crenellated"] as const).filter((k) => (w[k] ?? 0) > 0);
    const total = entries.reduce((sum, k) => sum + (w[k] ?? 0), 0);
    let r = prng2.next() * total;
    for (const k of entries) {
      r -= w[k] ?? 0;
      if (r < 0) return k;
    }
    return entries[entries.length - 1] ?? "plain";
  };
  const density0: WindowDensity =
    st.windows ??
    (profile.variety.windowDensities[prng.int(profile.variety.windowDensities.length)] as WindowDensity);
  for (const spec of specs) {
    const count =
      typeof spec.storeys === "number" ? spec.storeys : (spec.storeys?.length ?? storeyCountDraw());
    const given = Array.isArray(spec.storeys) ? spec.storeys : [];
    const target = spec.on !== null ? vplans.find((v) => v.id === spec.on) : undefined;
    let relFloor = target ? target.relRoofTop : 0;
    let rect = spec.rect;
    const storeys: VStorey[] = [];
    for (let s = 0; s < count; s++) {
      const g = given[s] ?? {};
      const ground = s === 0 && spec.on === null;
      // set-ins: given, or drawn from the style for storeys above the ground of a rectangular volume
      let inset = g.inset ?? 0;
      if (g.inset === undefined && s > 0 && rect && profile.setIn && prng2.chance(profile.setIn.chance))
        inset = rect.w - 2 >= profile.setIn.minWidth && rect.h - 2 >= profile.setIn.minWidth ? 1 : 0;
      if (inset > 0 && !rect) {
        work.issue(
          "warning",
          si,
          st.id,
          `building "${st.id}": storey ${s} of volume "${spec.id}" cannot step in: only rectangular volumes can`,
          "describe it as volumes [{id, x, y, w, h}]",
        );
        inset = 0;
      }
      if (inset > 0 && rect && (rect.w - 2 * inset < 2 || rect.h - 2 * inset < 2)) {
        work.issue(
          "warning",
          si,
          st.id,
          `building "${st.id}": storey ${s} of volume "${spec.id}" would be narrower than 2 cells after stepping in ${inset}; it keeps the width`,
          "step in less, or widen the volume",
        );
        inset = 0;
      }
      if (inset > 0 && rect)
        rect = { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset };
      const cells0 = rect ? rectCells(rect) : spec.cells;
      const cells = spec.corners === "chamfer" && rect ? chamfer(cells0, rect) : cells0;
      const isTop = s === count - 1;
      const wallsRaw =
        g.walls ??
        (s === 0 && spec.on === null
          ? profile.walls
          : isTop && count > 1 && profile.crownWalls
            ? profile.crownWalls
            : profile.upperWalls);
      const footRaw = ground ? (g.footing ?? profile.footing ?? "none") : "none";
      if (!ground && g.footing !== undefined && g.footing !== "none")
        work.issue(
          "warning",
          si,
          st.id,
          `building "${st.id}": only the ground storey has a footing course`,
          "remove footing from upper storeys",
        );
      const footing = footRaw === "none" ? null : { style: footRaw, height: profile.footingHeight };
      const wallHeight = g.height ?? spec.storeyHeight ?? (s === 0 ? profile.wallHeight : drawUpper());
      const relTop = relFloor + (footing?.height ?? 0) + wallHeight;
      storeys.push({
        walls: wallsRaw === "none" ? null : wallsRaw,
        footing,
        wallHeight,
        floor: g.floor ?? profile.floor,
        density: g.windows ?? density0,
        cells,
        cellSet: new Set(cells.map(([x, y]) => key(x, y))),
        rect: rect ?? boundsOf(cells),
        seam: inset > 0 ? (g.seam ?? pickSeam()) : null,
        relFloor,
        relTop,
      });
      relFloor = relTop + BUILD_CONSTANTS.floorThickness;
    }
    if (
      storeys.some((sp, i) => sp.walls === null && i < storeys.length - 1 && storeys[i + 1]?.walls !== null)
    )
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": a storey without walls carries a walled storey above it`,
        "give the lower storey walls, or make it the top storey",
      );
    if (target) {
      const top = target.storeys[target.storeys.length - 1];
      const off = storeys[0]?.cells.filter(([x, y]) => !top?.cellSet.has(key(x, y))) ?? [];
      // a drawn design (twisted storeys, bartizans) and a building with character overhang on purpose
      if (off.length > 0 && !designed && (st.character ?? []).length === 0)
        work.issue(
          "warning",
          si,
          st.id,
          `building "${st.id}": volume "${spec.id}" overhangs the top of "${target.id}" at ${off.length} cell(s)`,
          `keep it inside ${target.id}'s top storey (${rectText(top?.rect)})`,
        );
      if (
        !["flat", "none", "skirt", "stepped"].includes(
          target.roof.layers[target.roof.layers.length - 1]?.type ?? "flat",
        )
      )
        work.issue(
          "warning",
          si,
          st.id,
          `building "${st.id}": volume "${spec.id}" stands on "${target.id}", whose roof is not flat; it stands on its deck`,
          `give "${target.id}" a flat roof`,
        );
    }
    const roof = resolveRoof(spec, st, profile, prng2, work, si);
    const topRel = storeys[storeys.length - 1]?.relTop ?? 0;
    vplans.push({
      id: spec.id,
      on: spec.on,
      corners: spec.corners,
      rects: spec.rects,
      storeys,
      roof,
      relRoofTop: topRel + BUILD_CONSTANTS.floorThickness,
    });
  }
  const main = vplans.find((v) => v.on === null) as VolumePlan;

  // ── ground footprint: the ground storeys of the ground volumes ──
  const groundSet = new Map<string, [number, number]>();
  for (const v of vplans)
    if (v.on === null)
      for (const c of v.storeys[0]?.cells ?? []) if (inBounds(c[0], c[1])) groundSet.set(key(c[0], c[1]), c);
  const cells = [...groundSet.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (cells.length === 0) {
    work.issue(
      "error",
      si,
      st.id,
      `building "${st.id}" covers no cell of the level`,
      "move it inside the level bounds",
    );
    return null;
  }
  const cellSet = new Set(cells.map(([x, y]) => key(x, y)));
  const taken = work.occupied();
  const clash = cells.find(([x, y]) => taken.has(key(x, y)));
  if (clash) {
    work.issue(
      "error",
      si,
      st.id,
      `building "${st.id}" overlaps building "${taken.get(key(clash[0], clash[1])) ?? "?"}" at ${clash[0]},${clash[1]}`,
      "buildings may not share cells; move one, or make them volumes of one building",
      [clash[0], clash[1]],
    );
    return null;
  }
  const bb = boundsOf(cells);
  if (bb.w < 2 || bb.h < 2) {
    work.issue(
      "error",
      si,
      st.id,
      `building "${st.id}" is ${bb.w}x${bb.h}; a building needs at least 2x2 cells`,
      "make it at least 2 cells wide and deep",
    );
    return null;
  }
  const ring = ringOf(cellSet);
  if (
    ring.some((k) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return !inBounds(x, y);
    })
  )
    work.issue(
      "warning",
      si,
      st.id,
      `building "${st.id}" touches the level edge; its walls stand in the ring of cells around it`,
      "leave one free cell between the building and the level bounds",
    );
  const count = main.storeys.length;

  // ── openings (ground faces of the whole footprint; upper openings on the main volume) ──
  /** A neighbouring building stands on this cell (a party wall: no windows, no default door). */
  const party = (x: number, y: number): boolean => {
    const o = work.neighbours.get(key(x, y));
    return o !== undefined && o !== st.id;
  };
  const used = new Map<string, Set<string>>(); // "volume:storey" → face cells taken ("x,y,side")
  const tk = (v: string, s: number): string => `${v}:${s}`;
  const take = (v: string, s: number, k: string): void => {
    const set = used.get(tk(v, s)) ?? new Set<string>();
    set.add(k);
    used.set(tk(v, s), set);
  };
  const isTaken = (v: string, s: number, k: string): boolean => used.get(tk(v, s))?.has(k) ?? false;
  /** Ground storey faces belong to every ground volume (one area). */
  const groundKey = "@ground";
  const keyOf = (v: VolumePlan, s: number): [string, number] =>
    s === 0 && v.on === null ? [groundKey, 0] : [v.id, s];
  const ground: BuildingPlan["ground"] = [];
  const upper: BuildingPlan["upper"] = [];
  const opens = [...(st.openings ?? [])];
  if (!opens.some((o) => (o.storey ?? 0) === 0 && DOOR_KINDS.has(o.kind))) {
    const faces = SIDES.filter((s) => {
      const r = faceRuns(cellSet, s)[0];
      if (!r) return false;
      const [dx, dy] = STEP[s];
      return r.cells.every(([x, y]) => inBounds(x + dx * 2, y + dy * 2) && !party(x + dx, y + dy));
    });
    const side = st.front ?? (faces.length > 0 ? (faces[prng.int(faces.length)] ?? "S") : "S");
    opens.unshift({ kind: "door", side, position: pickRange(prng, profile.variety.doorPosition) });
  }
  const counter: Record<string, number> = {};
  const nextId = (kind: string): string => {
    const n = counter[kind] ?? 0;
    counter[kind] = n + 1;
    return `${st.id}~${kind}${n}`;
  };
  for (const o of opens) {
    const s = o.storey ?? 0;
    if (s >= count) {
      work.issue(
        "error",
        si,
        st.id,
        `building "${st.id}": opening on storey ${s}, but it has ${count} storey(s)`,
        `storeys are 0..${count - 1}`,
      );
      continue;
    }
    const faceSet = s === 0 ? cellSet : (main.storeys[s]?.cellSet ?? cellSet);
    const run = faceRuns(faceSet, o.side)[0];
    if (!run) {
      work.issue("error", si, st.id, `building "${st.id}" has no ${o.side} face`, "use N, E, S or W");
      continue;
    }
    const width = Math.min(o.width ?? (o.kind === "double_door" ? 2 : 1), run.cells.length);
    const pos = o.position ?? (DOOR_KINDS.has(o.kind) ? pickRange(prng, profile.variety.doorPosition) : 0.5);
    const a = along(run, pos, width);
    const c = run.cells[a] as [number, number];
    const [vk, vs] = keyOf(main, s);
    for (let k = 0; k < width; k++) {
      const cc = run.cells[a + k] as [number, number];
      take(vk, vs, `${cc[0]},${cc[1]},${o.side}`);
    }
    if (s === 0) ground.push({ id: nextId(o.kind), kind: o.kind, at: [c[0], c[1]], side: o.side, width });
    else upper.push({ storey: s, kind: o.kind, at: [c[0], c[1]], side: o.side, width, volume: main.id });
  }

  // ── chimneys (in the wall line of the ground footprint, on a gable end of the main roof) ──
  const chimneys: BuildingPlan["chimneys"] = [];
  const gableFaces = (): Side[] => {
    const w0 = main.rects[0];
    if (!w0) return SIDES.slice();
    return w0.ridge === "ew" ? ["W", "E"] : ["N", "S"];
  };
  const doorFaces = new Set(
    opens.filter((o) => (o.storey ?? 0) === 0 && DOOR_KINDS.has(o.kind)).map((o) => o.side),
  );
  const chimneyFaces = (() => {
    // generator 3: a hip roof has no gable wall to carry a stack, so a drawn chimney would stand apart from wall and roof
    if (generatorProfile(plan).wholeFacades && main.roof.layers[0]?.type === "hip") return [];
    const g = gableFaces().filter((f) => !doorFaces.has(f));
    return g.length > 0 ? g : SIDES.filter((f) => !doorFaces.has(f));
  })();
  const chimneyIn =
    st.chimneys ??
    (chimneyFaces.length > 0 && prng.chance(profile.variety.chimneyChance)
      ? [
          {
            side: chimneyFaces[prng.int(chimneyFaces.length)] as Side,
            position: pickRange(prng, [0.35, 0.65]),
          },
        ]
      : []);
  for (const ch of chimneyIn) {
    const run = faceRuns(cellSet, ch.side)[0];
    if (!run) {
      work.issue(
        "error",
        si,
        st.id,
        `building "${st.id}" has no ${ch.side} face for a chimney`,
        "use a side the building has",
      );
      continue;
    }
    let a = along(run, ch.position ?? 0.5, 1);
    const free = (i: number): boolean => {
      const c = run.cells[i] as [number, number];
      return !isTaken(groundKey, 0, `${c[0]},${c[1]},${ch.side}`);
    };
    if (!free(a)) {
      const alt = run.cells
        .map((_, i) => i)
        .filter(free)
        .sort((p, q) => Math.abs(p - a) - Math.abs(q - a))[0];
      if (alt === undefined) continue;
      a = alt;
    }
    const c = run.cells[a] as [number, number];
    const [dx, dy] = STEP[ch.side];
    const at: Vec2 = [c[0] + dx, c[1] + dy];
    if (!inBounds(at[0], at[1])) {
      work.issue(
        "error",
        si,
        st.id,
        `building "${st.id}": its ${ch.side} chimney would stand outside the level`,
        "use another side or move the building in",
      );
      continue;
    }
    for (const v of vplans)
      for (let s = 0; s < v.storeys.length; s++) take(...keyOf(v, s), `${c[0]},${c[1]},${ch.side}`);
    chimneys.push({ at, side: ch.side, wall: [c[0], c[1]] });
  }

  // ── frontage: the street face (given, else the first door's face) and an optional shopfront on it ──
  const frontSide: Side = st.front ?? ground.find((g) => DOOR_KINDS.has(g.kind))?.side ?? "S";
  const shopfront = st.shopfront ?? (profile.shopfront ? prng3.chance(profile.shopfront) : false);

  // ── automatic windows (rhythm from the density, offset from the seed), per volume and storey ──
  const offset = prng.int(3);
  /** Faces of a storey's cells that another volume's storey covers at the same height have no wall. */
  const covered = (v: VolumePlan, sp: VStorey, x: number, y: number): boolean =>
    vplans.some(
      (o) =>
        o !== v &&
        o.storeys.some(
          (os) =>
            os.cellSet.has(key(x, y)) &&
            Math.min(os.relTop, sp.relTop) - Math.max(os.relFloor, sp.relFloor) >
              BUILD_CONSTANTS.floorThickness,
        ),
    );
  /** The wall outside this face cell meets another wall of the building in the same host cell (an inner corner). */
  const innerCorner = (c: readonly [number, number], side: Side): boolean => {
    const [dx, dy] = STEP[side];
    const hx = c[0] + dx;
    const hy = c[1] + dy;
    return dx === 0
      ? cellSet.has(key(hx - 1, hy)) || cellSet.has(key(hx + 1, hy))
      : cellSet.has(key(hx, hy - 1)) || cellSet.has(key(hx, hy + 1));
  };
  const windowsFor = (v: VolumePlan, s: number, faceSet: ReadonlySet<string>, sp: VStorey): void => {
    if (sp.walls === null || sp.density === "none") return;
    const [vk, vs] = keyOf(v, s);
    for (const side of SIDES)
      for (const run0 of faceRuns(faceSet, side)) {
        // a shopfront: wide glazing close together on the ground storey's street face
        const shop = shopfront && vk === groundKey && side === frontSide;
        const spacing = shop ? 1 : WINDOW_SPACING[sp.density];
        const width = shop ? 2 : Math.min(profile.windows.width, 2);
        // split the face where another volume covers it
        const [dx, dy] = STEP[side];
        const parts: Array<Array<[number, number]>> = [[]];
        for (const c of run0.cells) {
          if (covered(v, sp, c[0] + dx, c[1] + dy) || party(c[0] + dx, c[1] + dy)) parts.push([]);
          else parts[parts.length - 1]?.push(c);
        }
        for (const cellsRun of parts) {
          const n = cellsRun.length;
          if (shop) {
            // a shopfront is glazed wall to wall: a window in every free cell of the street face (doors stay)
            for (const [ci, c] of cellsRun.entries()) {
              const k = `${c[0]},${c[1]},${side}`;
              if (isTaken(vk, vs, k) || innerCorner(c, side)) continue;
              // generator 3 (cottage-like walls): a corner cell keeps its wall, a window there is walled over
              if (generatorProfile(plan).wholeFacades && (ci === 0 || ci === n - 1) && n >= 3) continue;
              take(vk, vs, k);
              ground.push({ id: nextId("window"), kind: "window", at: [c[0], c[1]], side, width: 1 });
            }
            continue;
          }
          // generator 3: no blank wall (the baseline every condition inherits): a face of three cells or more gets a
          // window (one cell wide when two will not fit), and the gap between windows is at most three cells
          const noBlankWall = generatorProfile(plan).wholeFacades && !shop;
          const wd = noBlankWall && n < width + 2 && n >= 3 ? 1 : width;
          const gap = noBlankWall ? Math.min(spacing, 3) : spacing;
          if (n < wd + 2) continue;
          const keepFree = (i: number): boolean => {
            if (i < 1 || i >= n - 1) return false;
            const c = cellsRun[i] as [number, number];
            if (innerCorner(c, side)) return false;
            for (const d of [-1, 0, 1]) {
              const cc = cellsRun[i + d];
              if (cc && isTaken(vk, vs, `${cc[0]},${cc[1]},${side}`)) return false;
            }
            return !isTaken(vk, vs, `${c[0]},${c[1]},${side}`);
          };
          let p = 1 + (offset % Math.max(1, Math.min(gap, n - wd - 1)));
          while (p + wd - 1 <= n - 2) {
            let ok = true;
            for (let k = 0; k < wd; k++) if (!keepFree(p + k)) ok = false;
            if (!ok) {
              p++;
              continue;
            }
            const c = cellsRun[p] as [number, number];
            for (let k = 0; k < wd; k++) {
              const cc = cellsRun[p + k] as [number, number];
              take(vk, vs, `${cc[0]},${cc[1]},${side}`);
            }
            if (vk === groundKey)
              ground.push({ id: nextId("window"), kind: "window", at: [c[0], c[1]], side, width: wd });
            else upper.push({ storey: s, kind: "window", at: [c[0], c[1]], side, width: wd, volume: v.id });
            p += wd + gap;
          }
        }
      }
  };
  // ground storey first (one face set for every ground volume), then the rest volume by volume
  windowsFor(main, 0, cellSet, main.storeys[0] as VStorey);
  for (const v of vplans)
    v.storeys.forEach((sp, s) => {
      if (s === 0 && v.on === null) return;
      windowsFor(v, s, sp.cellSet, sp);
    });

  // ── porches ──
  const porches: BuildingPlan["porches"] = [];
  const firstDoor = ground.find((g) => DOOR_KINDS.has(g.kind));
  const drawnPorch =
    st.attachments === undefined && firstDoor !== undefined
      ? prng.chance(profile.variety.porchChance)
      : false;
  let attachIn: Array<Attachment & { seeded?: true }> =
    st.attachments ??
    (firstDoor && drawnPorch
      ? [
          {
            type: "porch" as const,
            side: firstDoor.side,
            width: firstDoor.width + 2,
            depth: 2,
            seeded: true as const,
          },
        ]
      : []);
  // generator 3: the entrance varies (none, a hood on two posts, a full-width porch, steps and a landing), drawn per
  // building and never the same as the building drawn before it (own stream; styles with no porches keep none)
  if (
    generatorProfile(plan).buildingVariety &&
    st.attachments === undefined &&
    firstDoor &&
    profile.variety.porchChance > 0
  ) {
    const ep = createPrng(subSeed(seed, "entrance3"));
    const kinds: Array<[string, number]> = [
      ["none", 0.2],
      ["hood", 0.3],
      ["porch", 0.25],
      ["landing", 0.25],
    ];
    const last = work.entrances[work.entrances.length - 1];
    let kind = "hood";
    for (let t = 0; t < 8; t++) {
      let r = ep.next() * kinds.reduce((a, [, w]) => a + w, 0);
      kind = (kinds.find(([, w]) => (r -= w) < 0) ?? ["hood", 0])[0];
      if (kind !== last) break;
    }
    work.entrances.push(kind);
    const frontRun = faceRuns(cellSet, firstDoor.side)[0];
    attachIn =
      kind === "none"
        ? []
        : [
            {
              type: "porch" as const,
              side: firstDoor.side,
              width:
                kind === "porch"
                  ? Math.min(frontRun?.cells.length ?? 5, Math.max(firstDoor.width + 4, 5))
                  : firstDoor.width + 2,
              depth: kind === "landing" ? 1 : 2,
              ...(kind === "landing" ? { roof: "none" as const } : {}),
              seeded: true as const,
            },
          ];
  }
  attachIn.forEach((at, ai) => {
    if (at.type !== "porch") {
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": ${at.type} attachments are not built yet`,
        "use a porch for now",
      );
      return;
    }
    const seeded = at.seeded === true;
    const run = faceRuns(cellSet, at.side)[0];
    if (!run) return;
    const width = Math.min(at.width ?? 3, run.cells.length);
    const depth = at.depth ?? 2;
    const door = ground.find((g) => g.side === at.side && DOOR_KINDS.has(g.kind));
    let a: number;
    if (door && at.position === undefined) {
      const di = run.cells.findIndex((c) => c[0] === door.at[0] && c[1] === door.at[1]);
      a = Math.max(0, Math.min(run.cells.length - width, di - Math.floor((width - door.width) / 2)));
    } else a = along(run, at.position ?? 0.5, width);
    const [dx, dy] = STEP[at.side];
    const pc: Vec2[] = [];
    let bad = false;
    for (let k = 0; k < width; k++) {
      const c = run.cells[a + k] as [number, number];
      for (let d = 2; d <= depth + 1; d++) {
        const x = c[0] + dx * d;
        const y = c[1] + dy * d;
        if (!inBounds(x, y) || cellSet.has(key(x, y)) || taken.has(key(x, y))) bad = true;
        pc.push([x, y]);
      }
    }
    if (bad) {
      if (!seeded)
        work.issue(
          "error",
          si,
          st.id,
          `building "${st.id}": its ${at.side} porch would leave the level or overlap a building`,
          "make it shallower or use another side",
        );
      return;
    }
    pc.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    porches.push({
      id: `${st.id}~porch${ai}`,
      cells: pc,
      side: at.side,
      floor: at.floor ?? profile.floor,
      roof: (at.roof ?? "flat") !== "none",
    });
  });

  // ── condition: a weathered or ruined building loses roof pieces, its doors and lights; breaches open in a
  // ruined ground storey; rubble and growth gather at its foot (the compiler also breaks the upper wall courses) ──
  const condition = st.condition ?? profile.condition ?? "intact";
  const gen = generatorProfile(plan);
  const legible = gen.legibleCondition;
  const prng4 = createPrng(subSeed(seed, "condition"));
  const debris: BuildingPlan["debris"] = [];
  const growth: BuildingPlan["growth"] = [];
  // generator 3: how overgrown the building is (the plan's word, else light for weathered, medium for ruined)
  const growthLevel: BuildingPlan["growthLevel"] =
    legible && condition !== "intact" ? (st.growth ?? (condition === "ruined" ? "medium" : "light")) : null;
  const heavyGrowth = growthLevel === "heavy";
  let ruin: RuinProfile | null = null;
  if (condition !== "intact") {
    const ruined = condition === "ruined";
    // the wall tops and fallen floors (resolve/ruin.ts); a gable-roofed main mass keeps the gable wall nearest
    // its standing corner, its slopes fallen in
    // (generator 3: not on timber walls: a lone stepped gable of planks is masonry logic)
    const timberWalls = legible && vplans.some((v) => v.on === null && v.storeys[0]?.walls === "wood");
    const gableWing =
      ruined && !timberWalls && main.roof.layers[0]?.type === "gable" ? main.rects[0] : undefined;
    ruin = ruinProfile(
      vplans,
      condition,
      subSeed(seed, "ruin"),
      gableWing,
      new Set(vplans.filter((v) => v.roof.layers.length > 0).map((v) => v.id)),
      {
        legibleCondition: legible,
        pitched: new Set(
          vplans
            .filter((v) => ["gable", "hip", "shed"].includes(v.roof.layers[0]?.type ?? ""))
            .map((v) => v.id),
        ),
        // generator 3: a ruin of several volumes keeps one whole under its roof more often than not
        keepRoofed:
          legible && ruined && vplans.filter((v) => v.on === null).length > 1
            ? createPrng(subSeed(seed, "anchor3")).chance(0.65)
            : false,
        openings: ground.map((g) => ({ at: g.at, side: g.side, width: g.width })),
      },
    );
    if (ruined) {
      const tops = new Map(ruin.columns.map((c) => [`${c.at[0]},${c.at[1]},${c.side}`, c.top]));
      const groundTop = vplans[0]?.storeys[0]?.relTop ?? 0;
      for (let i = ground.length - 1; i >= 0; i--) {
        const g = ground[i];
        if (!g || (g.kind !== "window" && g.kind !== "arrow_slit")) continue;
        for (let k = 0; k < g.width; k++) {
          const gx = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
          const gy = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
          if ((tops.get(`${gx},${gy},${g.side}`) ?? Infinity) < groundTop - 1e-6) {
            ground.splice(i, 1);
            break;
          }
        }
      }
    }
    // weathered: a patch of the main roof is gone (the eave pieces round it stay); its chimney has fallen
    if (!ruined) {
      const topMass = vplans.filter((v) => !vplans.some((o) => o.on === v.id) && v.roof.layers.length > 0);
      const host = topMass[prng4.int(Math.max(1, topMass.length))];
      const ts = host?.storeys[host.storeys.length - 1];
      if (ts && ts.rect.w >= 3 && ts.rect.h >= 3) {
        const cx = ts.rect.x + 1 + prng4.int(ts.rect.w - 2);
        const cy = ts.rect.y + 1 + prng4.int(ts.rect.h - 2);
        ruin.roofHoles = ts.cells.filter(([x, y]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1);
      }
      const lost: string[] = chimneys.length > 0 ? ["chimney"] : [];
      chimneys.splice(0, chimneys.length);
      if (legible) {
        // generator 3: the signs must read from the game camera (own stream; generator 2 draws are untouched)
        const wp = createPrng(subSeed(seed, "weather3"));
        // the fallen patch is ragged and sits at an eave or a corner, not in the middle (a clean square hole reads as
        // a skylight): a blob grown cell by cell from a corner of the top storey, preferring cells on its edge
        if (ts && ruin.roofHoles && ts.cells.length >= 9) {
          const rp = createPrng(subSeed(seed, "roofhole3"));
          const own = new Set(ts.cells.map(([x, y]) => key(x, y)));
          const onEdge = (x: number, y: number): boolean =>
            SIDES.some((sd) => !own.has(key(x + STEP[sd][0], y + STEP[sd][1])));
          const corners: Array<[number, number]> = [
            [ts.rect.x, ts.rect.y],
            [ts.rect.x + ts.rect.w - 1, ts.rect.y],
            [ts.rect.x, ts.rect.y + ts.rect.h - 1],
            [ts.rect.x + ts.rect.w - 1, ts.rect.y + ts.rect.h - 1],
          ];
          const start = corners[rp.int(4)] as [number, number];
          const want = Math.max(5, Math.round(ts.cells.length * (0.14 + 0.08 * rp.next())));
          const blob = new Set<string>();
          if (own.has(key(start[0], start[1]))) blob.add(key(start[0], start[1]));
          while (blob.size < want && blob.size > 0) {
            const front: Array<[number, number, number]> = [];
            for (const k of blob) {
              const [x, y] = k.split(",").map(Number) as [number, number];
              for (const sd of SIDES) {
                const nx = x + STEP[sd][0];
                const ny = y + STEP[sd][1];
                if (own.has(key(nx, ny)) && !blob.has(key(nx, ny)))
                  front.push([nx, ny, (onEdge(nx, ny) ? 3 : 1) * (0.4 + rp.next())]);
              }
            }
            if (front.length === 0) break;
            front.sort((a, b) => b[2] - a[2]);
            const pick = front[0] as [number, number, number];
            blob.add(key(pick[0], pick[1]));
          }
          if (blob.size >= 3)
            ruin.roofHoles = [...blob].map((k) => k.split(",").map(Number) as [number, number]);
        }
        // a second fallen patch elsewhere on the same roof
        if (ts && ruin.roofHoles && ts.rect.w >= 5 && ts.rect.h >= 3) {
          const taken = new Set(ruin.roofHoles.map(([x, y]) => key(x, y)));
          for (let t = 0; t < 8; t++) {
            const cx = ts.rect.x + 1 + wp.int(ts.rect.w - 2);
            const cy = ts.rect.y + 1 + wp.int(ts.rect.h - 2);
            const patch = ts.cells.filter(([x, y]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1);
            if (patch.length < 4 || patch.some(([x, y]) => taken.has(key(x, y)))) continue;
            // a clear cell between the patches keeps them two holes, not one
            if (patch.some(([x, y]) => SIDES.some((sd) => taken.has(key(x + STEP[sd][0], y + STEP[sd][1])))))
              continue;
            ruin.roofHoles = [...ruin.roofHoles, ...patch];
            break;
          }
        }
        // a third of the windows are boarded (the opening is left out: that wall is built plain), at least one
        const wins: Array<{ at: Vec2; side: Side }> = [
          ...ground.filter((g) => g.kind === "window" || g.kind === "arrow_slit"),
          ...upper.filter((g) => g.kind === "window" || g.kind === "arrow_slit"),
        ];
        const boardN = wins.length === 0 ? 0 : Math.max(1, Math.round(wins.length * 0.34));
        const boarded = wp
          .shuffle(wins.map((w) => `${w.at[0]},${w.at[1]},${w.side}`))
          .slice(0, boardN)
          .sort();
        const board = new Set(boarded);
        for (const list of [ground, upper])
          for (let i = list.length - 1; i >= 0; i--) {
            const g = list[i];
            if (
              g &&
              (g.kind === "window" || g.kind === "arrow_slit") &&
              board.has(`${g.at[0]},${g.at[1]},${g.side}`)
            )
              list.splice(i, 1);
          }
        // a flat roof's parapet is bitten in places (a pitched roof hides its wall tops)
        const bites: string[] = [];
        for (const v of vplans) {
          const top = v.storeys[v.storeys.length - 1];
          if (!top || !v.roof.layers.some((l) => l.type === "flat" && l.parapet)) continue;
          const own = new Set(top.cells.map(([x, y]) => key(x, y)));
          for (const [x, y] of top.cells)
            for (const sd of SIDES)
              if (!own.has(key(x + STEP[sd][0], y + STEP[sd][1])) && wp.chance(0.28))
                bites.push(`${x},${y},${sd}`);
        }
        // a detail has fallen or been taken away: the roof mast, one hung detail (canopy, balcony, fire escape)
        const dz = work.designs.get(st.id);
        if (dz) {
          const hung = ["canopy", "balconies", "fire_escape"].find((d) => dz.design.details.includes(d));
          if (hung) {
            lost.push(hung);
            work.designs.set(st.id, {
              ...dz,
              design: { ...dz.design, details: dz.design.details.filter((d) => d !== hung) },
            });
          }
        }
        ruin.weather = { boarded, parapetBites: bites.sort(), lost, windows: wins.length };
      }
    }
    for (const v of vplans) {
      // the anchor of a generator 3 ruin keeps its roof, a little broken at the edges
      if (ruined && ruin.keep === v.id) {
        v.roof.broken = Math.max(v.roof.broken, 0.12);
        continue;
      }
      v.roof.broken = Math.max(v.roof.broken, ruined ? 0.45 : legible ? 0.3 : 0.2);
      // a ruin's roofs have fallen in (the gable wall of a pitched one may stand)
      if (ruined) {
        if (v === main && ruin.gable) v.roof.gableOnly = ruin.gable;
        else v.roof.layers = [];
        v.roof.deck = false;
      }
    }
    main.roof.summary.broken = Math.max(main.roof.summary.broken, ruined ? 0.45 : 0.2);
    if (ruined) {
      // the chimney fell with the roof: its wall is built as broken wall like the rest
      chimneys.splice(0, chimneys.length);
      // doorways stand empty
      for (const g of ground) if (DOOR_KINDS.has(g.kind)) g.kind = "open";
      // one or two breaches in the ground storey, away from the doorways
      const breaches = 1 + prng4.int(2);
      // a breach may tear out a window, never a doorway; tried on several faces until enough are open
      const onFace = (g: (typeof ground)[number], c: readonly [number, number], side: Side): boolean => {
        if (g.side !== side) return false;
        for (let k = 0; k < g.width; k++) {
          const gx = side === "N" || side === "S" ? g.at[0] + k : g.at[0];
          const gy = side === "N" || side === "S" ? g.at[1] : g.at[1] + k;
          if (gx === c[0] && gy === c[1]) return true;
        }
        return false;
      };
      // the walls of the kept, roofed volume are not breached
      const whole = new Set<string>();
      if (ruin.keep !== undefined)
        for (const c of ruin.columns)
          if (c.top >= c.full - 1e-6) whole.add(`${c.at[0]},${c.at[1]},${c.side}`);
      let made = 0;
      for (let attempt = 0; attempt < 12 && made < breaches; attempt++) {
        const side = SIDES[prng4.int(4)] as Side;
        const run = faceRuns(cellSet, side).sort((p, q) => q.cells.length - p.cells.length)[0];
        if (!run || run.cells.length < 4) continue;
        const width = 1 + prng4.int(2);
        const a0 = 1 + prng4.int(Math.max(1, run.cells.length - width - 1));
        const [dx, dy] = STEP[side];
        let free = true;
        for (let k = -1; k <= width && free; k++) {
          const c = run.cells[a0 + k];
          if (!c) continue;
          // doorways and their neighbours stay; windows inside the breach go
          if (ground.some((g) => g.kind !== "window" && onFace(g, c, side))) free = false;
          if (whole.has(`${c[0]},${c[1]},${side}`)) free = false;
          // nor a standing arch (generator 3) and its jambs
          if (ruin.arches?.some((q) => onFace({ id: "", kind: "window", ...q }, c, side))) free = false;
          if (k >= 0 && k < width && (!inBounds(c[0] + dx * 2, c[1] + dy * 2) || party(c[0] + dx, c[1] + dy)))
            free = false;
          if (
            k >= 0 &&
            k < width &&
            chimneys.some((ch) => ch.wall[0] === c[0] && ch.wall[1] === c[1] && ch.side === side)
          )
            free = false;
        }
        if (!free) continue;
        const cells = run.cells.slice(a0, a0 + width);
        for (let i = ground.length - 1; i >= 0; i--) {
          const g = ground[i];
          if (g && g.kind === "window" && cells.some((c) => onFace(g, c, side))) ground.splice(i, 1);
        }
        for (const cc of cells) take(groundKey, 0, `${cc[0]},${cc[1]},${side}`);
        // generator 3: collapse goes top-down, so no upper wall hangs over a breach (the column ends at the storey's top)
        if (legible)
          for (const cc of cells) {
            const col = ruin.columns.find((q) => q.at[0] === cc[0] && q.at[1] === cc[1] && q.side === side);
            const gt = vplans[0]?.storeys[0]?.relTop;
            if (col && gt !== undefined && col.top > gt) col.top = gt;
          }
        const c = cells[0] as [number, number];
        ground.push({ id: nextId("breach"), kind: "open", at: [c[0], c[1]], side, width });
        made++;
      }
    }
    // generator 3: broken blocks and rubble on the cut wall tops (never over a doorway, breach or window)
    if (ruined && legible) {
      const openKeys = new Set<string>();
      for (const g of ground)
        for (let k = 0; k < g.width; k++)
          openKeys.add(
            `${g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0]},${g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k},${g.side}`,
          );
      scatterTopRubble(ruin, openKeys, subSeed(seed, "ruin"));
    }
    // rubble and growth, never in a doorway's or breach's path (three cells out, two in): a ruin's lies mostly
    // inside its walls (six in ten), in heaps scaled to how much fell, with growth among it and a few story props;
    // a weathered building has a little growth and rubble at its foot, two cells out
    const ring2 = ringOf(new Set([...cellSet, ...ringOf(cellSet)]));
    const blocked = new Set<string>();
    for (const g of ground) {
      if (g.kind === "window") continue;
      const [dx, dy] = STEP[g.side];
      for (let k = -1; k <= g.width; k++)
        for (let d = -1; d <= 3; d++) {
          const ax = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
          const ay = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
          blocked.add(key(ax + dx * d, ay + dy * d));
        }
    }
    const loss = ruin.loss;
    const outside = [...ring2].sort().filter((k) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return !blocked.has(k) && inBounds(x, y) && !work.neighbours.has(k);
    });
    const near = (x: number, y: number): boolean =>
      debris.some((d) => Math.abs(d.at[0] - x) <= 1 && Math.abs(d.at[1] - y) <= 1);
    for (const k of outside) {
      if (
        !prng4.chance(heavyGrowth ? (ruined ? 0.12 + 0.2 * loss : 0.3) : ruined ? 0.06 + 0.15 * loss : 0.15)
      )
        continue;
      const [x, y] = k.split(",").map(Number) as [number, number];
      if (near(x, y)) continue;
      debris.push({
        at: [x, y],
        kind: prng4.chance(heavyGrowth ? (ruined ? 0.25 : 0.08) : ruined ? 0.55 : 0.3) ? "rubble" : "growth",
      });
    }
    if (legible && !ruined) {
      // generator 3: growth against the foot of the walls, a heap for about every seven wall faces, never in a door's path
      const wp2 = createPrng(subSeed(seed, "weather3b"));
      let faceCount = 0;
      for (const k of cellSet) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        for (const sd of SIDES) if (!cellSet.has(key(x + STEP[sd][0], y + STEP[sd][1]))) faceCount++;
      }
      const foot = [...ringOf(cellSet)].sort().filter((k) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        return !blocked.has(k) && inBounds(x, y) && !work.neighbours.has(k);
      });
      const want = Math.max(2, Math.ceil(faceCount / (heavyGrowth ? 3 : 7)));
      let made = 0;
      for (const k of wp2.shuffle(foot)) {
        if (made >= want) break;
        const [x, y] = k.split(",").map(Number) as [number, number];
        if (near(x, y)) continue;
        debris.push({ at: [x, y], kind: "growth" });
        made++;
      }
    }
    if (ruined) {
      // inside: off the wall cells (a heap there would lean into the wall), never two side by side
      const inside = [...cellSet].sort().filter((k) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        return !blocked.has(k) && SIDES.every((sd) => cellSet.has(key(x + STEP[sd][0], y + STEP[sd][1])));
      });
      const want = Math.max(
        2,
        Math.round(debris.filter((d) => d.kind === "rubble").length * 1.5) +
          Math.round(inside.length * 0.1 * loss),
      );
      const picked: string[] = [];
      for (const k of prng4.shuffle(inside)) {
        if (picked.length >= Math.min(Math.round(inside.length * 0.5), want)) break;
        const [x, y] = k.split(",").map(Number) as [number, number];
        if (
          picked.some((p) => {
            const [px, py] = p.split(",").map(Number) as [number, number];
            return Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1;
          })
        )
          continue;
        picked.push(k);
      }
      picked.forEach((k, i) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        debris.push({
          at: [x, y],
          kind:
            i === 0
              ? "rubble"
              : i <= 2 && inside.length >= 12
                ? "prop"
                : prng4.chance(heavyGrowth ? 0.35 : 0.8)
                  ? "rubble"
                  : "growth",
        });
      });
    }
    // generator 3: what fell lies on the ground beside where it fell: clusters of heaps within two or three cells of
    // each fallen stretch of wall, inside and outside, not in the ring cell the vines use (own stream)
    if (ruined && legible) {
      const fp = createPrng(subSeed(seed, "fallen3"));
      const have = new Set(debris.map((d) => key(d.at[0], d.at[1])));
      const fallenCols = ruin.columns.filter((c) => {
        const [dx, dy] = STEP[c.side];
        return c.full - c.top >= 1.5 && !cellSet.has(key(c.at[0] + dx, c.at[1] + dy));
      });
      let budget = Math.max(6, Math.round(fallenCols.length * 0.8));
      for (const c of fp.shuffle(fallenCols)) {
        if (budget <= 0) break;
        const [dx, dy] = STEP[c.side];
        const [lx, ly] = [Math.abs(dy), Math.abs(dx)];
        const spots: Array<[number, number]> = [];
        for (const d of [-1, 0, 2, 3])
          for (const l of [-1, 0, 1]) spots.push([c.at[0] + dx * d + lx * l, c.at[1] + dy * d + ly * l]);
        const n = Math.min(4, 1 + Math.round((c.full - c.top) / 2) + fp.int(2));
        let made = 0;
        for (const [x, y] of fp.shuffle(spots)) {
          if (made >= n) break;
          const k = key(x, y);
          if (have.has(k) || !inBounds(x, y) || blocked.has(k) || work.neighbours.has(k)) continue;
          have.add(k);
          debris.push({ at: [x, y], kind: fp.chance(heavyGrowth ? 0.35 : 0.85) ? "rubble" : "growth" });
          made++;
          budget--;
        }
      }
    }
    // generator 3: growth that climbs the structure (vines up the faces, roots at the base, plants on cut tops, a tree
    // in a roofless middle); own stream, so generator 2 draws are untouched
    if (legible) {
      const faceKeys = new Set<string>();
      const around = (at: readonly [number, number], side: Side, from: number, to: number): void => {
        for (let k = from; k <= to; k++)
          faceKeys.add(
            `${side === "N" || side === "S" ? at[0] + k : at[0]},${side === "N" || side === "S" ? at[1] : at[1] + k},${side}`,
          );
      };
      // (heavy growth frames the windows: ivy runs up to a window's edge, never across it)
      for (const g of ground)
        if (heavyGrowth && (g.kind === "window" || g.kind === "arrow_slit"))
          around(g.at, g.side, 0, g.width - 1);
        else around(g.at, g.side, -1, g.width);
      for (const q of ruin.arches ?? []) around(q.at, q.side, -1, q.width);
      for (const c of chimneys) around(c.wall, c.side, -1, 1);
      const upperFaces = new Set<string>();
      for (const g of upper) around(g.at, g.side, 0, g.width - 1);
      const groundTop = main.storeys[0]?.relTop ?? 2;
      const taken2 = new Set((ruin.topRubble ?? []).map((t) => `${t.at[0]},${t.at[1]},${t.side}`));
      const heapCells = new Set(debris.map((d) => key(d.at[0], d.at[1])));
      const open = new Set<string>();
      // a tree stands well clear of every doorway and breach (its crown is two and a half cells wide)
      const doorZone = new Set<string>();
      for (const g of ground)
        for (let k = -3; k <= g.width + 2; k++)
          for (let dd = -4; dd <= 4; dd++) {
            const [sx, sy] = STEP[g.side];
            const ax = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
            const ay = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
            doorZone.add(key(ax + sx * dd, ay + sy * dd));
          }
      if (ruined)
        for (const v of vplans)
          if (v.on === null && v.roof.layers.length === 0)
            for (const [x, y] of v.storeys[0]?.cells ?? []) {
              let clear = !doorZone.has(key(x, y));
              // (a heavily overgrown ruin plants its trees among the bushes: only the tree's own cell is kept clear)
              for (let dy = heavyGrowth ? 0 : -1; dy <= (heavyGrowth ? 0 : 1) && clear; dy++)
                for (let dx = heavyGrowth ? 0 : -1; dx <= (heavyGrowth ? 0 : 1); dx++)
                  if (heapCells.has(key(x + dx, y + dy))) clear = false;
              if (clear) open.add(key(x, y));
            }
      growth.push(
        ...climbingGrowth({
          seed: subSeed(seed, "growth3"),
          ruined,
          level: growthLevel ?? "light",
          columns: ruin.columns,
          anchor: ruin.anchor,
          cellSet,
          blocked: faceKeys,
          upperFaces,
          groundTop,
          // (a foot heap in or beside the ring cell, a door path or a neighbour takes the face: a heap is wider than its cell)
          ringFree: (x, y) =>
            inBounds(x, y) &&
            !work.neighbours.has(key(x, y)) &&
            !blocked.has(key(x, y)) &&
            // (vines meet the heaps at the foot: only a heap in the ring cell itself takes the face)
            !heapCells.has(key(x, y)),
          topTaken: taken2,
          open,
        }),
      );
    }
  }

  // ── door lights ──
  const lights: BuildingPlan["lights"] = [];
  const doorLights = condition === "ruined" ? false : (st.lighting?.doors ?? profile.doorLight);
  if (doorLights)
    for (const g of ground) {
      if (!DOOR_KINDS.has(g.kind) || g.kind === "secret_door") continue;
      const run = faceRuns(cellSet, g.side).find((r) =>
        r.cells.some((c) => c[0] === g.at[0] && c[1] === g.at[1]),
      );
      if (!run) continue;
      const di = run.cells.findIndex((c) => c[0] === g.at[0] && c[1] === g.at[1]);
      const cand = [di + g.width, di - 1]
        .map((i) => run.cells[i])
        .find((c) => c && !isTaken(groundKey, 0, `${c[0]},${c[1]},${g.side}`));
      if (cand) lights.push({ at: [cand[0], cand[1]], side: g.side });
    }

  // ── plinth, furniture, lighting (phase 2 stream) ──
  let plinth: BuildingPlan["plinth"] = null;
  const pp = profile.plinth;
  const pIn =
    st.plinth ??
    (pp && prng2.chance(pp.chance)
      ? {
          height: Math.round((pp.height[0] + (pp.height[1] - pp.height[0]) * prng2.next()) * 2) / 2,
          margin: pp.margin,
          face: pp.face,
          rim: pp.rim ?? "none",
        }
      : null);
  if (pIn) {
    const margin = pIn.margin ?? pp?.margin ?? 1;
    let pcells = new Set(cellSet);
    const sides = pIn.sides;
    for (let m = 0; m < margin; m++) {
      if (!sides) pcells = new Set([...pcells, ...ringOf(pcells)]);
      else {
        // out from the given faces only (a stoop toward the street)
        const next = new Set(pcells);
        for (const k of pcells) {
          const [x, y] = k.split(",").map(Number) as [number, number];
          for (const sd of sides) next.add(key(x + STEP[sd][0], y + STEP[sd][1]));
        }
        pcells = next;
      }
    }
    // a base never reaches into a neighbour's plot or the ring its walls stand in (party walls, alleys)
    const neighbourRing = new Set<string>();
    for (const [k, o] of work.neighbours)
      if (o !== st.id) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) neighbourRing.add(key(x + dx, y + dy));
      }
    const inside: Vec2[] = [];
    let clipped = false;
    for (const k of [...pcells].sort()) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      if (!cellSet.has(k) && neighbourRing.has(k)) continue;
      if (!inBounds(x, y) || (taken.has(k) && !cellSet.has(k))) clipped = true;
      else inside.push([x, y]);
    }
    if (clipped)
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": its plinth reaches past the level edge or into another building; the cells outside are left off`,
        "move the building in, or lower the plinth margin",
      );
    plinth = {
      height: pIn.height,
      margin,
      face: pIn.face ?? pp?.face ?? "flagstone",
      rim: pIn.rim === "none" ? null : (pIn.rim ?? pp?.rim ?? null),
      approach: pIn.approach ?? "steps",
      cells: inside.sort((p, q) => p[1] - q[1] || p[0] - q[0]),
    };
  }
  const pf = profile.furniture ?? { dormers: 0, clutter: [0, 0] as const, mast: 0, finial: true };
  const furniture = {
    dormers: st.roofFurniture?.dormers ?? prng2.chance(pf.dormers),
    clutter:
      st.roofFurniture?.clutter ??
      Math.round((pf.clutter[0] + (pf.clutter[1] - pf.clutter[0]) * prng2.next()) * 100) / 100,
    mast: st.roofFurniture?.mast ?? prng2.chance(pf.mast),
    finial: st.roofFurniture?.finial ?? pf.finial,
    ...(pf.hut !== undefined || st.roofFurniture?.hut !== undefined
      ? { hut: st.roofFurniture?.hut ?? prng3.chance(pf.hut ?? 0) }
      : {}),
  };
  if (legible && ruin?.weather && furniture.mast) {
    furniture.mast = false;
    ruin.weather.lost.push("mast");
  }
  const pl = profile.lighting ?? {
    windows: "none" as const,
    lit: [0, 0] as const,
    colours: ["warm"],
    strips: 0,
  };
  const lighting = {
    windows: st.lighting?.windows ?? pl.windows,
    colour: st.lighting?.colour ?? pl.colours[prng2.int(Math.max(1, pl.colours.length))] ?? "warm",
    lit: Math.max(
      Math.round((pl.lit[0] + (pl.lit[1] - pl.lit[0]) * prng2.next()) * 100) / 100,
      // a dark-walled building lights more of its windows, so they read
      designed && profile.design?.tones?.[designed.design.material] === "dark"
        ? (profile.design.darkLit ?? 0)
        : 0,
    ),
    doors: doorLights,
    strips: st.lighting?.strips ?? prng2.chance(pl.strips),
  };
  // nobody lives in a ruin; a weathered building has fewer lights on
  if (condition === "ruined") {
    lighting.windows = "none";
    lighting.strips = false;
  } else if (condition === "weathered") lighting.lit = Math.round(lighting.lit * (legible ? 15 : 30)) / 100; // most windows dark

  // ── reserved cells: wall ring, door approaches (two cells out), chimney, porch and a ring around the porch ──
  const reserve = new Set<string>(ringOf(cellSet));
  for (const g of ground) {
    if (!DOOR_KINDS.has(g.kind)) continue;
    const [dx, dy] = STEP[g.side];
    const reach = 2 + (plinth ? plinth.margin + Math.ceil(plinth.height) : 0);
    for (let k = 0; k < g.width; k++) {
      const ax = g.side === "N" || g.side === "S" ? g.at[0] + k : g.at[0];
      const ay = g.side === "N" || g.side === "S" ? g.at[1] : g.at[1] + k;
      for (let d = 1; d <= reach; d++) reserve.add(key(ax + dx * d, ay + dy * d));
    }
  }
  for (const c of chimneys) reserve.add(key(c.at[0], c.at[1]));
  for (const p of porches) {
    const ps = new Set(p.cells.map(([x, y]) => key(x, y)));
    for (const k of ps) reserve.add(k);
    for (const k of ringOf(ps)) reserve.add(k);
  }
  if (plinth) for (const [x, y] of plinth.cells) reserve.add(key(x, y));

  return {
    st,
    si,
    profile,
    theme: st.theme ?? levelTheme,
    seed,
    cells,
    cellSet,
    wings: main.rects,
    storeys: main.storeys,
    roof: main.roof.summary,
    volumes: vplans,
    ground,
    upper,
    chimneys,
    porches,
    lights,
    reserve,
    plinth,
    furniture,
    lighting,
    frontage: { side: frontSide, shopfront },
    condition,
    valleys: gen.roofValleys,
    roofFill: gen.closedRoofs,
    debris,
    growth,
    ...(growthLevel !== null ? { growthLevel } : {}),
    ruin,
  };
}

const ridgeFrom = (r: Roof | "none" | undefined): "ew" | "ns" | undefined =>
  r === undefined || r === "none" ? undefined : r.ridge;

const rectText = (r: { x: number; y: number; w: number; h: number } | undefined): string =>
  r ? `${r.x},${r.y} ${r.w}x${r.h}` : "?";

function rectCells(r: { x: number; y: number; w: number; h: number }): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

/** Chamfered corners: the four corner cells of a rect of at least 3×3 are cut off. */
function chamfer(
  cells: Array<[number, number]>,
  r: { x: number; y: number; w: number; h: number },
): Array<[number, number]> {
  if (r.w < 3 || r.h < 3) return cells;
  const x1 = r.x + r.w - 1;
  const y1 = r.y + r.h - 1;
  return cells.filter(([x, y]) => !((x === r.x || x === x1) && (y === r.y || y === y1)));
}

function boundsOf(cells: ReadonlyArray<readonly [number, number]>): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
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
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** The volume's roof as stacked layers: the plan's roof (or the style's), its further layers, normalised and checked. */
function resolveRoof(
  spec: VolumeSpec,
  st: Building,
  profile: StructureStyleProfile,
  prng2: Prng,
  work: StructureWork,
  si: number,
): VolumePlan["roof"] {
  const given = spec.roof;
  const first: Roof = given === "none" ? { type: "none" } : (given ?? { type: profile.roof.type });
  const extra: RoofLayer[] =
    given === undefined || given === "none"
      ? given === "none"
        ? []
        : (profile.roofLayers ?? []).map((l) => ({
            type: l.type,
            ...(l.courses ? { courses: l.courses } : {}),
            ...(l.kit ? { style: l.kit } : {}),
          }))
      : (first.layers ?? []);
  const raw: RoofLayer[] = [
    {
      type: first.type,
      ...(first.style ? { style: first.style } : {}),
      ...(first.ridge ? { ridge: first.ridge } : {}),
      ...(first.courses ? { courses: first.courses } : {}),
      ...(first.low ? { low: first.low } : {}),
      ...(first.parapet ? { parapet: first.parapet } : {}),
    },
    ...extra,
  ];
  const kit = first.style ?? profile.roof.kit;
  const layers: ResolvedVolume["roof"]["layers"] = [];
  const rect = spec.rects[0];
  for (const l of raw) {
    let type: string = l.type === "cone" ? "spire" : l.type;
    const requested = l.type;
    if (layers.length > 0 && CLOSING.has(layers[layers.length - 1]?.type ?? "")) {
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": roof layer "${requested}" of volume "${spec.id}" stands on a roof that is already closed; it is left out`,
        "put skirt or stepped layers below gable, hip, shed, spire or flat",
      );
      continue;
    }
    if (!BUILT_ROOFS.has(type)) {
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": "${requested}" roofs are not built yet; it gets a flat roof`,
        "use gable, hip, shed, skirt, stepped, spire, flat or none",
      );
      type = "flat";
    }
    if (
      (type === "gable" ||
        type === "hip" ||
        type === "shed" ||
        type === "spire" ||
        type === "skirt" ||
        type === "stepped") &&
      !rect
    ) {
      work.issue(
        "warning",
        si,
        st.id,
        `building "${st.id}": a ${type} roof needs a rectangular volume or wings; this footprint gets a flat roof`,
        "describe the building as wings or volumes of rectangles",
      );
      type = "flat";
    }
    if (type === "gable" && spec.rects.length > 1 && layers.length === 0)
      work.issue(
        "info",
        si,
        st.id,
        `building "${st.id}": roofs of several wings meet with approximate valleys`,
        "a single wing gives the cleanest roof",
      );
    const parapet = l.parapet === "none" ? null : (l.parapet ?? profile.roof.parapet);
    const courses =
      l.courses ??
      (type === "spire" && profile.spire
        ? profile.spire.bands[0] + prng2.int(profile.spire.bands[1] - profile.spire.bands[0] + 1)
        : 1);
    layers.push({
      type: type as BuiltRoofType,
      requested,
      style: l.style ?? kit,
      courses,
      low: l.low ?? "S",
      parapet,
      ridge: l.ridge ?? rect?.ridge ?? "ew",
    });
  }
  const deck = (given !== undefined && given !== "none" ? given.deck : undefined) ?? profile.roof.deck;
  const broken = (given !== undefined && given !== "none" ? given.broken : undefined) ?? profile.roof.broken;
  const l0 = layers[0];
  return {
    layers,
    deck,
    broken,
    summary: {
      type: l0?.type ?? "none",
      requested: l0?.requested ?? "none",
      style: l0?.style ?? kit,
      deck,
      broken,
      parapet: l0?.parapet ?? null,
    },
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
