/**
 * Generated features (architecture §2.5): `scatter` and `dress`. Both work against a small read-only view of
 * the level being resolved (`PlacementGrid`) and return candidate placements in generation order; the resolver
 * commits them (ids `<opId>#<n>`, occupancy flags).
 */
import type { DressPreset, FeatureType, Rotation, Side } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { featureInfo, rotatedSize } from "./catalog";

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
}

export interface GeneratedPlacement {
  type: FeatureType;
  at: [number, number];
  size: [number, number];
  rot: Rotation;
  rotFine: number;
  wall?: Side;
  variant?: string;
}

const EDGE_WALL = 1;
const EDGE_OPENING = 2;
const FLAG_NO_FLOOR = 1;
const FLAG_WATER = 4;
const FLAG_PATH = 8;
const FLAG_LINK = 16;

const SIDES: readonly Side[] = ["N", "E", "S", "W"];

/** Integer key of a cell (coordinates are within ±8192). */
const cellKey = (x: number, y: number): number => (x + 16384) * 32768 + (y + 16384);

function footprintCells(
  at: readonly [number, number],
  size: readonly [number, number],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = at[1]; y < at[1] + size[1]; y++)
    for (let x = at[0]; x < at[0] + size[0]; x++) out.push([x, y]);
  return out;
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

// ───────────────────────────── scatter ─────────────────────────────

export type AvoidKind = "water" | "paths" | "areas" | "walls" | "features" | "links";

export interface ScatterParams {
  feature: FeatureType;
  /** Candidate cells (global), any order; they are sorted row-major before the seeded shuffle. */
  candidates: Array<[number, number]>;
  density: number;
  minSpacing: number;
  avoid: ReadonlySet<AvoidKind>;
  variants?: readonly string[];
  randomRotation: boolean;
  seed: number;
  /** How many more features this level may still generate (cap). */
  remaining: number;
}

export interface ScatterResult {
  placements: GeneratedPlacement[];
  capped: boolean;
}

export function scatterFeatures(grid: PlacementGrid, p: ScatterParams): ScatterResult {
  const info = featureInfo(p.feature);
  const rng = createPrng(subSeed(p.seed, "scatter"));
  const sorted = p.candidates.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const order = rng.shuffle(sorted);
  const out: GeneratedPlacement[] = [];
  const spacing = Math.max(1, Math.floor(p.minSpacing));
  const reach = spacing - 1;
  // accepted cells: exact membership + a bucket grid (bucket side = spacing) for the spacing test, so each
  // test looks at ≤ 9 buckets instead of (2·spacing − 1)² cells
  const accepted = new Set<number>();
  const buckets = new Map<number, Array<[number, number]>>();
  const bucketKey = (bx: number, by: number): number => (bx + 32768) * 65536 + (by + 32768);
  const accept = (x: number, y: number): void => {
    accepted.add(cellKey(x, y));
    const k = bucketKey(Math.floor(x / spacing), Math.floor(y / spacing));
    const b = buckets.get(k);
    if (b) b.push([x, y]);
    else buckets.set(k, [[x, y]]);
  };
  let capped = false;

  const cellOk = (x: number, y: number): boolean => {
    if (!grid.inBounds(x, y) || !grid.isFloor(x, y) || grid.occupied(x, y)) return false;
    const f = grid.flags(x, y);
    if (f & (FLAG_LINK | FLAG_NO_FLOOR)) return false;
    if (p.avoid.has("water") && f & FLAG_WATER) return false;
    if (p.avoid.has("paths") && f & FLAG_PATH) return false;
    if (p.avoid.has("areas") && grid.area(x, y) !== 0) return false;
    if (p.avoid.has("walls")) {
      for (const s of SIDES) {
        const e = grid.edge(x, y, s);
        if (e === EDGE_WALL || e === EDGE_OPENING) return false;
      }
    }
    return true;
  };
  // minSpacing applies between this op's own placements; "features"/"links" in avoid keep one clear cell
  // (Chebyshev distance ≥ 2) from features and links that already exist.
  const tooClose = (x: number, y: number): boolean => {
    if (reach > 0) {
      const bx = Math.floor(x / spacing);
      const by = Math.floor(y / spacing);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (const [ax, ay] of buckets.get(bucketKey(bx + dx, by + dy)) ?? [])
            if (Math.max(Math.abs(ax - x), Math.abs(ay - y)) <= reach) return true;
    } else if (accepted.has(cellKey(x, y))) return true;
    for (let yy = y - 1; yy <= y + 1; yy++) {
      for (let xx = x - 1; xx <= x + 1; xx++) {
        if (!grid.inBounds(xx, yy)) continue;
        if (p.avoid.has("features") && grid.occupied(xx, yy) && !accepted.has(cellKey(xx, yy))) return true;
        if (p.avoid.has("links") && grid.flags(xx, yy) & FLAG_LINK) return true;
      }
    }
    return false;
  };

  for (const [cx, cy] of order) {
    // Draw every random number for every candidate so the stream does not depend on eligibility.
    const r = rng.next();
    const rotStep = rng.int(24);
    const variantIdx = p.variants && p.variants.length > 0 ? rng.int(p.variants.length) : -1;
    if (r >= p.density) continue;
    if (out.length >= p.remaining) {
      capped = true;
      break;
    }
    const rotFine = info.organic && p.randomRotation ? rotStep * 15 : 0;
    const rot = ((Math.round(rotFine / 90) % 4) * 90) as Rotation;
    const size = rotatedSize(info.size, rot);
    const cells = footprintCells([cx, cy], size);
    if (!cells.every(([x, y]) => cellOk(x, y))) continue;
    if (cells.some(([x, y]) => tooClose(x, y))) continue;
    if (footprintCrossesWall(grid, [cx, cy], size)) continue;
    for (const [x, y] of cells) accept(x, y);
    const placement: GeneratedPlacement = { type: p.feature, at: [cx, cy], size, rot, rotFine };
    if (variantIdx >= 0 && p.variants) placement.variant = p.variants[variantIdx] as string;
    out.push(placement);
  }
  return { placements: out, capped };
}

// ───────────────────────────── dress ─────────────────────────────

export type DressPlacement = "wall" | "center" | "corner";

export interface DressItem {
  type: FeatureType;
  weight: number;
  placement: DressPlacement;
  /** Unrotated footprint: w runs ALONG the wall for wall items. Default: catalog size. */
  size?: readonly [number, number];
}

const W = (type: FeatureType, weight: number, size?: readonly [number, number]): DressItem =>
  size ? { type, weight, placement: "wall", size } : { type, weight, placement: "wall" };
const C = (type: FeatureType, weight: number, size?: readonly [number, number]): DressItem =>
  size ? { type, weight, placement: "center", size } : { type, weight, placement: "center" };
const K = (type: FeatureType, weight: number): DressItem => ({ type, weight, placement: "corner" });

/** Preset table (generator v1; changing it changes generated maps, so treat it as frozen). */
export const DRESS_PRESET_TABLE: Record<DressPreset, readonly DressItem[]> = {
  tavern: [
    C("table", 4),
    C("round_table", 3),
    C("chair", 5),
    C("stool", 3),
    W("bar_counter", 2),
    K("barrel", 3),
    W("shelf", 1),
    W("torch_wall", 1),
  ],
  library: [W("bookshelf", 6), C("desk", 2), C("chair", 2), C("table", 1), K("candelabra", 1), C("rug", 1)],
  barracks: [
    W("bunk_bed", 5),
    W("chest", 3),
    W("weapon_rack", 2),
    C("table", 1),
    C("stool", 2),
    K("barrel", 1),
    W("armor_stand", 1),
  ],
  bedroom: [W("bed", 3), W("wardrobe", 2), W("chest", 2), C("rug", 1), K("candelabra", 1), C("chair", 1)],
  kitchen: [
    W("counter", 3),
    K("barrel", 3),
    C("table", 2),
    W("shelf", 2),
    C("cauldron", 1),
    K("sack", 2),
    K("crate", 1),
  ],
  storeroom: [K("crate", 5), K("barrel", 4), K("sack", 3), W("shelf", 2), C("crate", 2)],
  throne_room: [
    W("throne", 1),
    W("banner_wall", 3),
    C("pillar", 2),
    C("rug", 1),
    K("brazier", 2),
    W("statue", 1),
  ],
  shrine: [W("altar", 1), K("candelabra", 2), C("bench", 3), W("statue", 1), K("brazier", 1)],
  crypt: [W("sarcophagus", 3), W("coffin", 2), C("tomb", 1), K("bones", 2), K("web", 2), C("debris", 1)],
  prison: [W("cage", 2), W("stocks", 1), K("bones", 2), C("chair", 1), W("torch_wall", 1)],
  forge: [
    W("forge", 2),
    C("anvil", 2),
    K("barrel", 2),
    W("weapon_rack", 2),
    W("armor_stand", 1),
    K("crate", 1),
  ],
  laboratory: [
    C("table", 3),
    W("shelf", 3),
    W("bookshelf", 2),
    C("cauldron", 2),
    K("barrel", 1),
    C("stool", 1),
  ],
  treasury: [K("chest", 5), C("chest", 2), W("statue", 1), W("shelf", 1), C("pillar", 1)],
  ruin: [C("rubble", 5), C("debris", 3), K("rubble", 2), C("pillar", 1), K("web", 1), C("bones", 1)],
  camp: [C("tent", 2), C("campfire", 1), K("log", 2), C("stump", 2), K("crate", 1), K("barrel", 1)],
};

export interface DressParams {
  preset: DressPreset;
  /** Display area index + 1 of the area being dressed. */
  areaIndex: number;
  /** Cells of the area (global). */
  areaCells: Array<[number, number]>;
  density: number;
  seed: number;
  remaining: number;
}

const SIDE_ROT: Record<Side, Rotation> = { N: 0, E: 90, S: 180, W: 270 };
/** Random candidates tried per dress item before it is dropped. */
const SAMPLE_TRIES = 24;

/** Footprint top-left for an item of unrotated size [w (along wall), h (depth)] backed onto `side` of (cx, cy). */
function wallFootprint(
  cx: number,
  cy: number,
  side: Side,
  size: readonly [number, number],
): [number, number] {
  const h = size[1];
  switch (side) {
    case "N":
    case "W":
      return [cx, cy];
    case "S":
      return [cx, cy - h + 1];
    case "E":
      return [cx - h + 1, cy];
  }
}

export function dressArea(grid: PlacementGrid, p: DressParams): ScatterResult {
  const table = DRESS_PRESET_TABLE[p.preset];
  const rng = createPrng(subSeed(p.seed, "dress"));
  const cells = p.areaCells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const floorCells = cells.filter(([x, y]) => grid.isFloor(x, y));
  const count = Math.round((p.density * floorCells.length) / 6);
  const totalWeight = table.reduce((a, i) => a + i.weight, 0);
  const taken = new Set<number>();
  const out: GeneratedPlacement[] = [];
  let capped = false;

  const wallSides = (x: number, y: number): Side[] => SIDES.filter((s) => grid.edge(x, y, s) === EDGE_WALL);
  const nearOpening = (x: number, y: number): boolean =>
    SIDES.some((s) => grid.edge(x, y, s) === EDGE_OPENING);
  const free = (x: number, y: number, blocking: boolean): boolean =>
    grid.inBounds(x, y) &&
    grid.area(x, y) === p.areaIndex &&
    grid.isFloor(x, y) &&
    !grid.occupied(x, y) &&
    !taken.has(cellKey(x, y)) &&
    (grid.flags(x, y) & FLAG_LINK) === 0 &&
    !(blocking && nearOpening(x, y));

  // Candidate lists are built once per area (wall-backed cells with their wall side, corners, free centre
  // cells); each item samples up to SAMPLE_TRIES candidates until one fits, so cost is O(items × tries).
  type Cand = { at: [number, number]; size: [number, number]; rot: Rotation; wall?: Side };
  const wallPairs: Array<[number, number, Side]> = [];
  const cornerPairs: Array<[number, number, Side]> = [];
  const centerCells: Array<[number, number]> = [];
  for (const [x, y] of floorCells) {
    const ws = wallSides(x, y);
    for (const sd of ws) wallPairs.push([x, y, sd]);
    for (let i = 0; i < 4; i++) {
      const a = SIDES[i] as Side;
      if (ws.includes(a) && ws.includes(SIDES[(i + 1) % 4] as Side)) {
        cornerPairs.push([x, y, a]);
        break;
      }
    }
    if (ws.length === 0) centerCells.push([x, y]);
  }
  const sample = <T>(list: readonly T[], make: (e: T) => Cand): Cand | null => {
    if (list.length === 0) return null;
    for (let t = 0; t < SAMPLE_TRIES; t++) {
      const cand = make(list[rng.int(list.length)] as T);
      if (fits(cand)) return cand;
    }
    return null;
  };
  let fits: (c: Cand) => boolean = () => false;

  for (let n = 0; n < count && totalWeight > 0; n++) {
    let pickW = rng.next() * totalWeight;
    let item = table[table.length - 1] as DressItem;
    for (const it of table) {
      pickW -= it.weight;
      if (pickW < 0) {
        item = it;
        break;
      }
    }
    const info = featureInfo(item.type);
    const baseSize = item.size ?? info.size;
    const centerRot = (rng.int(4) * 90) as Rotation;
    if (out.length >= p.remaining) {
      capped = true;
      break;
    }
    const blocking = info.blocking && !info.wallMounted;
    fits = (c: Cand): boolean =>
      footprintCells(c.at, c.size).every(([x, y]) => free(x, y, blocking)) &&
      !footprintCrossesWall(grid, c.at, c.size);
    const fromWall = (e: readonly [number, number, Side]): Cand => {
      const rot = SIDE_ROT[e[2]];
      const c: Cand = {
        at: wallFootprint(e[0], e[1], e[2], baseSize),
        size: rotatedSize(baseSize, rot),
        rot,
      };
      if (info.wallMounted) c.wall = e[2];
      return c;
    };
    const fromCenter = (e: readonly [number, number]): Cand => ({
      at: [e[0], e[1]],
      size: rotatedSize(baseSize, centerRot),
      rot: centerRot,
    });
    let c: Cand | null = null;
    if (item.placement === "wall") c = sample(wallPairs, fromWall);
    else if (item.placement === "corner") c = sample(cornerPairs, fromWall);
    if (!c && !info.wallMounted) c = sample(centerCells, fromCenter);
    if (!c) continue;
    for (const cell of footprintCells(c.at, c.size)) taken.add(cellKey(cell[0], cell[1]));
    const placement: GeneratedPlacement = {
      type: item.type,
      at: c.at,
      size: c.size,
      rot: c.rot,
      rotFine: c.rot,
    };
    if (c.wall) placement.wall = c.wall;
    out.push(placement);
  }
  return { placements: out, capped };
}
