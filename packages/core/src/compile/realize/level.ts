/**
 * Realize, one level as every pass sees it: the resolved level (read through its view), the facts the passes derive
 * from it once, and the one way to place an asset (`emit`), which collects the level's placements and box.
 * Reads: the plan-wide context and the resolved level. Writes: `placements` and `levelBox`, only through `emit` and
 * `rebox`, and the context's per-placement registries.
 *
 * What one pass leaves for a later one is not stored here: the pass returns it and compile/realize.ts hands it to the
 * passes that read it (the ownership table is at the top of compile/realize.ts).
 */
import type { Box3, Placement, PlacementRole } from "../../contracts/compiler";
import type { Material, Side } from "../../contracts/plan";
import { CELL, type ResolvedLevel } from "../../contracts/resolved";
import type { ResolvedVariant } from "../../palette/resolve";
import { materialInfo } from "../../resolve/materials";
import { areaReferenceHeights } from "../../resolve/wallspan";
import { emptyBox, growBox, h32, placementBox } from "../geometry";
import { structureClaims } from "../structure";
import type { RealizeCtx } from "./context";
import { LevelView, type CellInfo } from "./view";

export const EPS = 1e-6;
export const opposite = (s: Side): Side => (s === "N" ? "S" : s === "S" ? "N" : s === "E" ? "W" : "E");

/**
 * Ground whose drops of a tile or more are built as rock cliffs when the palette has no cliff.<material> role, whose
 * bare faces show rock and whose floors take floor families: the material table's `cliffGround` (natural ground and
 * lava, resolve/materials.ts). Water is the table's `isWater`.
 */
export const isCliffGround = (m: Material): boolean => materialInfo(m).cliffGround;

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

export class RealizeLevel {
  readonly V: LevelView;
  /** The level's elevation (absolute tiles). */
  readonly elev: number;
  /** This level's placements in emission order (output.ts sorts them). */
  readonly placements: readonly Placement[];
  /** World box of this level's placements. */
  readonly levelBox: Readonly<Box3>;
  /** Cells of the level's outcrops ("x,y"): rock columns, not floor tiles. */
  readonly outcropCells: ReadonlySet<string>;
  /** Reference floor height of each area (resolve/wallspan.ts), for wall spans. */
  readonly refHeights: ReadonlyMap<number, number>;
  /** Edges and openings buildings build themselves (compile/structure.ts): the wall passes leave them alone. */
  readonly claimed: ReturnType<typeof structureClaims>;
  /**
   * Relative ground height outside the level bounds: with the generator's `foundation` switch the level stands on a
   * solid foundation down to its lowest floor (raised land has thickness seen from the side); else 0.
   */
  readonly outsideGround: number;

  /** Seeded quarter turn for square whole-cell blocks (mixes up repeated rock faces). */
  readonly blockTurn: (v: ResolvedVariant, key: string) => number;
  /** Absolute floor top of a cell. */
  readonly topOf: (c: CellInfo) => number;
  readonly emit: Emit;
  /**
   * Replaces the world box of a placement already emitted (a tile turned off the quarter turns, whose box is its turned
   * outline); the level box keeps both.
   */
  readonly rebox: (p: Placement, box: Box3) => void;

  constructor(
    readonly ctx: RealizeCtx,
    readonly L: ResolvedLevel,
  ) {
    const { views, defaultTheme, seed, orientation, palettes, profile, placementBoxes, placementMeta } = ctx;
    const placements: Placement[] = [];
    const levelBox = emptyBox();
    this.placements = placements;
    this.levelBox = levelBox;
    this.V = views.get(L.id) ?? new LevelView(L, defaultTheme);
    this.outcropCells = new Set((L.outcrops ?? []).flatMap((o) => o.cells.map(([x, y]) => `${x},${y}`)));
    this.blockTurn = (v: ResolvedVariant, key: string): number =>
      Math.abs(v.geom.size.x - v.geom.size.z) < 0.05 ? (h32(`${seed}:${L.id}:turn:${key}`) % 4) * 90 : 0;
    const elev = L.elevation;
    this.elev = elev;
    this.topOf = (c: CellInfo): number => elev + c.height + 0.5;
    this.refHeights = areaReferenceHeights(L);
    // buildings build their own shell (compile/structure.ts)
    this.claimed = structureClaims(L);
    this.outsideGround = profile.foundation ? Math.min(lowestGround(L), -(L.foundation ?? 0)) : 0;

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
    this.rebox = (p: Placement, box: Box3): void => {
      placementBoxes.set(p, box);
      growBox(levelBox, box);
    };
  }
}

/** The lowest ground of a level (relative tiles, at most 0): its open cells and the ground under its bridges. */
function lowestGround(L: ResolvedLevel): number {
  let lowest = 0;
  for (let i = 0; i < L.bounds.w * L.bounds.h; i++)
    if (L.cells.state[i] === CELL.OPEN) lowest = Math.min(lowest, (L.cells.height[i] ?? 0) / 4);
  for (const b of L.bridges ?? []) for (const q of b.under) lowest = Math.min(lowest, q / 4);
  return lowest;
}
