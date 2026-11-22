/**
 * Cliffs as rock bands, the way hand-built TaleSpire cliffs are made (a built face reads as a wall, so a natural
 * rise is dressed in overlapping rock instead). A natural rise of 2 tiles or more
 * is faced by courses of long low face rocks (`cliff_face` → palette role cliff.formation_face) that rest on the
 * low ground and step back as they climb, finished by crest boulders (`cliff_crest` → cliff.formation_crest) standing
 * on the upper ground at the lip so the edge never shows. Pieces lie along the edge, overlap their neighbours, turn
 * up to 30° either way in 15° steps (and either end first) and are spaced irregularly; run ends fade into a few
 * loose boulders; routes (paths, stairs, links) keep their gap; a rock ramp's sides are lined from the upper ground.
 * Rises of 1–1.5 tiles get a broken single row of crest boulders only. Growth that follows the rock is the composer's (setpieces.ts).
 *
 * Every piece is supported: the base course and the crest boulders stand on the ground at their centre (nothing is
 * sunk, nothing floats), and an upper course stands on the top of the rock beneath its centre (`lift`).
 *
 * Theme-neutral and palette-agnostic: piece sizes come from `PlacementGrid.pieceSize` when the resolver provides it
 * (from the palette's assets), else nominal sizes (the live Cliff Face and Boulder - Large props). A theme without the
 * formation roles realizes nothing here, and its cliff keeps the built face (the realizer decides that).
 */
import type { Rotation, Side } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { edgeHidden, terraceRockShare, type RockShape } from "./cover";
import {
  EDGE_LEDGE,
  EDGE_STAIR,
  FLAG_LINK,
  FLAG_PATH,
  FLAG_WATER,
  OPPOSITE,
  SIDES,
  SIDE_STEP as STEP,
  cellKey as key,
} from "./gridGeometry";
import { gridProfile, type GeneratedPlacement, type PlacementGrid } from "./placementGrid";
import { maxOf } from "../util/lists";

type Piece = "cliff_face" | "cliff_crest";
interface Size {
  w: number;
  d: number;
  h: number;
}

/** Nominal piece sizes (tiles) when the resolver gives none: the live Cliff Face and Boulder - Large props. */
const NOMINAL: Record<Piece, Size> = {
  cliff_face: { w: 4.6, d: 3, h: 2.3 },
  cliff_crest: { w: 1.8, d: 1.5, h: 1.6 },
};

/** Band tuning, data rather than code. */
const BAND = {
  /** Rise (tiles) from which a cliff gets face courses; below it, crest boulders only. */
  faceFrom: 2,
  /** The top of the rise (tiles) the crest boulders finish, so the courses need not reach it. */
  crestShare: 0.5,
  /** Centre spacing of face rocks, as a share of their length (neighbours overlap by about a third to a half). */
  faceGap: [0.3, 0.66],
  /** Spacing of the fill pass (a share of the length): closes any gap of four cells or more. */
  faceFill: 0.41,
  /** Centre spacing of crest boulders, as a share of their width. */
  crestGap: [0.7, 1.1],
  /** Generator 3: boulders along a lip stand every 1.5-3 cells (the reference), not shoulder to shoulder. */
  crestGap3: [1.0, 1.8],
  /** Step back per course (cells), toward the upper ground. */
  stepBack: [1.0, 1.3],
  /** Share of a low rise's edge that gets crest boulders. */
  lowCrest: 0.8,
  /** Generator 3: the low rises are faced by the low course, so the lip crest is only a broken accent. */
  lowCrest3: 0.4,
  /** Generator 3 low course: centre spacing as a share of the boulder's width, and its fill pass. */
  lowGap: [0.7, 0.95],
  lowFill: 0.7,
  /** Share of crest boulders set a cell further back from the lip. */
  crestBack: 0.15,
  /** Turn either way of the edge, in 15° steps. */
  maxTurnSteps: 2,
  /** Generator 3: most of a terrace's walkable ground the rock may stand on (boulders are pruned beyond it). */
  terraceShare: 0.3,
  /** Share of a face rock's bounding box an upper course may stand on. */
  standOn: 0.6,
} as const;

/** Generator 3 sub-cell slide in tiles: [along the edge, toward the cliff] (either way). */
const SLIDE = { face: [0.45, 0.3], crest: [0.35, 0.3] } as const;

/** Generator 3 crest clusters (cells): boulders are accents in groups, not a fence along the lip. */
const CLUSTER = {
  /** Distance between cluster seeds. */
  apart: [15, 22],
  /** Members stand within this distance of the seed's edge unit. */
  reach: 3.2,
  /** No two boulders of a cluster closer than this (they overlap a little, they do not stack). */
  touch: 0.95,
  /** Share of tall lips that is hidden by face rock already and still gets a cluster. */
  hiddenSeed: 0.25,
  /** Share of low-rise lips that seeds a cluster (the low course faces those banks). */
  lowSeed: 0.35,
  /** Shares of clusters that are five boulders or a single one (otherwise two to four). */
  five: 0.05,
  one: 0.1,
} as const;

/** Where a refused piece is tried next (generator 3): [cells along the edge, cells further from the lip/foot]. */
const NUDGE: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [-1, 1],
  [0, -1],
];

/** One cell edge across which the ground rises: the low cell, the side toward the high cell, the heights. */
export interface RiseUnit {
  /** The low cell (rocks stand on it). */
  low: [number, number];
  /** Side of the low cell the rise is on (toward the upper ground). */
  side: Side;
  lo: number;
  hi: number;
  /** The low cell is off the board (void or outside it): a board-edge drop, skirted by rock standing on the base plane. */
  perim?: boolean;
}

export interface BandParams {
  /** Cells the band may be planned for (the upper cells of the rise must be among them). */
  areaCells: ReadonlyArray<[number, number]>;
  seed: number;
  /** Smallest rise (tiles) to face; default 1 (rises of 1–1.5 get crest boulders only). */
  minRise?: number;
  /** Cells not to touch (door zones, keep-clear, anything already taken by the caller). */
  avoid?: (x: number, y: number) => boolean;
  /**
   * The caller's last word on a piece that would block these cells for walking (its reachability guard); false
   * leaves it out, and the band tries the next way to cover that edge. Called once per piece, last.
   */
  accept?: (cells: ReadonlyArray<[number, number]>) => boolean;
}

/**
 * Generator 3 rules (`restingCliffBand`, plan/generator.ts): every piece rests on the ground or on rock under most of its
 * footprint, and its anchor corner is held up too (nothing hangs over a lower terrace or a stream).
 */
export const SUPPORT = {
  /** Largest share of a piece's footprint that may stand over air (cells more than half a tile below its base). */
  maxOver: 0.34,
} as const;

export interface BandResult {
  placements: Array<GeneratedPlacement & { lift: number }>;
  /** Edge units with rise ≥ 1 and how many of them the band clads (a piece's footprint covers either cell). */
  units: number;
  clad: number;
  /** Cells under the band's pieces (other dressing keeps off them). */
  cells: Array<[number, number]>;
  /** Rise units the band faces (for growth that follows the rock). */
  rises: RiseUnit[];
  /**
   * Cells each placement blocks for walking (parallel to `placements`), for the caller's reachability guard: the
   * cells under it at about its base height.
   */
  footprints: Array<Array<[number, number]>>;
  /** Per placement, the index of the placement it stands on (-1: the ground); drop it if that one is dropped. */
  restsOn: number[];
}

/** Every rise unit of the area: the upper cell is in the area, the low neighbour is floor 1 tile or more below. */
export function riseUnits(
  grid: PlacementGrid,
  cells: ReadonlyArray<[number, number]>,
  minRise = 1,
  perimeter = false,
): RiseUnit[] {
  const out: RiseUnit[] = [];
  const h = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  for (const [x, y] of cells) {
    if (!grid.isFloor(x, y)) continue;
    for (const s of SIDES) {
      const [dx, dy] = STEP[s];
      const lx = x + dx;
      const ly = y + dy;
      // the board's own edge: the neighbour is void or off the board and the ground stands above the base
      if (perimeter && grid.void?.(lx, ly) === true) {
        // the skirt stays inside the board's bounds (a piece beyond them would meet the neighbouring slab when
        // tiled): an edge whose foot lies off the board gets none
        if (h(x, y) >= minRise && grid.inBounds(lx, ly)) {
          const back = OPPOSITE[s];
          out.push({ low: [lx, ly], side: back, lo: 0, hi: h(x, y), perim: true });
        }
        continue;
      }
      if (grid.edge(x, y, s) !== EDGE_LEDGE) continue;
      if (!grid.inBounds(lx, ly) || !grid.isFloor(lx, ly)) continue;
      const rise = h(x, y) - h(lx, ly);
      if (rise < minRise) continue;
      const back = OPPOSITE[s];
      out.push({ low: [lx, ly], side: back, lo: h(lx, ly), hi: h(x, y) });
    }
  }
  return out;
}

/**
 * Builds the rock band for every rise in the area. The steps run in draw order (one stream, "cliffband"); each reads
 * and adds to the band (`Band`: the pieces placed so far, the rock tops they leave, the shapes that hide the face),
 * the one record that lives across the steps on purpose, as every piece stands on or beside the ones before it.
 */
export function cliffBand(grid: PlacementGrid, p: BandParams): BandResult {
  const band = startBand(grid, p);
  // a theme without the formation roles (the resolver says so through pieceSize) gets no band: its cliff keeps the
  // built face, and the composer's growth along the rises still follows the edge
  if (!band.hasPieces)
    return {
      placements: [],
      units: band.units.length,
      clad: 0,
      cells: [],
      rises: band.units,
      footprints: [],
      restsOn: [],
    };
  // edges in reading order: a straight run comes in sequence; corners and ragged steps are sorted out by distance
  const order = [...band.units].sort((a, b) => a.low[1] - b.low[1] || a.low[0] - b.low[0]);
  placeFaceCourses(band, order);
  placeLowCourse(band, order);
  placeCrestClusters(band, order);
  placeLipCrests(band, order);
  const plugCrests = plugGaps(band, order);
  dropRedundantPlugs(band, plugCrests);
  fadeRunEnds(band);
  unburyTerraces(band);
  return bandResult(band);
}

/** The band's stream, measures and cell tests, and the record of the pieces placed so far (placePiece adds one). */
function bandBase(grid: PlacementGrid, p: BandParams) {
  const rng = createPrng(subSeed(p.seed, "cliffband"));
  const between = (r: readonly [number, number]): number => r[0] + rng.next() * (r[1] - r[0]);
  const h = (x: number, y: number): number => grid.height?.(x, y) ?? 0;
  const gen = gridProfile(grid);
  // the band is one area's rock: its pieces are asked of the area's theme (its first cell anchors the question)
  const [ax, ay] = p.areaCells[0] ?? [0, 0];
  // the band plans with the asset's real outline (pieceExtent) where the generator knows it, else its footprint in cells
  const size = (t: Piece): Size =>
    gen.realPieceOutlines
      ? (grid.pieceExtent?.(t, ax, ay) ?? grid.pieceSize?.(t, ax, ay) ?? NOMINAL[t])
      : (grid.pieceSize?.(t, ax, ay) ?? NOMINAL[t]);
  // pieces rest on the ground or on rock, turn and slide, skirt the board's edge (PlacementGrid.generator, SUPPORT)
  const resting = gen.restingCliffBand;
  const units = riseUnits(grid, p.areaCells, p.minRise, resting);
  const hasPieces = !(
    grid.pieceSize &&
    grid.pieceSize("cliff_face", ax, ay) === undefined &&
    grid.pieceSize("cliff_crest", ax, ay) === undefined
  );
  const out: Array<GeneratedPlacement & { lift: number }> = [];
  const footprints: Array<Array<[number, number]>> = [];
  const pieceCells = new Set<number>();
  /** The top (absolute tiles) of the rock a piece could stand on, per cell (the inner part of each face rock). */
  const rockTop = new Map<number, number>();
  /** Which placement that top belongs to. */
  const rockOf = new Map<number, number>();
  /** Per placement: the index of the placement it stands on (-1: the ground). */
  const restsOn: number[] = [];
  /** Every piece as it stands, for the "does it hide the face" test. */
  const shapes: RockShape[] = [];
  /** Generator 3: per cell of any piece's footprint, the [base, top] (absolute tiles) of each piece over it. */
  const rockUnder = new Map<number, Array<[number, number]>>();
  /** Cells no part of a piece may cover: links (steps, bridges), paths, and what the caller keeps clear. */
  // (generator 3: never beyond the board's bounds: a piece out there would meet the neighbouring slab when tiled)
  const isVoid = (x: number, y: number): boolean =>
    resting && grid.void?.(x, y) === true && grid.inBounds(x, y);
  /** Where a piece may stand (its centre) or reach: the floor, or (generator 3) the void beside the board's edge. */
  const standable = (x: number, y: number): boolean =>
    (grid.inBounds(x, y) && grid.isFloor(x, y)) || isVoid(x, y);
  const blockedFor = (x: number, y: number): boolean => {
    if (!grid.inBounds(x, y)) return !isVoid(x, y);
    if ((grid.flags(x, y) & (FLAG_LINK | FLAG_PATH)) !== 0) return true;
    return p.avoid?.(x, y) === true;
  };
  /** Cells a piece may not stand on: water (it may overhang a stream from the bank). */
  const noStand = (x: number, y: number): boolean => (grid.flags(x, y) & FLAG_WATER) !== 0;
  /** A rock ramp's cell: no piece covers it (the band lines its sides from beside it). */
  const isRamp = (x: number, y: number): boolean => grid.ramp?.(x, y) === true;
  /**
   * A route crosses here and keeps its gap in the band: a flight of steps, a link, or a path on both sides of the
   * edge (a path running along the lip or the foot is no crossing: the band lines it).
   */
  const route = (u: RiseUnit): boolean => {
    const [dx, dy] = STEP[u.side];
    if (grid.edge(u.low[0], u.low[1], u.side) === EDGE_STAIR) return true;
    const f0 = grid.flags(u.low[0], u.low[1]);
    const f1 = grid.flags(u.low[0] + dx, u.low[1] + dy);
    if (((f0 | f1) & FLAG_LINK) !== 0) return true;
    return (f0 & f1 & FLAG_PATH) !== 0;
  };
  /** Cells within a box of half-extents (hw, hd) round a cell centre. */
  const cellsRound = (ax: number, ay: number, hw: number, hd: number): Array<[number, number]> => {
    const cs: Array<[number, number]> = [];
    const cx = ax + 0.5;
    const cy = ay + 0.5;
    const x0 = Math.min(ax, Math.floor(cx - hw + 0.25));
    const x1 = Math.max(ax, Math.ceil(cx + hw - 0.25) - 1);
    const y0 = Math.min(ay, Math.floor(cy - hd + 0.25));
    const y1 = Math.max(ay, Math.ceil(cy + hd - 0.25) - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cs.push([x, y]);
    return cs;
  };
  return {
    grid,
    p,
    rng,
    between,
    h,
    resting,
    units,
    hasPieces,
    size,
    out,
    footprints,
    pieceCells,
    rockTop,
    rockOf,
    restsOn,
    shapes,
    rockUnder,
    isVoid,
    standable,
    blockedFor,
    noStand,
    isRamp,
    route,
    cellsRound,
  };
}

type BandBase = ReturnType<typeof bandBase>;

/**
 * Places one piece with its centre in cell (ax, ay), lying along the edge of `side`; `base` is "ground" (stands on the
 * floor of that cell) or "rock" (stands on the rock beneath it). False when it cannot stand there.
 */
function placePiece(
  band: BandBase,
  t: Piece,
  ax: number,
  ay: number,
  side: Side,
  base: "ground" | "rock",
  strict = false,
): boolean {
  const { standable, rng, resting } = band;
  if (!standable(ax, ay)) return false;
  // generator 3: a turn that meets a path, a ramp or the board's bounds is replaced by another before the piece is
  // given up, so a rock reaches right up to a gap instead of leaving the whole edge beside it bare
  const first = rng.int(BAND.maxTurnSteps * 2 + 1) - BAND.maxTurnSteps;
  const flip = rng.chance(0.5) ? 180 : 0;
  const turns = resting ? [first, ...[0, 2, -2, 1, -1].filter((q) => q !== first).slice(0, 3)] : [first];
  for (const q of turns) if (placeTurned(band, t, ax, ay, side, base, strict, q * 15 + flip)) return true;
  return false;
}

/** placePiece at one turn (degrees): the piece is added when it fits there. */
function placeTurned(
  band: BandBase,
  t: Piece,
  ax: number,
  ay: number,
  side: Side,
  base: "ground" | "rock",
  strict: boolean,
  turn: number,
): boolean {
  const fit = fitTurned(band, t, ax, ay, side, base, turn);
  if (!fit) return false;
  addPiece(band, t, ax, ay, side, strict, fit);
  return true;
}

/** Where a piece that fits stands: its size, turn, footprint (and the part it blocks for walking), lift and support. */
interface PieceFit {
  readonly s: Size;
  readonly rotFine: number;
  readonly bw: number;
  readonly bd: number;
  readonly kx: number;
  readonly ky: number;
  readonly fp: Array<[number, number]>;
  readonly ground: number;
  readonly lift: number;
  readonly foot: number;
  readonly inside: Array<[number, number]>;
  readonly under: number;
}

/**
 * Does the piece fit at this turn: its footprint clear of routes, ramps and the board's bounds, standing on the ground
 * or the rock under it, held up (generator 3), not a duplicate, and accepted by the caller? Draws nothing.
 */
function fitTurned(
  band: BandBase,
  t: Piece,
  ax: number,
  ay: number,
  side: Side,
  base: "ground" | "rock",
  turn: number,
): PieceFit | null {
  const { grid, p, h, resting, size, rockTop, rockOf, shapes, rockUnder } = band;
  const { isVoid, standable, blockedFor, noStand, isRamp } = band;
  if (!standable(ax, ay)) return null;
  const s = size(t);
  const along = side === "N" || side === "S" ? 0 : 90;
  const rotFine = (along + turn + 360) % 360;
  const rad = (rotFine * Math.PI) / 180;
  const bw = Math.abs(s.w * Math.cos(rad)) + Math.abs(s.d * Math.sin(rad));
  const bd = Math.abs(s.w * Math.sin(rad)) + Math.abs(s.d * Math.cos(rad));
  // its footprint: the odd box of cells centred on its cell that its turned outline fills (5×3 for a 4.6×3 face
  // rock along the edge, 1×1 for a crest boulder); emitted as the feature's at/size, so the realizer centres the
  // asset on (ax, ay) and the review and verify measure the rock where it stands
  const kx = Math.max(0, Math.round(bw / 2 - 0.5));
  const ky = Math.max(0, Math.round(bd / 2 - 0.5));
  const fp: Array<[number, number]> = [];
  for (let y = ay - ky; y <= ay + ky; y++) for (let x = ax - kx; x <= ax + kx; x++) fp.push([x, y]);
  const off = (x: number, y: number): boolean => blockedFor(x, y) || isRamp(x, y);
  // generator 3: only the cells the turned outline really covers keep a piece off a path or a ramp (its bounding
  // box of cells is larger, and left a bare run as wide as the box beside every route)
  const touches = (x: number, y: number): boolean => {
    if (!resting) return true;
    const cs = Math.cos(rad);
    const sn = Math.sin(rad);
    for (const [qx, qy] of [
      [0.5, 0.5],
      [0.2, 0.2],
      [0.8, 0.2],
      [0.2, 0.8],
      [0.8, 0.8],
    ] as const) {
      const u = (x + qx - (ax + 0.5)) * cs + (y + qy - (ay + 0.5)) * sn;
      const v = -(x + qx - (ax + 0.5)) * sn + (y + qy - (ay + 0.5)) * cs;
      if (Math.abs(u) <= s.w / 2 + 0.2 && Math.abs(v) <= s.d / 2 + 0.2) return true;
    }
    return false;
  };
  if (fp.some(([x, y]) => !(grid.inBounds(x, y) || isVoid(x, y)) || (touches(x, y) && off(x, y))))
    return null;
  // generator 3: every piece lies inside the board's bounds (its turned outline; the skirt, `strict`, also takes no slide)
  if (resting) {
    const hw = bw / 2;
    const hd = bd / 2;
    for (const [ex, ey] of [
      [-hw, -hd],
      [hw, -hd],
      [-hw, hd],
      [hw, hd],
    ] as const)
      if (!grid.inBounds(Math.floor(ax + 0.5 + ex), Math.floor(ay + 0.5 + ey))) return null;
  }
  const ground = h(ax, ay);
  if (noStand(ax, ay)) return null;
  let b = ground;
  if (base === "rock") {
    const top = rockTop.get(key(ax, ay));
    if (top === undefined || top <= ground + 0.5) return null;
    b = top;
  }
  const under = base === "rock" ? (rockOf.get(key(ax, ay)) ?? -1) : -1;
  // a lift in quarter tiles, never below the top it stands on (so the rock beneath carries it)
  const lift = Math.ceil((b - ground) * 4 - 1e-6) / 4;
  // the cells it blocks for walking: where it stands on the floor (an overhang high above the low ground, or the
  // hill rising above a face rock leaning on it, stays walkable)
  const foot = ground + lift;
  const inside = fp.filter(
    ([x, y]) => grid.inBounds(x, y) && !isRamp(x, y) && h(x, y) >= foot - 0.5 && h(x, y) < foot + s.h,
  );
  if (inside.some(([x, y]) => noStand(x, y))) return null;
  // generator 3: stand on the ground or on rock under most of the footprint, anchor corner included
  const held = (x: number, y: number): boolean =>
    ((grid.isFloor(x, y) || isVoid(x, y)) && h(x, y) >= foot - 0.5) ||
    (rockUnder.get(key(x, y)) ?? []).some(([b0, top]) => b0 <= foot - 0.1 && top >= foot - 0.1);
  if (resting) {
    const [cx0, cy0] = fp[0] as [number, number];
    if (!held(cx0, cy0)) return null;
    if (fp.filter(([x, y]) => !held(x, y)).length > SUPPORT.maxOver * fp.length) return null;
  }
  // generator 3: never a second piece of the same kind on the same spot at the same height (a pile hides nothing more)
  if (
    resting &&
    shapes.some(
      (q) =>
        Math.abs(q.cx - (ax + 0.5)) < 0.8 &&
        Math.abs(q.cy - (ay + 0.5)) < 0.8 &&
        Math.abs(q.base - foot) < 0.3 &&
        Math.abs(q.w - s.w) < 0.01,
    )
  )
    return null;
  if (p.accept && !p.accept(inside)) return null;
  return { s, rotFine, bw, bd, kx, ky, fp, ground, lift, foot, inside, under };
}

/**
 * Adds a piece that fits: the rock it leaves for others to stand on and under, its cells, and (generator 3, not the
 * skirt) a slide along and into the edge drawn from the band's stream.
 */
function addPiece(
  band: BandBase,
  t: Piece,
  ax: number,
  ay: number,
  side: Side,
  strict: boolean,
  fit: PieceFit,
): void {
  const {
    rng,
    h,
    resting,
    out,
    footprints,
    pieceCells,
    rockTop,
    rockOf,
    restsOn,
    shapes,
    rockUnder,
    cellsRound,
  } = band;
  const { s, rotFine, bw, bd, kx, ky, fp, ground, lift, foot, inside, under } = fit;
  if (resting)
    for (const [x, y] of fp) {
      const k = key(x, y);
      const list = rockUnder.get(k);
      if (list) list.push([foot, foot + s.h]);
      else rockUnder.set(k, [[foot, foot + s.h]]);
    }
  for (const [x, y] of fp) pieceCells.add(key(x, y));
  if (t === "cliff_face")
    for (const [x, y] of cellsRound(ax, ay, (bw * BAND.standOn) / 2, (bd * BAND.standOn) / 2)) {
      const k = key(x, y);
      const top = ground + lift + s.h;
      if (top > (rockTop.get(k) ?? -Infinity)) {
        rockTop.set(k, top);
        rockOf.set(k, out.length);
      }
    }
  const rot = ((Math.round(rotFine / 90) % 4) * 90) as Rotation;
  // the lift is measured from the floor of the footprint's first cell (where the feature is anchored)
  const corner = h(ax - kx, ay - ky);
  // generator 3: slide along the edge and a little into it, so neighbours overlap unevenly instead of on a grid
  // (the footprint cells, and so the support test above, stay those of the cell centre)
  let offset: [number, number] | undefined;
  if (resting && !strict) {
    const slide = t === "cliff_face" ? SLIDE.face : SLIDE.crest;
    const along = (rng.next() * 2 - 1) * slide[0];
    // mostly toward the cliff, never far off it: the rock must still stand over the edge it hides
    // (a face rock is slid up to the foot of its riser, so it reaches no more than about a tile and a half out)
    const into = t === "cliff_face" ? 0.3 + rng.next() * 0.2 : (rng.next() * 0.45 - 0.15) * (slide[1] / 0.3);
    const [sx, sy] = STEP[side];
    const ns = side === "N" || side === "S";
    offset = [(ns ? along : 0) + sx * into, (ns ? 0 : along) + sy * into];
  }
  shapes.push({
    cx: ax + 0.5 + (offset?.[0] ?? 0),
    cy: ay + 0.5 + (offset?.[1] ?? 0),
    rot: rotFine,
    w: s.w,
    d: s.d,
    base: foot,
    top: foot + s.h,
  });
  out.push({
    type: t,
    at: [ax - kx, ay - ky],
    size: [2 * kx + 1, 2 * ky + 1],
    rot,
    rotFine,
    ...(offset ? { offset } : {}),
    lift: ground + lift - corner,
  });
  footprints.push(inside);
  restsOn.push(under);
}

/** The band's record and helpers, with the pieces' spacing and course measures added. */
function startBand(grid: PlacementGrid, p: BandParams) {
  const band = bandBase(grid, p);
  const { size, resting, shapes } = band;
  const place = (
    t: Piece,
    ax: number,
    ay: number,
    side: Side,
    base: "ground" | "rock",
    strict = false,
  ): boolean => placePiece(band, t, ax, ay, side, base, strict);
  /** Centres placed so far (cell centres), per course of face rock and for the crest. */
  const faceAt: Array<Array<[number, number]>> = [];
  const crestAt: Array<[number, number]> = [];
  const near = (list: ReadonlyArray<[number, number]>, x: number, y: number, r: number): boolean =>
    list.some(([a, b]) => (a - x) * (a - x) + (b - y) * (b - y) < r * r);
  /** The cell `out` cells out from the edge of unit u (negative: back over the upper ground), jittered along it. */
  const cellOut = (u: RiseUnit, outward: number, jitter: number): [number, number] => {
    const [dx, dy] = STEP[u.side];
    const ns = u.side === "N" || u.side === "S";
    const ex = u.low[0] + 0.5 + dx * 0.5 - dx * outward + (ns ? jitter : 0);
    const ey = u.low[1] + 0.5 + dy * 0.5 - dy * outward + (ns ? 0 : jitter);
    return [Math.floor(ex), Math.floor(ey)];
  };
  const face = size("cliff_face");
  const crest = size("cliff_crest");
  // the board-edge skirt is one simple course, whatever the drop (and nothing else: no crest, no second course)
  // (generator 3: a face piece is never taller than its riser, the crest share aside: a 1-tile board edge keeps its
  // plain face and the boulders instead of a 2.3-tile shelf)
  const coursesOf = (u: RiseUnit): number =>
    u.perim === true
      ? !resting || u.hi - u.lo + BAND.crestShare >= face.h
        ? 1
        : 0
      : u.hi - u.lo < BAND.faceFrom
        ? 0
        : Math.max(1, Math.ceil((u.hi - u.lo - BAND.crestShare) / face.h));
  const unitMid = (u: RiseUnit): [number, number] => [
    u.low[0] + 0.5 + STEP[u.side][0] * 0.5,
    u.low[1] + 0.5 + STEP[u.side][1] * 0.5,
  ];
  const hidden = (u: RiseUnit): boolean => {
    const [mx, my] = unitMid(u);
    const ns = u.side === "N" || u.side === "S";
    return edgeHidden(shapes, mx, my, ns ? 1 : 0, ns ? 0 : 1, u.lo, u.hi);
  };
  return {
    ...band,
    face,
    crest,
    faceAt,
    crestAt,
    place,
    near,
    cellOut,
    coursesOf,
    unitMid,
    hidden,
  };
}

type Band = ReturnType<typeof startBand>;

/** Face courses: the base course on the low ground, each course above a step back toward the cliff, on the rock. */
function placeFaceCourses(band: Band, order: readonly RiseUnit[]): void {
  const { units, coursesOf, faceAt, route, between, rng, resting, cellOut, face, near, h, place } = band;
  const maxCourses = Math.max(0, maxOf(units.map(coursesOf)));
  for (let c = 0; c < maxCourses; c++) {
    const mine: Array<[number, number]> = [];
    faceAt.push(mine);
    // a seeded spacing pass, then a fill pass that closes any gap wider than the overlap allows (where the edge
    // steps, the two lines of rock meet out of order)
    for (const gap of [null, BAND.faceFill] as const)
      for (const u of order) {
        const n = coursesOf(u);
        if (c >= n || route(u)) continue;
        // the base course reaches further out the more courses stand on it, so every course rests on rock
        // generator 3: a single course stands on the first cell of the low ground, so it reaches about a tile and a half
        // out from the foot (the deep Cliff Face piece, slid to the foot below), not three
        const outward =
          0.5 + (n - 1 - c) * between(BAND.stepBack) + rng.next() * (resting && n === 1 ? 0.45 : 0.6);
        const jit = (rng.next() - 0.5) * 0.9;
        const [ax, ay] = cellOut(u, outward, jit);
        const spacing = face.w * (gap ?? between(BAND.faceGap));
        if (near(mine, ax + 0.5, ay + 0.5, spacing)) continue;
        // the base course stands on the low ground (never on the upper cell, where it would sink into the hill)
        if (h(ax, ay) > u.lo + 0.25) continue;
        if (place("cliff_face", ax, ay, u.side, c === 0 ? "ground" : "rock", u.perim === true)) {
          mine.push([ax + 0.5, ay + 0.5]);
          continue;
        }
        // generator 3: a piece with nothing under it moves a cell along or in, or is dropped
        if (resting)
          for (const [da, dout] of NUDGE) {
            const [bx, by] = cellOut(u, outward + dout, jit + da);
            if (near(mine, bx + 0.5, by + 0.5, spacing) || h(bx, by) > u.lo + 0.25) continue;
            if (place("cliff_face", bx, by, u.side, c === 0 ? "ground" : "rock", u.perim === true)) {
              mine.push([bx + 0.5, by + 0.5]);
              break;
            }
          }
      }
  }
}

/**
 * Generator 3, low rises (1 to under 2 tiles): boulders standing on the low ground against the face, closely spaced,
 * so the face is hidden up to the lip; a fill pass closes the gaps.
 */
function placeLowCourse(band: Band, order: readonly RiseUnit[]): void {
  const { resting, route, noStand, rng, cellOut, crest, between, near, h, place } = band;
  if (resting) {
    const lowAt: Array<[number, number]> = [];
    for (const gap of [null, BAND.lowFill] as const)
      for (const u of order) {
        if (u.perim || u.hi - u.lo >= BAND.faceFrom || route(u) || noStand(u.low[0], u.low[1])) continue;
        const outward = 0.3 + rng.next() * 0.5;
        const jit = (rng.next() - 0.5) * 0.9;
        const [ax, ay] = cellOut(u, outward, jit);
        const spacing = crest.w * (gap ?? between(BAND.lowGap));
        if (near(lowAt, ax + 0.5, ay + 0.5, spacing) || h(ax, ay) > u.lo + 0.25) continue;
        if (place("cliff_crest", ax, ay, u.side, "ground")) {
          lowAt.push([ax + 0.5, ay + 0.5]);
          continue;
        }
        for (const [da, dout] of NUDGE) {
          const [bx, by] = cellOut(u, outward + Math.max(0, dout), jit + da);
          if (near(lowAt, bx + 0.5, by + 0.5, spacing) || h(bx, by) > u.lo + 0.25) continue;
          if (place("cliff_crest", bx, by, u.side, "ground")) {
            lowAt.push([bx + 0.5, by + 0.5]);
            break;
          }
        }
      }
  }
}

/**
 * Generator 3 crest boulders: accents in clusters of two to five (rarely one) with clear gaps between the clusters and
 * no boulder at all along a lip the face rock already hides. Cluster seeds are drawn in random order and kept
 * CLUSTER.apart cells from each other; a cluster's members stand on the neighbouring lip cells (a cell or so apart,
 * some a cell further back), so the group overlaps and staggers instead of marching.
 */
function placeCrestClusters(band: Band, order: readonly RiseUnit[]): void {
  const { resting, route, rng, cellOut, hidden, near, between, h, place, crestAt, unitMid } = band;
  if (resting) {
    const lip = order.filter((u) => !u.perim && !route(u));
    const seeds: Array<[number, number]> = [];
    const lipCell = (u: RiseUnit): [number, number] => {
      const back = rng.chance(BAND.crestBack * 2) ? 1.5 : 0.5;
      return cellOut(u, -back, (rng.next() - 0.5) * 0.8);
    };
    for (const u of rng.shuffle(lip)) {
      const low = u.hi - u.lo < BAND.faceFrom;
      if (low ? !rng.chance(CLUSTER.lowSeed) : hidden(u) && !rng.chance(CLUSTER.hiddenSeed)) continue;
      const [sx, sy] = lipCell(u);
      if (near(seeds, sx + 0.5, sy + 0.5, between(CLUSTER.apart))) continue;
      if (h(sx, sy) < u.hi - 0.25) continue;
      const want = rng.chance(CLUSTER.five) ? 5 : rng.chance(CLUSTER.one) ? 1 : 2 + rng.int(3);
      let got = 0;
      const mine: Array<[number, number]> = [];
      const tryAt = (ax: number, ay: number, v: RiseUnit): boolean => {
        if (h(ax, ay) < v.hi - 0.25 || near(mine, ax + 0.5, ay + 0.5, CLUSTER.touch)) return false;
        if (!place("cliff_crest", ax, ay, v.side, "ground")) return false;
        mine.push([ax + 0.5, ay + 0.5]);
        crestAt.push([ax + 0.5, ay + 0.5]);
        got++;
        return true;
      };
      if (!tryAt(sx, sy, u))
        for (const [da, dback] of NUDGE) {
          const [bx, by] = cellOut(u, -0.5 - dback, da);
          if (tryAt(bx, by, u)) break;
        }
      if (got === 0) continue;
      const members = rng.shuffle(
        lip.filter((v) => {
          const [vx, vy] = unitMid(v);
          const [ux, uy] = unitMid(u);
          return v !== u && Math.hypot(vx - ux, vy - uy) <= CLUSTER.reach;
        }),
      );
      for (const v of members) {
        if (got >= want) break;
        const [ax, ay] = lipCell(v);
        tryAt(ax, ay, v);
      }
      seeds.push([sx + 0.5, sy + 0.5]);
    }
  }
}

/** Generator 2 (frozen) crest boulders on the upper ground at the lip, every rise; on low rises a broken single row. */
function placeLipCrests(band: Band, order: readonly RiseUnit[]): void {
  const { resting, route, rng, cellOut, crest, between, near, crestAt, h, place } = band;
  for (const u of order) {
    if (resting || route(u)) continue;
    const low = u.hi - u.lo < BAND.faceFrom;
    if (low && !rng.chance(BAND.lowCrest)) continue;
    const back = rng.chance(BAND.crestBack) ? 1.5 : 0.5;
    const jit = (rng.next() - 0.5) * 0.8;
    const [ax, ay] = cellOut(u, -back, jit);
    const spacing = crest.w * between(BAND.crestGap);
    if (near(crestAt, ax + 0.5, ay + 0.5, spacing)) continue;
    if (h(ax, ay) < u.hi - 0.25) continue;
    if (place("cliff_crest", ax, ay, u.side, "ground")) crestAt.push([ax + 0.5, ay + 0.5]);
  }
}

/**
 * Plugs: a cliff face must be hidden (rock over the middle of every edge cell and 0.4 either side, over the whole height
 * of the face; gen/cover.ts). Generator 2 asked only for a piece's box near the edge midpoint; generator 3 re-tests
 * every edge and plugs what is still seen, up to three rounds, with the piece that fits the rise. Returns the indices
 * of the boulders the plugs added.
 */
function plugGaps(band: Band, order: readonly RiseUnit[]): number[] {
  const { resting, hidden, unitMid, out, coursesOf, route, noStand, h, place, crestAt, faceAt } = band;
  const covers = (u: RiseUnit): boolean => {
    if (resting) return hidden(u);
    const [mx, my] = unitMid(u);
    return out.some(
      (q) =>
        mx >= q.at[0] - 0.3 &&
        mx <= q.at[0] + q.size[0] + 0.3 &&
        my >= q.at[1] - 0.3 &&
        my <= q.at[1] + q.size[1] + 0.3,
    );
  };
  /** Indices of the boulders the plug rounds added (generator 3 prunes the redundant ones below). */
  const plugCrests: number[] = [];
  for (let round = 0; round < (resting ? 3 : 1); round++)
    for (const u of order) {
      if (
        (!resting && coursesOf(u) === 0) ||
        route(u) ||
        (resting && noStand(u.low[0], u.low[1])) ||
        covers(u)
      )
        continue;
      // the skirt is one simple course: its gaps are not plugged
      if (u.perim) continue;
      const [dx, dy] = STEP[u.side];
      const ns = u.side === "N" || u.side === "S";
      const tall = u.hi - u.lo >= BAND.faceFrom;
      const tries: Array<[Piece, number, number, "ground" | "rock", boolean]> = [];
      if (!resting) {
        for (const along of [0, 1, -1])
          tries.push([
            "cliff_face",
            u.low[0] + (ns ? along : 0),
            u.low[1] + (ns ? 0 : along),
            "ground",
            true,
          ]);
        tries.push(
          ["cliff_crest", u.low[0] + dx, u.low[1] + dy, "ground", false],
          ["cliff_crest", u.low[0], u.low[1], "ground", true],
        );
      } else {
        // long pieces first (the face and ledge rock carries the cover, boulders only close what is left): face rock
        // on the low ground against the face, a second course on rock, then a boulder at the foot and one on the lip
        const alongs = [0, 1, -1, 2, -2];
        for (const along of alongs) {
          const ax = u.low[0] + (ns ? along : 0);
          const ay = u.low[1] + (ns ? 0 : along);
          if (tall) tries.push(["cliff_face", ax, ay, "ground", true]);
        }
        if (tall)
          for (const along of [0, 1, -1, 2, -2, 3, -3]) {
            const ax = u.low[0] - dx + (ns ? along : 0);
            const ay = u.low[1] - dy + (ns ? 0 : along);
            tries.push(["cliff_face", ax, ay, "ground", true]);
          }
        for (const along of alongs) {
          const ax = u.low[0] + (ns ? along : 0);
          const ay = u.low[1] + (ns ? 0 : along);
          if (tall)
            tries.push(
              ["cliff_face", ax - dx, ay - dy, "rock", false],
              ["cliff_face", ax - dx * 2, ay - dy * 2, "rock", false],
            );
        }
        for (const along of alongs) {
          const ax = u.low[0] + (ns ? along : 0);
          const ay = u.low[1] + (ns ? 0 : along);
          tries.push(["cliff_crest", ax, ay, "ground", true]);
        }
        tries.push(["cliff_crest", u.low[0] + dx, u.low[1] + dy, "ground", false]);
      }
      let placed = 0;
      for (const [t, ax, ay, base, low] of tries) {
        if (base === "ground" && (low ? h(ax, ay) > u.lo + 0.25 : h(ax, ay) < u.hi - 0.25)) continue;
        if (place(t, ax, ay, u.side, base)) {
          if (t === "cliff_crest") {
            crestAt.push([ax + 0.5, ay + 0.5]);
            plugCrests.push(out.length - 1);
          } else faceAt[0]?.push([ax + 0.5, ay + 0.5]);
          placed++;
          if (!resting || hidden(u) || placed >= 2) break;
        }
      }
    }
  return plugCrests;
}

/**
 * Generator 3: a plug boulder that a later piece made redundant goes (boulders are accents, the long pieces hide the
 * face): removed when every edge near it stays hidden without it. Highest index first, so the indices below hold.
 */
function dropRedundantPlugs(band: Band, plugCrests: readonly number[]): void {
  const { resting, shapes, units, unitMid, hidden, out, footprints, restsOn, crestAt } = band;
  if (resting)
    for (const i of [...plugCrests].sort((a, b) => b - a)) {
      const s = shapes[i] as RockShape;
      const nearby = units.filter((u) => {
        const [mx, my] = unitMid(u);
        return Math.hypot(mx - s.cx, my - s.cy) <= Math.max(s.w, s.d) / 2 + 1.2;
      });
      const wasHidden = nearby.filter((u) => hidden(u));
      shapes.splice(i, 1);
      if (wasHidden.every((u) => hidden(u))) {
        out.splice(i, 1);
        footprints.splice(i, 1);
        restsOn.splice(i, 1);
        for (let k = 0; k < restsOn.length; k++)
          if ((restsOn[k] as number) > i) restsOn[k] = (restsOn[k] as number) - 1;
        const at_ = crestAt.findIndex(([x, y]) => Math.abs(x - s.cx) < 0.7 && Math.abs(y - s.cy) < 0.7);
        if (at_ >= 0) crestAt.splice(at_, 1);
      } else shapes.splice(i, 0, s);
    }
}

/** Run ends fade into two or three loose boulders on the low ground (an edge that turns a corner goes on). */
function fadeRunEnds(band: Band): void {
  const { units, coursesOf, route, resting, rng, grid, h, place } = band;
  const at = new Set<number>();
  for (const u of units) {
    const [dx, dy] = STEP[u.side];
    at.add(key(u.low[0], u.low[1]));
    at.add(key(u.low[0] + dx, u.low[1] + dy));
  }
  for (const u of units) {
    if (coursesOf(u) === 0 || route(u) || (resting && u.perim)) continue;
    const ns = u.side === "N" || u.side === "S";
    for (const dir of [-1, 1] as const) {
      const nx = u.low[0] + (ns ? dir : 0);
      const ny = u.low[1] + (ns ? 0 : dir);
      let goesOn = false;
      for (let y = ny - 1; y <= ny + 1 && !goesOn; y++)
        for (let x = nx - 1; x <= nx + 1; x++)
          if (at.has(key(x, y)) && !(x === u.low[0] && y === u.low[1])) {
            const [dx, dy] = STEP[u.side];
            if (!(x === u.low[0] + dx && y === u.low[1] + dy)) {
              goesOn = true;
              break;
            }
          }
      if (goesOn) continue;
      const [dx, dy] = STEP[u.side];
      // generator 3: a run ends in one or two loose boulders, and not at every end
      if (resting && !rng.chance(0.3)) continue;
      const k = resting ? 1 + rng.int(2) : 2 + rng.int(2);
      let along = 0;
      for (let i = 0; i < k; i++) {
        along += 0.8 + rng.next();
        const out_ = 0.5 + rng.next() * 1.5;
        const bx = Math.floor(u.low[0] + 0.5 + (ns ? dir * along : 0) - dx * out_);
        const by = Math.floor(u.low[1] + 0.5 + (ns ? 0 : dir * along) - dy * out_);
        if (grid.inBounds(bx, by) && h(bx, by) <= u.lo + 0.25) place("cliff_crest", bx, by, u.side, "ground");
      }
    }
  }
}

/**
 * Generator 3: rock must not bury a terrace. Where the rock stands on more than BAND.terraceShare of a terrace's walkable
 * ground, boulders go (those the face rock does not need, in random order) until it does not, or none is left.
 */
function unburyTerraces(band: Band): void {
  const { resting, p, grid, h, shapes, rng, out, units, unitMid, hidden, footprints, restsOn } = band;
  if (resting) {
    const ground = p.areaCells
      .filter(([x, y]) => grid.isFloor(x, y))
      .map(([x, y]) => ({ x, y, ground: h(x, y) }));
    const over = (): Set<number> =>
      new Set(
        terraceRockShare(shapes, ground)
          .filter((t) => t.share > BAND.terraceShare)
          .map((t) => t.terrace),
      );
    let bad = over();
    if (bad.size > 0) {
      const boulders = rng
        .shuffle(out.map((q, i) => [q, i] as const).filter(([q]) => q.type === "cliff_crest"))
        .map(([, i]) => i);
      const gone: number[] = [];
      for (const i of boulders) {
        if (bad.size === 0) break;
        const s = shapes[i] as RockShape;
        if (!bad.has(Math.round(h(Math.floor(s.cx), Math.floor(s.cy))))) continue;
        const nearby = units.filter((u) => {
          const [mx, my] = unitMid(u);
          return Math.hypot(mx - s.cx, my - s.cy) <= Math.max(s.w, s.d) / 2 + 1.2;
        });
        const wasHidden = nearby.filter((u) => hidden(u));
        // (shapes keep their indices: the removed ones are swapped for a shape nothing can touch)
        shapes[i] = { ...s, w: 0, d: 0, top: s.base };
        if (wasHidden.every((u) => hidden(u))) {
          gone.push(i);
          bad = over();
        } else shapes[i] = s;
      }
      for (const i of gone.sort((a, b) => b - a)) {
        out.splice(i, 1);
        shapes.splice(i, 1);
        footprints.splice(i, 1);
        restsOn.splice(i, 1);
        for (let k = 0; k < restsOn.length; k++)
          if ((restsOn[k] as number) > i) restsOn[k] = (restsOn[k] as number) - 1;
      }
    }
  }
}

/** The band as placed: its pieces, coverage (a unit is clad when a piece covers its low cell or its upper cell), cells. */
function bandResult(band: Band): BandResult {
  const { units, resting, hidden, pieceCells, out, footprints, restsOn } = band;
  let clad = 0;
  for (const u of units) {
    const [dx, dy] = STEP[u.side];
    if (
      resting
        ? hidden(u)
        : pieceCells.has(key(u.low[0], u.low[1])) || pieceCells.has(key(u.low[0] + dx, u.low[1] + dy))
    )
      clad++;
  }
  const cells: Array<[number, number]> = [];
  if (resting) {
    // (pruned boulders leave their cells free)
    const kept = new Set<number>();
    for (const q of out)
      for (let y = q.at[1]; y < q.at[1] + q.size[1]; y++)
        for (let x = q.at[0]; x < q.at[0] + q.size[0]; x++) kept.add(key(x, y));
    for (const k of kept) cells.push([Math.floor(k / 32768) - 16384, (k % 32768) - 16384]);
  } else for (const k of pieceCells) cells.push([Math.floor(k / 32768) - 16384, (k % 32768) - 16384]);
  return { placements: out, units: units.length, clad, cells, rises: units, footprints, restsOn };
}
