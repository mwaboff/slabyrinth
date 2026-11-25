/**
 * The slab-level tier of the quality meter (review/qualityMetrics.ts defines every metric once): measures that need
 * only placed pieces and their boxes, so they run on our builds and on any decoded slab alike (the calibration hook:
 * a script outside the repo calls `slabMeter` on decoded community placements, with no plan and no palette).
 *
 * A piece is a stored position, a yaw and a world box (tiles; y up). `tile` is TaleSpire's own split: a tile is
 * stored at its min corner and snaps to the grid (our palettes: geom.originAt "minCorner"), a prop at its origin.
 * "Structure" below means tiles and "props" everything else: the one split every slab carries, so our builds and
 * community builds are measured alike (a rock wall built from props counts as props here). `loose` narrows the props
 * to the dressing (furniture, clutter, lights, plants: our role "feature"; a class reading for a decoded slab); the
 * dressing measures fall back to every prop when no piece says.
 *
 * Pure and deterministic; every pass is a hash grid over the pieces (no all-pairs loop), fast enough for a 10,000-piece
 * build in the golden run.
 */
import type { Box3 } from "../contracts/compiler";
import { overlapArea, turnedFootprint, type PlanPoint } from "../util/turn";

/** One placed piece, as the slab tier sees it. */
export interface MeterPiece {
  /** Asset id (any stable string: a uuid). */
  readonly asset: string;
  /** Stored height (tiles): what the 0.25 grid is measured on. */
  readonly y: number;
  /** Yaw, degrees (multiples of 15 in TaleSpire). */
  readonly rot: number;
  /** World axis-aligned box, tiles. */
  readonly box: Box3;
  /**
   * The piece's own plan size before its turn (x by z), when known. With it, a piece off the quarter turns is judged
   * by its true turned footprint where plan overlap matters (coplanar tops); without it, by its box.
   */
  readonly size?: { readonly x: number; readonly z: number };
  /** A TaleSpire tile (grid-snapped structure) rather than a prop. */
  readonly tile: boolean;
  /** Loose dressing (furniture, clutter, lights, plants) rather than a prop used as structure. Absent = unknown. */
  readonly loose?: boolean;
  /** The asset's kit (pack folder or group tag) when known; the largest-kit share needs it on every piece. */
  readonly kit?: string;
}

/** The slab tier's values, by metric id (null: nothing to measure, e.g. no props). */
export interface SlabMeterValues {
  pieces: number;
  prop_share: number | null;
  overlap_share: number | null;
  pieces_per_tile: number | null;
  pieces_per_column: number | null;
  prop_off_axis: number | null;
  structure_off_axis: number | null;
  prop_off_height_grid: number | null;
  prop_rest_contact: number | null;
  prop_on_prop: number | null;
  symmetry_structure: number | null;
  symmetry_dressing: number | null;
  distinct_assets: number;
  top_asset_share: number | null;
  largest_kit_share: number | null;
  coplanar_share: number | null;
  stamped_groups: number;
  exact_duplicates: number;
}

/** The fixed numbers of the slab tier's definitions (tiles unless named). */
export const SLAB_METER = {
  /** Two boxes interpenetrate when they overlap by more than this on every axis (the training decoder's figure). */
  overlapEps: 0.02,
  /** A footprint covers a 1 × 1 column when it reaches more than this into it. */
  columnEps: 0.02,
  /** A yaw this far (degrees) from a quarter turn is off-axis. */
  axisEps: 0.5,
  /** A stored height this far from the slab's own 0.25 grid is off it. */
  heightEps: 0.01,
  /** A prop rests on a piece when its base lies within this of the piece's top (or inside it: bedded). */
  restEps: 0.05,
  /** Mirror partners: same asset, centres within this along the plane and in height. */
  mirrorTol: 0.15,
  /** Mirror planes are counted in buckets of this size. */
  mirrorStep: 0.25,
  /** Flat pieces (box height at most this) are judged for coplanar top faces. */
  flatHeight: 0.5,
  /** Two flat tops closer than this (and overlapping by at least `coplanarArea`, tiles²) flicker. */
  coplanarGap: 0.02,
  coplanarArea: 0.05,
  /** Identical dressing within this of each other (plan view; height within `stampRise`) forms one group. */
  stampLink: 1.5,
  stampRise: 0.5,
  /** A group of at least this many identical dressing pieces, all at one heading, is stamped. */
  stampMin: 4,
  /** Two pieces of one asset closer than this in every coordinate, at one yaw, are duplicates. */
  duplicateEps: 0.005,
} as const;

const T = SLAB_METER;

/** Degrees from `rot` to the nearest multiple of `step`. */
const offBy = (rot: number, step: number): number => {
  const r = ((rot % step) + step) % step;
  return Math.min(r, step - r);
};
const offQuarter = (rot: number): boolean => offBy(rot, 90) > T.axisEps;

const share = (n: number, of: number): number | null => (of > 0 ? n / of : null);

/** Integer columns a box's footprint covers (x0..x1 × z0..z1, inclusive). */
function columns(b: Box3): { x0: number; x1: number; z0: number; z1: number } {
  const x0 = Math.floor(b.min.x + T.columnEps);
  const z0 = Math.floor(b.min.z + T.columnEps);
  return {
    x0,
    z0,
    x1: Math.max(x0, Math.ceil(b.max.x - T.columnEps) - 1),
    z1: Math.max(z0, Math.ceil(b.max.z - T.columnEps) - 1),
  };
}

const colKey = (x: number, z: number): number => (x + 32768) * 65536 + (z + 32768);

function pushTo<K>(m: Map<K, number[]>, k: K, v: number): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/** A hash grid of pieces by the 1 × 1 columns their footprints cover. */
class ColumnIndex {
  readonly cells = new Map<number, number[]>();
  private readonly stamp: Int32Array;
  constructor(readonly pieces: readonly MeterPiece[]) {
    this.stamp = new Int32Array(pieces.length).fill(-1);
    pieces.forEach((p, i) => {
      const c = columns(p.box);
      for (let x = c.x0; x <= c.x1; x++)
        for (let z = c.z0; z <= c.z1; z++) pushTo(this.cells, colKey(x, z), i);
    });
  }
  /** Pieces whose footprint shares a column with piece `i`'s (each once), excluding `i`. */
  near(i: number): number[] {
    const c = columns((this.pieces[i] as MeterPiece).box);
    const out: number[] = [];
    for (let x = c.x0; x <= c.x1; x++)
      for (let z = c.z0; z <= c.z1; z++)
        for (const j of this.cells.get(colKey(x, z)) ?? []) {
          if (j === i || this.stamp[j] === i) continue;
          this.stamp[j] = i;
          out.push(j);
        }
    return out;
  }
  /** Pieces whose footprint covers the column of point (x, z). */
  at(x: number, z: number): readonly number[] {
    return this.cells.get(colKey(Math.floor(x), Math.floor(z))) ?? [];
  }
}

/** Overlap depth of two intervals (negative when apart). */
const depth = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

/** Do two boxes interpenetrate (by more than `eps` on every axis)? */
export function boxesOverlap(a: Box3, b: Box3, eps: number = T.overlapEps): boolean {
  return (
    depth(a.min.x, a.max.x, b.min.x, b.max.x) > eps &&
    depth(a.min.y, a.max.y, b.min.y, b.max.y) > eps &&
    depth(a.min.z, a.max.z, b.min.z, b.max.z) > eps
  );
}

/** A piece's plan footprint: its true turned rectangle when its size is known and it is off the quarter turns. */
function footprint(p: MeterPiece): PlanPoint[] | null {
  if (p.size === undefined || !offQuarter(p.rot)) return null;
  const c = centre(p.box);
  return turnedFootprint(c.x, c.z, p.size.x, p.size.z, p.rot);
}

/** Are two flat pieces' tops within `coplanarGap` of each other over at least `coplanarArea` of plan? */
function coplanarTops(p: MeterPiece, q: MeterPiece): boolean {
  const a = p.box;
  const b = q.box;
  const flat = (x: Box3): boolean => x.max.y - x.min.y <= T.flatHeight;
  if (!flat(a) || !flat(b) || Math.abs(a.max.y - b.max.y) >= T.coplanarGap) return false;
  const ox = Math.max(0, depth(a.min.x, a.max.x, b.min.x, b.max.x));
  const oz = Math.max(0, depth(a.min.z, a.max.z, b.min.z, b.max.z));
  if (ox * oz < T.coplanarArea) return false; // the boxes hold the footprints: no more overlap than this
  const fp = footprint(p);
  const fq = footprint(q);
  if (fp === null && fq === null) return true;
  const rect = (x: Box3): PlanPoint[] => [
    [x.min.x, x.min.z],
    [x.max.x, x.min.z],
    [x.max.x, x.max.z],
    [x.min.x, x.max.z],
  ];
  return overlapArea(fp ?? rect(a), fq ?? rect(b)) >= T.coplanarArea;
}

const centre = (b: Box3): { x: number; y: number; z: number } => ({
  x: (b.min.x + b.max.x) / 2,
  y: (b.min.y + b.max.y) / 2,
  z: (b.min.z + b.max.z) / 2,
});

/**
 * Best mirror share of a class of pieces: over the two plan axes and every plane position (in `mirrorStep` buckets),
 * the largest share of the pieces that have a partner of the same asset at the mirrored place (a piece centred on the
 * plane is its own partner). Position only: TaleSpire cannot mirror a mesh, so the yaw is not compared. Null for fewer
 * than two pieces.
 */
export function mirrorShare(pieces: readonly MeterPiece[]): number | null {
  if (pieces.length < 2) return null;
  const cs = pieces.map((p) => ({ asset: p.asset, ...centre(p.box) }));
  const byAsset = new Map<string, typeof cs>();
  for (const c of cs) {
    const l = byAsset.get(c.asset);
    if (l) l.push(c);
    else byAsset.set(c.asset, [c]);
  }
  let best = 0;
  for (const axis of ["x", "z"] as const) {
    const along = axis === "x" ? "z" : "x";
    const votes = new Map<number, number>();
    const vote = (m: number, n: number): void => {
      const k = Math.round(m / T.mirrorStep);
      votes.set(k, (votes.get(k) ?? 0) + n);
    };
    for (const list of byAsset.values()) {
      const sorted = [...list].sort((a, b) => a[along] - b[along] || a.y - b.y || a[axis] - b[axis]);
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i] as (typeof cs)[number];
        vote(a[axis], 1);
        for (let j = i + 1; j < sorted.length; j++) {
          const b = sorted[j] as (typeof cs)[number];
          if (b[along] - a[along] > T.mirrorTol) break;
          if (Math.abs(b.y - a.y) > T.mirrorTol) continue;
          if (Math.abs(b[axis] - a[axis]) <= T.mirrorTol) continue; // the same place: not a mirror pair
          vote((a[axis] + b[axis]) / 2, 2);
        }
      }
    }
    for (const n of votes.values()) best = Math.max(best, Math.min(n, cs.length));
  }
  return best / cs.length;
}

/**
 * Groups of at least `stampMin` identical pieces (one asset) linked within `stampLink` of each other, all at one
 * heading: the stamped look of a placed (not stored) set of things. Returns the number of such groups.
 */
export function stampedGroups(pieces: readonly MeterPiece[]): number {
  const byAsset = new Map<string, number[]>();
  pieces.forEach((p, i) => {
    pushTo(byAsset, p.asset, i);
  });
  const cell = (v: number): number => Math.floor(v / T.stampLink);
  let stamped = 0;
  for (const list of byAsset.values()) {
    if (list.length < T.stampMin) continue;
    const cs = list.map((i) => centre((pieces[i] as MeterPiece).box));
    const grid = new Map<number, number[]>();
    cs.forEach((c, k) => {
      pushTo(grid, colKey(cell(c.x), cell(c.z)), k);
    });
    const seen = new Uint8Array(list.length);
    for (let s = 0; s < list.length; s++) {
      if (seen[s]) continue;
      seen[s] = 1;
      const group = [s];
      for (let g = 0; g < group.length; g++) {
        const a = cs[group[g] as number] as { x: number; y: number; z: number };
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            for (const k of grid.get(colKey(cell(a.x) + dx, cell(a.z) + dz)) ?? []) {
              const b = cs[k] as { x: number; y: number; z: number };
              if (
                seen[k] ||
                Math.hypot(a.x - b.x, a.z - b.z) > T.stampLink ||
                Math.abs(a.y - b.y) > T.stampRise
              )
                continue;
              seen[k] = 1;
              group.push(k);
            }
      }
      if (group.length < T.stampMin) continue;
      const rots = new Set(group.map((k) => offBy((pieces[list[k] as number] as MeterPiece).rot, 360)));
      if (rots.size === 1) stamped++;
    }
  }
  return stamped;
}

/**
 * The fractional offset of a slab's own 0.25 height grid: the most common remainder of the tiles' stored heights (a
 * slab normalised to a prop's corner has its whole grid at a fraction). 0 without tiles.
 */
function gridOffset(pieces: readonly MeterPiece[], tiles: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const i of tiles) {
    const r = Math.round((((((pieces[i] as MeterPiece).y % 0.25) + 0.25) % 0.25) / 0.25) * 100) % 100;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [r, c] of [...counts].sort((a, b) => a[0] - b[0]))
    if (c > bestN) {
      best = r;
      bestN = c;
    }
  return (best / 100) * 0.25;
}

/** The slab tier of the quality meter over one build's pieces (a level, or a decoded slab). */
export function slabMeter(pieces: readonly MeterPiece[]): SlabMeterValues {
  const n = pieces.length;
  const props: number[] = [];
  const tiles: number[] = [];
  pieces.forEach((p, i) => (p.tile ? tiles : props).push(i));
  const told = pieces.some((p) => p.loose !== undefined);
  const dressing = told ? props.filter((i) => (pieces[i] as MeterPiece).loose === true) : props;
  const index = new ColumnIndex(pieces);

  // overlap (interpenetrating boxes), coplanar flat tops and duplicates, over pieces sharing a column
  const overlapped = new Uint8Array(n);
  const coplanar = new Uint8Array(n);
  let duplicates = 0;
  for (let i = 0; i < n; i++) {
    const p = pieces[i] as MeterPiece;
    for (const j of index.near(i)) {
      const q = pieces[j] as MeterPiece;
      if ((!overlapped[i] || !overlapped[j]) && boxesOverlap(p.box, q.box)) {
        overlapped[i] = 1;
        overlapped[j] = 1;
      }
      if (j < i) continue; // each pair once below
      const dup =
        p.asset === q.asset &&
        Math.abs(p.box.min.x - q.box.min.x) < T.duplicateEps &&
        Math.abs(p.box.min.y - q.box.min.y) < T.duplicateEps &&
        Math.abs(p.box.min.z - q.box.min.z) < T.duplicateEps &&
        offBy(p.rot - q.rot, 360) < T.axisEps;
      if (dup) duplicates++;
      else if (coplanarTops(p, q)) {
        coplanar[i] = 1;
        coplanar[j] = 1;
      }
    }
  }
  const flats = pieces.filter((p) => p.box.max.y - p.box.min.y <= T.flatHeight).length;

  // density: occupied 1 × 1 columns, and how many pieces cover each on average
  let covered = 0;
  for (const l of index.cells.values()) covered += l.length;
  const occupied = index.cells.size;

  // rest: a prop's base on (or bedded in) a piece under its centre, or on the slab's lowest level
  let floorY = Infinity;
  for (const p of pieces) floorY = Math.min(floorY, p.box.min.y);
  let resting = 0;
  let onProp = 0;
  for (const i of props) {
    const p = pieces[i] as MeterPiece;
    const c = centre(p.box);
    const base = p.box.min.y;
    let support: MeterPiece | undefined;
    for (const j of index.at(c.x, c.z)) {
      if (j === i) continue;
      const q = pieces[j] as MeterPiece;
      if (c.x < q.box.min.x || c.x > q.box.max.x || c.z < q.box.min.z || c.z > q.box.max.z) continue;
      if (base < q.box.min.y - T.restEps || base > q.box.max.y + T.restEps) continue;
      // the highest top at or round the base carries it
      if (!support || q.box.max.y > support.box.max.y) support = q;
    }
    if (support || base <= floorY + T.restEps) resting++;
    if (support && !support.tile) onProp++;
  }

  const offset = gridOffset(pieces, tiles);
  const offGrid = props.filter((i) => {
    const q = ((pieces[i] as MeterPiece).y - offset) / 0.25;
    return Math.abs(q - Math.round(q)) * 0.25 > T.heightEps;
  }).length;

  // variety
  const assetCount = new Map<string, number>();
  for (const p of pieces) assetCount.set(p.asset, (assetCount.get(p.asset) ?? 0) + 1);
  const kitted = n > 0 && pieces.every((p) => p.kit !== undefined && p.kit !== "");
  const kitCount = new Map<string, number>();
  if (kitted) for (const p of pieces) kitCount.set(p.kit ?? "", (kitCount.get(p.kit ?? "") ?? 0) + 1);
  const maxCount = (m: ReadonlyMap<string, number>): number => {
    let best = 0;
    for (const v of m.values()) best = Math.max(best, v);
    return best;
  };

  const sel = (ids: readonly number[]): MeterPiece[] => ids.map((i) => pieces[i] as MeterPiece);
  const turned = (ids: readonly number[]): number =>
    ids.filter((i) => offQuarter((pieces[i] as MeterPiece).rot)).length;
  return {
    pieces: n,
    prop_share: share(props.length, n),
    overlap_share: share(
      overlapped.reduce((t, v) => t + v, 0),
      n,
    ),
    pieces_per_tile: share(n, occupied),
    pieces_per_column: share(covered, occupied),
    prop_off_axis: share(turned(props), props.length),
    structure_off_axis: share(turned(tiles), tiles.length),
    prop_off_height_grid: share(offGrid, props.length),
    prop_rest_contact: share(resting, props.length),
    prop_on_prop: share(onProp, props.length),
    symmetry_structure: mirrorShare(sel(tiles)),
    symmetry_dressing: mirrorShare(sel(dressing)),
    distinct_assets: assetCount.size,
    top_asset_share: share(maxCount(assetCount), n),
    largest_kit_share: kitted ? share(maxCount(kitCount), n) : null,
    coplanar_share: share(
      coplanar.reduce((t, v) => t + v, 0),
      flats,
    ),
    stamped_groups: stampedGroups(sel(dressing)),
    exact_duplicates: duplicates,
  };
}
