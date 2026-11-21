/**
 * Generated features (architecture §2.5): `scatter` and `dress`. Both work against a small read-only view of
 * the level being resolved (`PlacementGrid`) and return candidate placements in generation order; the resolver
 * commits them (ids `<opId>#<n>`, occupancy flags).
 */
import type { DressPreset, FeatureType, Rotation, Side } from "../contracts/plan";
import { generatorProfile, type GeneratorProfile } from "../plan/generator";
import { subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { featureInfo, rotatedSize } from "./catalog";
import {
  EDGE_OPENING,
  EDGE_WALL,
  FLAG_LINK,
  FLAG_NO_FLOOR,
  FLAG_PATH,
  FLAG_WATER,
  SIDES,
  cellKey,
  footprintCells,
  wallFootprint,
} from "./gridGeometry";
import { ValueNoise } from "./noise";
import { ROOM_PURPOSE_INFO, presetPurpose } from "./roomPurpose";
import { dressRoom } from "./rooms4";
import { composeArea, isComposedPreset, type ComposedPreset } from "./setpieces";

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
  /** True on cells under a vehicle already placed (by the plan or another op). Optional. */
  vehicle?(x: number, y: number): boolean;
  /**
   * Size in tiles (w along its length, d across, h tall) of the asset a feature type resolves to here, from the
   * palette; undefined where the theme has no such asset. Optional: without the hook the cliff band uses nominal
   * sizes; with it, a theme that has neither cliff_face nor cliff_crest gets no band (its cliff keeps the built face).
   */
  pieceSize?(type: FeatureType): { w: number; d: number; h: number } | undefined;
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
   * review and the realizer judge cover with it. Optional.
   */
  pieceExtent?(type: FeatureType): { w: number; d: number; h: number } | undefined;
  /**
   * Generator 3: the level's water surface in tiles above the level floor (the scale of `height`; resolve/level.ts
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
   * Generator 4, room recipes (gen/rooms4.ts): the real size in tiles of the smallest variant of the piece a feature
   * type (and variant name) resolves to in the level's theme; undefined where the theme has no such piece (the recipe
   * leaves that item out). Absent: no room recipe runs.
   */
  piece4?(
    type: FeatureType,
    variant?: string,
  ): { w: number; d: number; h: number; wMax: number; dMax: number; hMax: number; tile: boolean; mixed: boolean } | undefined;
  /** Generator 4: does this cell host the wall strip on its `side` (a piece mounted there stands half a cell in)? */
  wallHosted?(x: number, y: number, side: Side): boolean;
  /** Generator 4: height in tiles of the wall on the cell's `side` (0 where there is none). */
  wallHeight?(x: number, y: number, side: Side): number;
  /** Generator 4: wall style of the wall on the cell's `side` (natural rock takes no shelf). */
  wallStyle?(x: number, y: number, side: Side): string | undefined;
  /** Generator 4: cells of the lights already on the level (wall torches, candles, braziers, lanterns), plan or generated. */
  lightCells?(): ReadonlyArray<readonly [number, number]>;
  /**
   * Generator 4: what the level's rooms have been given so far, by purpose (the recipe variants used), so rooms of one
   * purpose draw different variants. Created per level by the resolver.
   */
  roomMemory?: Map<string, number[]>;
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
  /**
   * Generator 2, natural pieces: place in drifts (value-noise patches with empty ground between, each accepted
   * piece growing a small clump) instead of an even blue-noise spread, which at high density packs into a lattice.
   */
  drift?: boolean;
  /**
   * Generator 2: only ground that carries the whole piece. The footprint lies on one height, and no cell round it
   * drops away (a cliff lip, a channel, a pit), so a piece wider than its cell never overhangs air and floats
   * (owner's watchtower run, 2026-11-20: the model spent four calls deleting floating scattered rocks).
   */
  supported?: boolean;
}

export interface ScatterResult {
  placements: GeneratedPlacement[];
  capped: boolean;
}

/**
 * Feature types that scatter in clumps (a seed placement plus 1–2 neighbours), so a scatter of stalagmites or
 * crystals reads as formations rather than litter. Only types added after generator v1 was frozen are listed:
 * adding a type here changes no existing map.
 */
export const CLUSTERED_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>([
  "stalagmite",
  "stalactite",
  "crystal",
  "giant_mushroom",
  "root",
  "skull_pile",
  "candles",
]);
const CLUSTER_MEAN = 1.5;
const SATELLITE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [2, 0],
  [0, 2],
  [-2, 0],
  [0, -2],
];

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
  // Natural dressing added on 2026-11-19 scatters in clumps; older types keep the frozen generator-v1 stream.
  const clustered = CLUSTERED_TYPES.has(p.feature) || p.drift === true;
  const driftField = p.drift === true ? new ValueNoise(subSeed(p.seed, "scatter-drift")) : null;
  const crng = createPrng(subSeed(p.seed, "scatter-cluster"));

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

  const groundCarries = (cells: ReadonlyArray<readonly [number, number]>): boolean => {
    if (!grid.height) return true;
    const h0 = grid.height(cells[0]?.[0] ?? 0, cells[0]?.[1] ?? 0);
    for (const [x, y] of cells) {
      if (grid.height(x, y) !== h0) return false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!grid.inBounds(nx, ny)) continue;
          if ((grid.flags(nx, ny) & (FLAG_NO_FLOOR | FLAG_WATER)) !== 0) return false;
          if (grid.height(nx, ny) < h0 - 0.25) return false;
        }
    }
    return true;
  };

  for (const [cx, cy] of order) {
    // Draw every random number for every candidate so the stream does not depend on eligibility.
    const r = rng.next();
    const rotStep = rng.int(24);
    const variantIdx = p.variants && p.variants.length > 0 ? rng.int(p.variants.length) : -1;
    if (r >= (clustered ? p.density / (1 + CLUSTER_MEAN) : p.density)) continue;
    if (driftField) {
      const n = driftField.sample(cx / 6, cy / 6);
      // a third of the ground is a drift, the rest stays mostly clear
      if (n < 0.45 || (n < 0.55 && r * 3 > p.density)) continue;
    }
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
    if (p.supported === true && !groundCarries(cells)) continue;
    if (footprintCrossesWall(grid, [cx, cy], size)) continue;
    for (const [x, y] of cells) accept(x, y);
    const placement: GeneratedPlacement = { type: p.feature, at: [cx, cy], size, rot, rotFine };
    if (variantIdx >= 0 && p.variants) placement.variant = p.variants[variantIdx] as string;
    out.push(placement);
    if (clustered) addSatellites(cx, cy, size);
  }
  return { placements: out, capped };

  /** Clustered types: 1–2 more of the same type within two cells of the one just accepted (own PRNG stream). */
  function addSatellites(cx: number, cy: number, size: readonly [number, number]): void {
    const n = 1 + crng.int(2);
    const offs = crng.shuffle(SATELLITE_OFFSETS);
    let added = 0;
    for (const [dx, dy] of offs) {
      if (added >= n) break;
      if (out.length >= p.remaining) {
        capped = true;
        return;
      }
      const sx = cx + (dx > 0 ? dx + size[0] - 1 : dx);
      const sy = cy + (dy > 0 ? dy + size[1] - 1 : dy);
      const rotFine = info.organic && p.randomRotation ? crng.int(24) * 15 : 0;
      const rot = ((Math.round(rotFine / 90) % 4) * 90) as Rotation;
      const sz = rotatedSize(info.size, rot);
      const cells = footprintCells([sx, sy], sz);
      if (!cells.every(([x, y]) => cellOk(x, y) && !accepted.has(cellKey(x, y)))) continue;
      if (footprintCrossesWall(grid, [sx, sy], sz)) continue;
      for (const [x, y] of cells) accept(x, y);
      const sat: GeneratedPlacement = { type: p.feature, at: [sx, sy], size: sz, rot, rotFine };
      if (p.variants && p.variants.length > 0)
        sat.variant = p.variants[crng.int(p.variants.length)] as string;
      out.push(sat);
      added++;
    }
  }
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

/**
 * Preset table (generator v1; changing it changes generated maps, so treat it as frozen). The composed set pieces
 * (ritual_circle, overgrown, cavern, …) are not weighted tables: see ./setpieces.ts.
 */
export const DRESS_PRESET_TABLE: Record<Exclude<DressPreset, ComposedPreset>, readonly DressItem[]> = {
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
  /** Generator 4: the area is abandoned (ResolvedArea.abandoned, from gen/roomPurpose.ts classifyRoom). */
  abandoned?: boolean;
}

const SIDE_ROT: Record<Side, Rotation> = { N: 0, E: 90, S: 180, W: 270 };
/** Random candidates tried per dress item before it is dropped. */
const SAMPLE_TRIES = 24;

export function dressArea(grid: PlacementGrid, p: DressParams): ScatterResult {
  if (isComposedPreset(p.preset)) return composeArea(grid, { ...p, preset: p.preset });
  const gen = gridProfile(grid);
  // an interior preset dresses the room from its purpose's recipe (anchor, wall run, things on things, lights); a
  // theme without the pieces, or an area without walls, keeps the weighted scatter below
  if (gen.roomRecipes && grid.piece4 !== undefined) {
    const purpose = presetPurpose(p.preset);
    if (purpose !== undefined) {
      const res = dressRoom(grid, {
        purpose,
        // the preset says what the room is for; the room's own words may still say nobody keeps it up
        abandoned: ROOM_PURPOSE_INFO[purpose].abandoned || p.abandoned === true,
        areaIndex: p.areaIndex,
        areaCells: p.areaCells,
        density: p.density / 0.5,
        seed: p.seed,
        remaining: p.remaining,
      });
      if (res !== null) return res;
    }
  }
  const table = DRESS_PRESET_TABLE[p.preset];
  const rng = createPrng(subSeed(p.seed, "dress"));
  const cells = p.areaCells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const floorCells = cells.filter(([x, y]) => grid.isFloor(x, y));
  const count = Math.round((p.density * floorCells.length) / 6);
  const totalWeight = table.reduce((a, i) => a + i.weight, 0);
  const taken = new Set<number>();
  const oneHeight =(at: readonly [number, number], size: readonly [number, number]): boolean => {
    if (!grid.height) return true;
    const h0 = grid.height(at[0], at[1]);
    return footprintCells(at, size).every(([x, y]) => grid.height?.(x, y) === h0);
  };
  const out: GeneratedPlacement[] = [];
  let capped = false;

  const wallSides = (x: number, y: number): Side[] => SIDES.filter((s) => grid.edge(x, y, s) === EDGE_WALL);
  const atOpening = (x: number, y: number): boolean => SIDES.some((s) => grid.edge(x, y, s) === EDGE_OPENING);
  // generator 4: a blocking piece (rubble, a crate) keeps one more cell back from a doorway too: pieces are wider than
  // a cell, and one standing beside the cell in front of a door spills into it (verify_door_blocked)
  const nearOpening = (x: number, y: number): boolean =>
    atOpening(x, y) ||
    (gen.doorwaysKeepClear &&
      (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const
      ).some(([dx, dy]) => grid.inBounds(x + dx, y + dy) && atOpening(x + dx, y + dy)));
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
      !footprintCrossesWall(grid, c.at, c.size) &&
      // generator 3: furniture never stands half on a ledge (a counter over a one-tile step floats)
      (!gen.levelFootprints || oneHeight(c.at, c.size));
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
  if (gen.supportedParts) addToppers(grid, out, rng, p.remaining);
  return { placements: out, capped };
}

/**
 * Generator 3: small props rest on larger pieces (goods on a counter, candles on a table, a sack on a crate), at the
 * support's real top height (PlacementGrid.pieceExtent: the lowest variant's height, so nothing floats), instead of
 * standing on the floor beside it. In the studied market 95% of small props sat on furniture. Only where the theme has
 * both pieces; the support's own cell carries the topper.
 */
const TOPPERS: Partial<Record<FeatureType, { chance: number; on: ReadonlyArray<readonly [FeatureType, number]> }>> = {
  table: { chance: 0.8, on: [["candles", 3], ["sack", 1]] },
  round_table: { chance: 0.8, on: [["candles", 1]] },
  counter: { chance: 0.9, on: [["sack", 2], ["candles", 1]] },
  desk: { chance: 0.7, on: [["candles", 1]] },
  chest: { chance: 0.25, on: [["candles", 1]] },
};

function addToppers(
  grid: PlacementGrid,
  out: GeneratedPlacement[],
  rng: ReturnType<typeof createPrng>,
  remaining: number,
): void {
  const supports = out.slice();
  for (const s of supports) {
    const def = TOPPERS[s.type];
    if (!def) continue;
    if (out.length >= remaining || !rng.chance(def.chance)) continue;
    const ext = grid.pieceExtent?.(s.type);
    if (!ext) continue;
    const total = def.on.reduce((a, [, w]) => a + w, 0);
    let r = rng.next() * total;
    let type = def.on[0]?.[0] as FeatureType;
    for (const [t, w] of def.on) {
      r -= w;
      if (r < 0) {
        type = t;
        break;
      }
    }
    // the real piece is centred on its footprint (a 1-wide counter on a 3×1 footprint): rest on that centre, slid a
    // little, but inside the support's top
    const mx = s.at[0] + s.size[0] / 2;
    const my = s.at[1] + s.size[1] / 2;
    const cell: [number, number] = [Math.floor(mx), Math.floor(my)];
    const room = Math.max(0, Math.min(0.3, (Math.min(ext.w, ext.d, 1) - 0.4) / 2));
    const offset: [number, number] = [
      mx - (cell[0] + 0.5) + (rng.next() * 2 - 1) * room,
      my - (cell[1] + 0.5) + (rng.next() * 2 - 1) * room,
    ];
    out.push({
      type,
      at: cell,
      size: [1, 1],
      rot: 0,
      rotFine: rng.int(24) * 15,
      lift: ext.h,
      offset,
    });
  }
}
