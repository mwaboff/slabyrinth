/**
 * Realize, one level's working state: the placements made so far and everything one pass leaves for a later one,
 * plus the primitive every pass places through (`emit`).
 * Reads: the plan-wide context and the resolved level. Writes: `placements` and `levelBox` (through `emit`) and the
 * registries of the context; the passes write the other fields, each field says which.
 */
import type { Placement, PlacementRole } from "../../contracts/compiler";
import type { Side, ThemeId } from "../../contracts/plan";
import type { ResolvedLevel } from "../../contracts/resolved";
import type { cliffRockKinds } from "../../gen/cover";
import type { ResolvedVariant, RoleResolution } from "../../palette/resolve";
import { axisPosition } from "../../resolve/road";
import { areaReferenceHeights } from "../../resolve/wallspan";
import { emptyBox, growBox, h32, placementBox } from "../geometry";
import type { Shell } from "../shell";
import { structureClaims } from "../structure";
import type { RealizeCtx } from "./context";
import { LevelView, type CellInfo } from "./view";

/** One edge strip (a wall or door piece occupying the half-cell next to an edge), for corner posts. */
export interface Strip {
  orient: "h" | "v";
  /** Plan side of the edge line the strip lies on: h → "N"|"S", v → "W"|"E". */
  side: Side;
  style: string;
  theme: ThemeId;
  base: number;
  top: number;
}

/** One wall edge as a piece standing on it sees it (edges.ts `edgeCtx`; the shell's skirt and kerbs build their own). */
export interface EdgeCtx {
  orient: "h" | "v";
  x: number;
  y: number;
  hostFirst: boolean;
  hostX: number;
  hostY: number;
  /** The cell on the other side of the edge (full-cell blocks go there when the host cell is open). */
  otherX: number;
  otherY: number;
  otherOpen: boolean;
  planSide: Side;
  base: number;
  top: number;
  theme: ThemeId;
  hostOpen: boolean;
}

export const EPS = 1e-6;
export const opposite = (s: Side): Side => (s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E");

/** Water materials: TaleSpire's water is a board-wide plane, so the slab carries the channel's bed. */
export const WATER = new Set(["water_shallow", "water_deep"]);
/** Natural ground whose drops of a tile or more are built as rock cliffs when the palette has no cliff.<material> role. */
export const NATURAL_GROUND = new Set([
  "rock",
  "dirt",
  "gravel",
  "mud",
  "sand",
  "grass",
  "snow",
  "ice",
  "swamp",
  "lava",
]);

/** Places one asset (world tiles, rotation in degrees) and records its box and name. */
export type Emit = (
  v: ResolvedVariant,
  role: PlacementRole,
  x: number,
  y: number,
  z: number,
  rotDeg: number,
  source: Placement["source"],
  layer?: string,
) => void;

export class LevelWork {
  readonly V: LevelView;
  /** The level's elevation (absolute tiles). */
  readonly elev: number;
  /** This level's placements in emission order (output.ts sorts them). */
  readonly placements: Placement[] = [];
  /** World box of this level's placements. */
  readonly levelBox = emptyBox();
  /**
   * Upright pieces already realized per role, for the run mix (round 5): along a row or column, a piece does not
   * take an asset a neighbour within three cells already shows (a row of identical cypresses read
   * as a planted hedge), when its role has another weighted asset.
   */
  readonly runPicks = new Map<string, Array<{ x: number; y: number; uuid: string }>>();
  /** Cells of the level's outcrops ("x,y"): rock columns, not floor tiles. */
  readonly outcropCells: Set<string>;
  /** Water cells the floor pass left for the bed pass. */
  readonly waterCells: Array<[number, number]> = [];
  /** Road axis of every carriageway cell ("x,y"): road tiles keep one orientation along it. */
  readonly roadAxisAt = new Map<string, "h" | "v">();

  // ── rock band (cliffBand.ts) ──
  /** Low ground in front of a tall band edge ("x,y"): natural ground there is laid as rock (floors.ts). */
  readonly bandLow = new Set<string>();
  /** Cells just behind a tall band edge ("x,y"): no face blocks and no hidden fill (fill.ts). */
  readonly bandBack = new Set<string>();
  /** Upper cells of a band edge the band left bare: they get a face block of one family. */
  readonly bandBare = new Set<string>();
  /** cliffKinds per theme, memoised. */
  readonly kindMemo = new Map<ThemeId, ReturnType<typeof cliffRockKinds>>();
  /** Cells within 3 of a band rock ("x,y"), built on first use (nearCliff). */
  cliffCells: Set<string> | undefined = undefined;

  // ── ground and fill (floors.ts, fill.ts) ──
  /** The ground under each bridge deck cell ("x,y", relative tiles; floors.ts), for the faces round it. */
  readonly groundUnder = new Map<string, number>();
  /** Theme and material pairs already noted as having no cliff piece (cliffFace). */
  readonly cliffNoted = new Set<string>();
  /** Relative ground height outside the level bounds (generator 2 foundation; set by layRaisedFill). */
  outsideGround = 0;

  // ── walls (edges.ts, solidShell.ts, walls.ts, rockWalls.ts, openings.ts) ──
  /** Reference floor height of each area (resolve/wallspan.ts), for wall spans. */
  readonly refHeights: Map<number, number>;
  /** Edges and openings buildings build themselves (compile/structure.ts): the wall passes leave them alone. */
  readonly claimed: ReturnType<typeof structureClaims>;
  /** Edge strips ending at each vertex ("x,y"), registered by the wall and opening passes, for corner posts. */
  readonly strips = new Map<string, Array<Strip & { dir: Side }>>();
  /** Rough interior cells (1) that get broken wall tops; null when the level has none (planSolidShell). */
  roughMap: Uint8Array | null = null;
  /** The generator-4 solid shell of a carved level, null when there is none (planSolidShell). */
  shell: Shell | null = null;
  /** The shell's cap role and its square cap pieces (planSolidShell). */
  capRes: RoleResolution | null = null;
  capVariants: ResolvedVariant[] = [];
  /** The shell's skirt edges as wall runs see them, by "<orient><edge index>" (planSolidShell). */
  readonly shellEdges = new Map<string, EdgeCtx>();
  /** Full-cell wall columns by cell ("x,y"), gathered by the wall runs and built by the rock wall pass. */
  readonly fullCells = new Map<
    string,
    { x: number; y: number; base: number; top: number; theme: ThemeId; roleName: string }
  >();

  /** Seeded quarter turn for square whole-cell blocks (mixes up repeated rock faces). */
  readonly blockTurn: (v: ResolvedVariant, key: string) => number;
  /** Absolute floor top of a cell. */
  readonly topOf: (c: CellInfo) => number;
  readonly emit: Emit;

  constructor(
    readonly ctx: RealizeCtx,
    readonly L: ResolvedLevel,
  ) {
    const { views, defaultTheme, seed, orientation, palettes, placementBoxes, placementMeta } = ctx;
    const { placements, levelBox } = this;
    this.V = views.get(L.id) ?? new LevelView(L, defaultTheme);
    this.outcropCells = new Set((L.outcrops ?? []).flatMap((o) => o.cells.map(([x, y]) => `${x},${y}`)));
    this.blockTurn = (v: ResolvedVariant, key: string): number =>
      Math.abs(v.geom.size.x - v.geom.size.z) < 0.05 ? (h32(`${seed}:${L.id}:turn:${key}`) % 4) * 90 : 0;
    const elev = L.elevation;
    this.elev = elev;
    this.topOf = (c: CellInfo): number => elev + c.height + 0.5;
    const roadAxisAt = this.roadAxisAt;
    for (const rd of L.roads ?? [])
      for (const [x, y] of rd.carriageway) roadAxisAt.set(`${x},${y}`, axisPosition(rd.axis, x, y).dir);
    // pure functions of the level, computed once for the wall passes
    this.refHeights = areaReferenceHeights(L);
    // buildings build their own shell (compile/structure.ts)
    this.claimed = structureClaims(L);

    this.emit = (
      v: ResolvedVariant,
      role: PlacementRole,
      x: number,
      y: number,
      z: number,
      rotDeg: number,
      source: Placement["source"],
      layer?: string,
    ): void => {
      const rot = (((Math.round(rotDeg / 15) * 15) % 360) + 360) % 360;
      const p: Placement = {
        asset: v.uuid,
        x: x + v.offset.x,
        y: y + v.offset.y,
        z: z + v.offset.z,
        rot,
        role,
        levelId: L.id,
        source,
      };
      if (layer !== undefined) p.layer = layer;
      const box = placementBox(v.geom, p.x, p.y, p.z, rot * orientation.rotSense);
      placementBoxes.set(p, box);
      placementMeta.set(p, { name: v.name ?? palettes.availability.name(v.uuid) ?? v.uuid, geom: v.geom });
      growBox(levelBox, box);
      placements.push(p);
    };
  }
}
