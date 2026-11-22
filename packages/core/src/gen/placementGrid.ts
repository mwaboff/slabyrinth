/**
 * What every placer in gen/ works against and returns: the read-only view of the level being resolved
 * (`PlacementGrid`), the placements it proposes (`GeneratedPlacement`) and the few questions all of them ask of the
 * grid. Its own module so the placers (scatter and dress in place.ts, the set pieces, water, the cliff band, room
 * recipes) share it without importing each other.
 */
import type { FeatureType, Rotation, Side } from "../contracts/plan";
import { generatorProfile, type GeneratorProfile } from "../plan/generator";
import { EDGE_WALL } from "./gridGeometry";

export interface PlacementGrid {
  inBounds(x: number, y: number): boolean;
  /** OPEN with floor (not NO_FLOOR). */
  isFloor(x: number, y: number): boolean;
  /** CELL_FLAG bits. */
  flags(x: number, y: number): number;
  /** Display area index + 1 (0 = none). */
  area(x: number, y: number): number;
  /** Any feature already on the cell. */
  occupied(x: number, y: number): boolean;
  /** Edge kind on the given side of the cell (EDGE.*). */
  edge(x: number, y: number, side: Side): number;
  /**
   * Floor height of the cell in tiles above the level floor (resolver height / 4). Optional: the composed set
   * pieces use it to put focal pieces on high ground and keep multi-cell pieces off height steps; without it they
   * fall back to LEDGE edges.
   */
  height?(x: number, y: number): number;
  /**
   * True on cells under a landmark piece already placed (a great tree, a landmark, a great statue). Optional: the
   * composed set pieces keep a cleared apron round it, whichever dress op placed it.
   */
  landmark?(x: number, y: number): boolean;
  /**
   * True on cells nothing generated may stand on: a road crossing and the pavement cells at its ends (the people
   * crossing need them). Optional.
   */
  keepClear?(x: number, y: number): boolean;
  /**
   * Generator 4: a blocking piece of this type anchored at `at` with this footprint would stand in, or reach with its
   * real outline over, a cell in front of a way in (both sides of a door, archway or gap; the lane before a stall's
   * front). A placer that chooses among spots asks it to pick another; whatever a placer proposes there is refused
   * when it is committed (resolve/level/features.ts FeatureWork.addGenerated). Optional: absent, nothing is kept clear
   * this way.
   */
  blocksWayIn?(
    type: FeatureType,
    at: readonly [number, number],
    size: readonly [number, number],
    variant?: string,
    /** Generator 5 (`exactWayInReach`): how the piece stands, so one set square reaches exactly its outline. */
    pose?: { rotFine: number; offset?: readonly [number, number] },
  ): boolean;
  /** True on cells under a vehicle already placed (by the plan or another op). Optional. */
  vehicle?(x: number, y: number): boolean;
  /**
   * Size in tiles (w along its length, d across, h tall) of the asset a feature type resolves to when it is anchored
   * on cell (x, y), from the palette of the theme it is built in; undefined where that theme has no such asset.
   * Optional: without the hook the cliff band uses nominal sizes; with it, a theme that has neither cliff_face nor
   * cliff_crest gets no band (its cliff keeps the built face). Every piece question takes the anchor cell, so a placer
   * cannot ask a theme other than the one the piece is built in.
   */
  pieceSize?(type: FeatureType, x: number, y: number): { w: number; d: number; h: number } | undefined;
  /**
   * True on the cells of a rock ramp (`ResolvedLevel.ramps[].cells`; they carry no path flag). Nothing generated
   * stands on them; the cliff band lines their sides from the upper ground. Optional.
   */
  ramp?(x: number, y: number): boolean;
  /**
   * The plan's generator version (`plan.generator`). Optional: absent means 2. The placers read what it does through
   * `gridProfile(grid)` (plan/generator.ts), never the number.
   */
  generator?: number;
  /**
   * Generator 3: the asset's real outline in tiles (w along its length at turn 0, d across, h tall; the variant a
   * piece most likely is), where `pieceSize` gives its footprint in cells. The rock band plans with it, and the
   * review and the realizer judge cover with it. Anchored on cell (x, y), as `pieceSize`. Optional.
   */
  pieceExtent?(type: FeatureType, x: number, y: number): { w: number; d: number; h: number } | undefined;
  /**
   * Generator 3: the level's water surface in tiles above the level floor (the scale of `height`; resolve/level/waterSurface.ts
   * waterSurface() minus the floor thickness). Optional: without it water dressing estimates it from the beds and banks
   * of the area it dresses (half a tile below the lowest bank, a quarter above the highest bed).
   */
  waterSurface?(): number | undefined;
  /**
   * Generator 3: true on cells off the board: void cells (a natural outline's cut-away corners) and everything outside
   * the level bounds. The board's edge is a cliff where the ground stands above the base: the band skirts it with rock
   * standing on the base plane. Optional.
   */
  void?(x: number, y: number): boolean;
  /**
   * Generator 4, room recipes (gen/rooms4): the real size in tiles of the smallest variant of the piece a feature
   * type (and variant name) resolves to when anchored on cell (x, y), in the theme it is built in; undefined where
   * that theme has no such piece (the recipe leaves that item out). Absent: no room recipe runs.
   */
  piece4?(
    type: FeatureType,
    x: number,
    y: number,
    variant?: string,
  ):
    | {
        w: number;
        d: number;
        h: number;
        wMax: number;
        dMax: number;
        hMax: number;
        tile: boolean;
        mixed: boolean;
      }
    | undefined;
  /** Generator 4: does this cell host the wall strip on its `side` (a piece mounted there stands half a cell in)? */
  wallHosted?(x: number, y: number, side: Side): boolean;
  /**
   * Generator 4: does a wall piece stand on the cell's `side`? False on a wall edge nothing is built on: a rock wall
   * (a full-cell piece, built in the cell past the edge) on the board's edge when the board edge is an exit.
   */
  wallBuilt?(x: number, y: number, side: Side): boolean;
  /** Generator 4: height in tiles of the wall on the cell's `side` (0 where there is none). */
  wallHeight?(x: number, y: number, side: Side): number;
  /** Generator 4: wall style of the wall on the cell's `side` (natural rock takes no shelf). */
  wallStyle?(x: number, y: number, side: Side): string | undefined;
  /**
   * Generator 4: clear height in tiles above the cell's floor top, up to the floor of the lowest level stacked above
   * (plan/levels.ts `levelCeiling`); Infinity with none. Nothing a placer stands there may rise higher (verify's
   * `verify_pokes_into_level_above`).
   */
  headroom?(x: number, y: number): number;
  /** Generator 4: cells of the lights already on the level (wall torches, candles, braziers, lanterns), plan or generated. */
  lightCells?(): ReadonlyArray<readonly [number, number]>;
  /**
   * Generator 4: what the level's rooms have been given so far, by purpose (the recipe variants used), so rooms of one
   * purpose draw different variants. Created per level by the resolver.
   */
  roomMemory?: Map<string, number[]>;
  /**
   * Generator 5 (`companionGroups`): is there a window (an opening that is no way through, gen/openingKinds.ts) in the
   * wall on the cell's side? A room furnisher seats a desk at it and keeps tall pieces off it. Optional.
   */
  windowOn?(x: number, y: number, side: Side): boolean;
}

/** What the grid's generator does (plan/generator.ts); a grid that names no generator is generator 2. */
export function gridProfile(grid: Pick<PlacementGrid, "generator">): GeneratorProfile {
  return generatorProfile(grid.generator ?? 2);
}

export interface GeneratedPlacement {
  type: FeatureType;
  at: [number, number];
  size: [number, number];
  rot: Rotation;
  rotFine: number;
  /** Generator 3: sub-cell shift in tiles [east, south], each within ±0.5 (carried to the resolved feature). */
  offset?: [number, number];
  wall?: Side;
  variant?: string;
  /**
   * Tiles above (or, negative, below) the floor of the anchor cell: a course of a rock band stacked on the one
   * below, or a base course sunk into the ground. The resolver adds it to the feature's base height.
   */
  lift?: number;
}

/** What a placer returns: its placements in generation order, and whether a cap stopped it early. */
export interface ScatterResult {
  placements: GeneratedPlacement[];
  capped: boolean;
  /** Generator 5, a furnished room: the cells it kept clear of blockers (standing room, the way in, door landings). */
  keptClear?: Array<[number, number]>;
}

/** True when a wall (WALL edge) separates two cells of the footprint. */
export function footprintCrossesWall(
  grid: Pick<PlacementGrid, "edge">,
  at: readonly [number, number],
  size: readonly [number, number],
): boolean {
  for (let y = at[1]; y < at[1] + size[1]; y++) {
    for (let x = at[0]; x < at[0] + size[0]; x++) {
      if (x + 1 < at[0] + size[0] && grid.edge(x, y, "E") === EDGE_WALL) return true;
      if (y + 1 < at[1] + size[1] && grid.edge(x, y, "S") === EDGE_WALL) return true;
    }
  }
  return false;
}
