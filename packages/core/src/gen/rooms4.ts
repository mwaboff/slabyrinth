/**
 * Room recipes (generator 4). The owner admired a community interior and called ours "a plain hall and identical
 * cells". Measured like for like, our keep dungeon had 1.3 props per 10 floor tiles against 21, 40% of its furniture
 * near a wall against 92%, two props resting on other props against a third of them, six of thirteen rooms with no
 * light and 57% of the floor more than four tiles from one. This is the answer: a room is dressed from its purpose.
 *
 *   1. an anchor that names the purpose (a bed, a long table, a counter, a forge, an altar), on the wall away from the
 *      door, with its seats on the open side;
 *   2. wall furniture (corners first), the middle of the room and the way between doors left clear;
 *   3. small things ON the furniture (plates, books, tools, jars) and on a shelf plank along one wall, from the
 *      purpose's goods family;
 *   4. a rug where the purpose has one;
 *   5. lights: candles on the anchor, a lantern on a chest, wall torches, a brazier in a big room; every inhabited room
 *      has one, a dark abandoned room keeps one at most.
 *
 * Theme-neutral: everything is written in feature types (and clutter families), and each item is dropped where the
 * theme's palette has no piece for it (PlacementGrid.piece4). Rooms of one purpose draw different recipe variants
 * (PlacementGrid.roomMemory) and different seeded positions, so sibling rooms are never copies of each other.
 * Generator 4 only; the weighted tables of gen/place.ts stay frozen for the earlier generators.
 */
import type { FeatureType, Rotation, Side } from "../contracts/plan";
import { subSeed } from "../util/hash";
import { createPrng, type Prng } from "../util/prng";
import { featureInfo, rotatedSize } from "./catalog";
import type { GeneratedPlacement, PlacementGrid, ScatterResult } from "./place";
import { ROOM_PURPOSE_INFO, type FurnishedPurpose } from "./roomPurpose";
import {
  EDGE_OPENING,
  EDGE_STAIR,
  EDGE_WALL,
  FLAG_FEATURE,
  FLAG_LINK,
  FLAG_NO_FLOOR,
  FACE_ROT,
  INWARD,
  OPPOSITE,
  SIDES,
  SIDE_ROT,
  SIDE_STEP,
  cellKey,
  footprintCells,
  stepSide,
  wallFootprint,
  wallSides,
} from "./gridGeometry";
import { SURFACE_LOAD, surfaceCount, type SmallFamily, type SurfaceLoad } from "./surfaces";
import { isNaturalWallStyle } from "./wallStyles";

// ───────────────────────────── recipes ─────────────────────────────

/** The families of small things (gen/surfaces.ts: palette variant name = family, roles SMALL_THINGS_ROLES). */
export type Family = SmallFamily;

interface Spec {
  type: FeatureType;
  weight: number;
  /** Footprint [along the wall, into the room]; default the catalog size. */
  size?: readonly [number, number];
  /** n of them end to end along the wall (a bar, a run of shelves). */
  run?: number;
  /** Family of the small things stood on it (default by type and recipe). */
  top?: Family | "none";
  /** Seats on the open side, facing it. */
  seats?: { type: FeatureType; n: number };
  /** A second one stands on this one (crates). */
  stack?: boolean;
  /** Placed only in a corner. */
  corner?: boolean;
  /** Variant name of the piece. */
  variant?: string;
  /** At most this many in one room (a wardrobe may stand in for a bookshelf in a theme that has none). */
  max?: number;
}

interface Variant {
  anchors: readonly Spec[];
  wall: readonly Spec[];
  /** A shelf plank along one wall, carrying small things. */
  shelf?: boolean;
  rug?: boolean;
  /** Default family of the small things on tables and counters. */
  family: Family;
}

interface Recipe {
  /** Share of the room's floor cells that furniture covers (the rest is lane and open floor). */
  fill: number;
  variants: readonly Variant[];
}

const S = (type: FeatureType, weight: number, more: Omit<Spec, "type" | "weight"> = {}): Spec => ({
  type,
  weight,
  ...more,
});

export const ROOM_RECIPES_4: Readonly<Record<FurnishedPurpose, Recipe>> = {
  tavern: {
    fill: 0.3,
    variants: [
      {
        family: "table",
        shelf: true,
        anchors: [S("bar_counter", 1, { size: [1, 1], run: 3, top: "table" })],
        wall: [
          S("table", 4, { seats: { type: "stool", n: 2 } }),
          S("barrel", 3, { corner: true, top: "store" }),
          S("bench", 2),
          S("chest", 1),
          S("crate", 1, { corner: true }),
        ],
      },
      {
        family: "table",
        shelf: true,
        rug: true,
        anchors: [S("table", 1, { run: 2, seats: { type: "chair", n: 3 } })],
        wall: [
          S("table", 3, { seats: { type: "chair", n: 2 } }),
          S("bench", 3),
          S("barrel", 3, { corner: true, top: "store" }),
          S("candelabra", 1, { corner: true, variant: "candle" }),
        ],
      },
      {
        family: "table",
        anchors: [S("bar_counter", 1, { size: [1, 1], run: 2, top: "table" })],
        wall: [
          S("table", 4, { seats: { type: "stool", n: 3 } }),
          S("bench", 2),
          S("barrel", 4, { corner: true, top: "store" }),
        ],
        shelf: true,
      },
    ],
  },
  dining: {
    fill: 0.3,
    variants: [
      {
        family: "table",
        rug: true,
        anchors: [S("table", 1, { run: 2, seats: { type: "chair", n: 4 } })],
        wall: [
          S("bench", 3),
          S("table", 2, { seats: { type: "chair", n: 2 } }),
          S("brazier", 2, { corner: true }),
          S("chest", 1),
        ],
      },
      {
        family: "table",
        anchors: [S("table", 1, { run: 3, seats: { type: "stool", n: 4 } })],
        wall: [
          S("barrel", 3, { corner: true, top: "store" }),
          S("bench", 2),
          S("chest", 1),
          S("brazier", 1, { corner: true }),
        ],
        shelf: true,
      },
    ],
  },
  kitchen: {
    fill: 0.32,
    variants: [
      {
        family: "table",
        shelf: true,
        anchors: [S("counter", 1, { run: 2, top: "table" })],
        wall: [
          S("counter", 2, { top: "table" }),
          S("cauldron", 2, { max: 2 }),
          S("barrel", 3, { corner: true, top: "store" }),
          S("sack", 2, { corner: true }),
          S("crate", 1, { corner: true }),
        ],
      },
      {
        family: "table",
        shelf: true,
        anchors: [S("cauldron", 1), S("counter", 1, { run: 2, top: "table" })],
        wall: [
          S("table", 2, { top: "table" }),
          S("counter", 2, { top: "table" }),
          S("barrel", 3, { corner: true }),
          S("sack", 2, { corner: true }),
        ],
      },
    ],
  },
  library: {
    fill: 0.34,
    variants: [
      {
        family: "study",
        rug: true,
        anchors: [S("bookshelf", 1, { size: [1, 1], run: 3 })],
        wall: [
          S("bookshelf", 6, { size: [1, 1] }),
          S("desk", 2, { top: "study", seats: { type: "chair", n: 1 } }),
          S("chest", 1),
          S("candelabra", 1, { corner: true, variant: "candle" }),
        ],
      },
      {
        family: "study",
        anchors: [S("desk", 1, { top: "study", seats: { type: "chair", n: 1 } })],
        wall: [
          S("bookshelf", 5, { size: [1, 1] }),
          S("table", 2, { top: "study", seats: { type: "chair", n: 2 } }),
          S("chest", 1, { top: "study" }),
        ],
        rug: true,
      },
    ],
  },
  study: {
    fill: 0.26,
    variants: [
      {
        family: "study",
        rug: true,
        shelf: true,
        anchors: [S("desk", 1, { top: "study", seats: { type: "chair", n: 1 } })],
        wall: [S("bookshelf", 4, { size: [1, 1] }), S("chest", 2, { top: "study" }), S("armor_stand", 1)],
      },
      {
        family: "study",
        shelf: true,
        anchors: [S("table", 1, { top: "study", seats: { type: "chair", n: 2 } })],
        wall: [
          S("bookshelf", 3, { size: [1, 1] }),
          S("desk", 2, { top: "study" }),
          S("chest", 1),
          S("candelabra", 1, { corner: true, variant: "candle" }),
        ],
      },
    ],
  },
  armoury: {
    fill: 0.3,
    variants: [
      {
        family: "tools",
        anchors: [S("weapon_rack", 1, { run: 2 })],
        wall: [
          S("weapon_rack", 4),
          S("armor_stand", 4),
          S("chest", 2, { top: "tools" }),
          S("table", 1, { top: "tools" }),
          S("crate", 1, { corner: true }),
        ],
      },
      {
        family: "tools",
        shelf: true,
        anchors: [S("armor_stand", 1, { run: 2 })],
        wall: [
          S("weapon_rack", 3),
          S("table", 2, { top: "tools", seats: { type: "stool", n: 1 } }),
          S("barrel", 2, { corner: true }),
          S("chest", 1),
        ],
      },
    ],
  },
  barracks: {
    fill: 0.34,
    variants: [
      {
        family: "table",
        anchors: [S("table", 1, { seats: { type: "stool", n: 3 } })],
        wall: [
          S("bunk_bed", 5),
          S("chest", 3, { top: "table" }),
          S("weapon_rack", 2),
          S("armor_stand", 1),
          S("barrel", 1, { corner: true }),
        ],
      },
      {
        family: "tools",
        anchors: [S("weapon_rack", 1, { run: 2 })],
        wall: [
          S("bunk_bed", 4),
          S("table", 1, { seats: { type: "stool", n: 2 } }),
          S("chest", 2, { top: "table" }),
          S("barrel", 1, { corner: true }),
          S("crate", 1, { corner: true }),
        ],
        shelf: true,
      },
    ],
  },
  bedroom: {
    fill: 0.26,
    variants: [
      {
        family: "table",
        rug: true,
        anchors: [S("bed", 1)],
        wall: [
          S("chest", 3, { top: "table" }),
          S("wardrobe", 2, { max: 1 }),
          S("chair", 1),
          S("candelabra", 1, { corner: true, variant: "candle" }),
        ],
      },
      {
        family: "study",
        rug: true,
        shelf: true,
        anchors: [S("bed", 1, { run: 2 })],
        wall: [
          S("chest", 2, { top: "study" }),
          S("wardrobe", 2, { max: 1 }),
          S("desk", 1, { top: "study", seats: { type: "chair", n: 1 } }),
        ],
      },
    ],
  },
  storeroom: {
    fill: 0.42,
    variants: [
      {
        family: "store",
        shelf: true,
        anchors: [S("crate", 1, { run: 3, stack: true, variant: "small" })],
        wall: [
          S("crate", 3, { stack: true, variant: "small" }),
          S("barrel", 3, { top: "store" }),
          S("sack", 3, { corner: true }),
          S("crate", 2, { corner: true, top: "none" }),
          S("chest", 1),
          S("barrel", 3, { corner: true }),
        ],
      },
      {
        family: "store",
        shelf: true,
        anchors: [S("barrel", 1, { run: 3, top: "store" })],
        wall: [
          S("crate", 4, { stack: true, variant: "small" }),
          S("sack", 3),
          S("chest", 1, { top: "store" }),
          S("barrel", 2, { corner: true }),
        ],
      },
    ],
  },
  shrine: {
    fill: 0.3,
    variants: [
      {
        family: "table",
        rug: true,
        shelf: true,
        anchors: [S("altar", 1, { size: [3, 2], top: "none" })],
        wall: [
          S("statue", 2, { max: 1 }),
          S("candelabra", 2, { corner: true, variant: "candle" }),
          S("brazier", 1, { corner: true }),
          S("bench", 3),
        ],
      },
      {
        family: "table",
        anchors: [S("altar", 4, { size: [3, 2], top: "none" }), S("statue", 1)],
        wall: [
          S("candelabra", 3, { corner: true, variant: "candle" }),
          S("bench", 3),
          S("chest", 2, { top: "table" }),
        ],
        rug: true,
        shelf: true,
      },
    ],
  },
  crypt: {
    fill: 0.16,
    variants: [
      {
        family: "store",
        anchors: [S("sarcophagus", 1)],
        wall: [
          S("sarcophagus", 3),
          S("coffin", 1),
          S("bones", 2, { corner: true }),
          S("skull_pile", 1, { corner: true }),
          S("web", 2, { corner: true }),
        ],
      },
      {
        family: "store",
        anchors: [S("coffin", 1, { run: 2 })],
        wall: [
          S("sarcophagus", 2),
          S("skull_pile", 2, { corner: true }),
          S("bones", 2, { corner: true }),
          S("statue", 1),
        ],
      },
    ],
  },
  prison: {
    fill: 0.12,
    variants: [
      {
        family: "store",
        anchors: [S("bed", 1, { variant: "straw" })],
        wall: [
          S("bones", 2, { corner: true }),
          S("barrel", 1, { corner: true }),
          S("web", 1, { corner: true }),
        ],
      },
      {
        family: "store",
        anchors: [S("stocks", 1, { size: [2, 1] })],
        wall: [
          S("bones", 2, { corner: true }),
          S("skull_pile", 1, { corner: true }),
          S("debris", 2, { corner: true }),
        ],
      },
      {
        family: "store",
        anchors: [S("stool", 1)],
        wall: [
          S("skull_pile", 2, { corner: true }),
          S("web", 2, { corner: true }),
          S("debris", 1, { corner: true }),
        ],
      },
    ],
  },
  forge: {
    fill: 0.28,
    variants: [
      {
        family: "tools",
        anchors: [S("forge", 1)],
        wall: [
          S("anvil", 2, { top: "tools" }),
          S("weapon_rack", 2),
          S("barrel", 2, { corner: true }),
          S("crate", 1, { corner: true }),
          S("counter", 1, { top: "tools" }),
        ],
      },
      {
        family: "tools",
        shelf: true,
        anchors: [S("counter", 1, { run: 2, top: "tools" })],
        wall: [
          S("forge", 1, { max: 1 }),
          S("anvil", 2, { top: "tools" }),
          S("armor_stand", 1),
          S("barrel", 2, { corner: true }),
        ],
      },
    ],
  },
  laboratory: {
    fill: 0.3,
    variants: [
      {
        family: "shelf",
        shelf: true,
        anchors: [S("table", 1, { run: 2, top: "shelf", seats: { type: "stool", n: 2 } })],
        wall: [
          S("bookshelf", 3, { size: [1, 1] }),
          S("cauldron", 2),
          S("chest", 1, { top: "study" }),
          S("barrel", 1, { corner: true }),
        ],
      },
      {
        family: "shelf",
        shelf: true,
        anchors: [S("cauldron", 1), S("table", 1, { top: "shelf", seats: { type: "stool", n: 1 } })],
        wall: [
          S("bookshelf", 3, { size: [1, 1] }),
          S("table", 2, { top: "shelf" }),
          S("barrel", 1, { corner: true }),
          S("candelabra", 1, { corner: true, variant: "candle" }),
        ],
      },
    ],
  },
  treasury: {
    fill: 0.24,
    variants: [
      {
        family: "store",
        anchors: [S("chest", 1, { run: 3, top: "table" })],
        wall: [S("chest", 4, { corner: true }), S("statue", 1), S("armor_stand", 1)],
      },
      {
        family: "store",
        anchors: [S("statue", 1), S("chest", 3, { top: "table" })],
        wall: [S("chest", 3, { corner: true }), S("weapon_rack", 1), S("armor_stand", 1)],
      },
    ],
  },
  washroom: {
    fill: 0.26,
    variants: [
      {
        family: "store",
        shelf: true,
        anchors: [S("barrel", 1, { run: 2, top: "store" })],
        wall: [
          S("bench", 3),
          S("barrel", 2, { corner: true, top: "store" }),
          S("stool", 2),
          S("chest", 1, { top: "store" }),
        ],
      },
      {
        family: "store",
        anchors: [S("counter", 1, { top: "store" })],
        wall: [
          S("bench", 2),
          S("barrel", 3, { corner: true }),
          S("sack", 2, { corner: true }),
          S("stool", 1),
        ],
        shelf: true,
      },
    ],
  },
  throne_room: {
    fill: 0.18,
    variants: [
      {
        family: "table",
        rug: true,
        anchors: [S("throne", 1)],
        wall: [
          S("statue", 2, { max: 2 }),
          S("brazier", 2, { corner: true }),
          S("chest", 1),
          S("table", 1, { top: "table", seats: { type: "chair", n: 2 } }),
        ],
      },
    ],
  },
};

/**
 * Calibration: the recipes' `fill` shares are the furniture a room of that purpose wants; this gain brings the free
 * floor of an inhabited room to about half (the study's rooms: 16-75%, median 42%, lanes included).
 */
const FILL_GAIN = 1.3;

/** How many small things go on a support of each type, and its default family: the shared table (gen/surfaces.ts). */
const TOP = SURFACE_LOAD;

// ───────────────────────────── geometry helpers ─────────────────────────────

const ckey = cellKey;

/**
 * Where a piece stands in its footprint: pushed against the wall it backs onto (and the side wall in a corner) so its
 * back touches the wall and nothing of it reaches into the next cell. The generator-3 rule shifts every wall piece 0.45
 * off its wall, which leaves a piece half in the next row and overlapping what stands there. A wall strip hosted in
 * this very cell takes half of it. Null when the piece is too big for the room between its walls.
 */
function touchShift(
  grid: PlacementGrid,
  at: readonly [number, number],
  size: readonly [number, number],
  rot: number,
  ext: { wMax: number; dMax: number },
): [number, number] | null {
  const [x0, y0] = at;
  const [x1, y1] = [at[0] + size[0] - 1, at[1] + size[1] - 1];
  const swap = rot === 90 || rot === 270;
  // the largest variant of the role decides the fit (a smaller one then stands a little off the wall, never in it)
  const exX = swap ? ext.dMax : ext.wMax;
  const exY = swap ? ext.wMax : ext.dMax;
  const wall = (x: number, y: number, s: Side): { wall: boolean; hosted: boolean } => ({
    wall: grid.edge(x, y, s) === EDGE_WALL,
    hosted: grid.wallHosted?.(x, y, s) === true,
  });
  // the corner post where two walls meet takes the 0.5 square of the corner: a piece in a corner starts clear of it
  const axis = (
    n: number,
    lo: { wall: boolean; hosted: boolean },
    hi: { wall: boolean; hosted: boolean },
    ex: number,
    post: boolean,
  ): number | null => {
    const cLo = lo.wall && (lo.hosted || post) ? 0.5 : 0;
    const cHi = hi.wall && (hi.hosted || post) ? 0.5 : 0;
    if (ex > n - cLo - cHi + (post ? 0.15 : 0.06)) return null;
    if (lo.wall && !hi.wall) return cLo + ex / 2 - n / 2;
    if (hi.wall && !lo.wall) return n / 2 - cHi - ex / 2;
    if (lo.wall && hi.wall) return (cLo - cHi) / 2;
    return 0;
  };
  const anyOf = (
    cells: ReadonlyArray<readonly [number, number]>,
    s: Side,
  ): { wall: boolean; hosted: boolean } => {
    let wl = false;
    let ho = false;
    for (const [x, y] of cells) {
      const r = wall(x, y, s);
      if (r.wall) wl = true;
      if (r.wall && r.hosted) ho = true;
    }
    return { wall: wl, hosted: ho };
  };
  const col = (x: number): Array<[number, number]> =>
    Array.from({ length: size[1] }, (_, i) => [x, y0 + i] as [number, number]);
  const row = (y: number): Array<[number, number]> =>
    Array.from({ length: size[0] }, (_, i) => [x0 + i, y] as [number, number]);
  const wl = anyOf(col(x0), "W");
  const we = anyOf(col(x1), "E");
  const wn = anyOf(row(y0), "N");
  const ws = anyOf(row(y1), "S");
  const corner = (wl.wall || we.wall) && (wn.wall || ws.wall);
  // only the axis along the backing wall needs the corner clearance (the piece touches the backing wall itself)
  const alongX = rot === 0 || rot === 180;
  const ox = axis(size[0], wl, we, exX, corner && alongX);
  const oy = axis(size[1], wn, ws, exY, corner && !alongX);
  if (ox === null || oy === null) return null;
  const c = (v: number): number => Math.max(-0.5, Math.min(0.5, Math.round(v * 100) / 100));
  return [c(ox), c(oy)];
}

// ───────────────────────────── the room being dressed ─────────────────────────────

export interface RoomDressParams {
  purpose: FurnishedPurpose;
  abandoned: boolean;
  areaIndex: number;
  areaCells: Array<[number, number]>;
  /** 1 = the recipe's own density (a dress op's density / 0.5). */
  density: number;
  seed: number;
  remaining: number;
  /** Explicit features of the plan already in the area: an anchor of one of these types is not doubled. */
  have?: readonly FeatureType[];
}

interface Placed {
  type: FeatureType;
  at: [number, number];
  size: [number, number];
  centre: [number, number];
  side: Side;
  /** Family of the small things on it; "none" for none. */
  family: Family | "none";
  height: number;
  light: boolean;
  /** The variant the piece was placed as (a small crate), so its top height is the variant's. */
  variant?: string;
}

interface Cand {
  pieces: Array<{ at: [number, number]; size: [number, number]; shift: [number, number] }>;
  side: Side;
  rot: Rotation;
  corner: boolean;
  cells: Array<[number, number]>;
}

class Room {
  readonly rng: Prng;
  readonly out: GeneratedPlacement[] = [];
  readonly placed: Placed[] = [];
  readonly taken = new Set<number>();
  readonly used = new Set<number>();
  readonly inRoom = new Set<number>();
  readonly cells: Array<[number, number]> = [];
  readonly thresholds: Array<[number, number]> = [];
  readonly zone = new Set<number>();
  readonly wallPairs: Array<[number, number, Side]> = [];
  readonly cornerPairs = new Set<number>();
  /** Vertices of the room's inner corners (a corner post stands there). */
  readonly posts: Array<[number, number]> = [];

  /** Is the point within 0.9 of a corner post (0.5 square from the vertex, and the width of the thing, turned)? */
  nearPost(px: number, py: number): boolean {
    return this.posts.some(([vx, vy]) => Math.abs(px - vx) < 0.9 && Math.abs(py - vy) < 0.9);
  }
  readonly lights: Array<[number, number]> = [];
  centroid: [number, number] = [0, 0];
  entry: [number, number] = [0, 0];
  reach = new Set<number>();
  capped = false;
  blockCells = 0;

  constructor(
    readonly grid: PlacementGrid,
    readonly areaIndex: number,
    areaCells: ReadonlyArray<readonly [number, number]>,
    seed: number,
    readonly remaining: number,
  ) {
    this.rng = createPrng(subSeed(seed, "room4"));
    const sorted = areaCells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [x, y] of sorted) {
      if (!grid.inBounds(x, y) || grid.area(x, y) !== areaIndex || !grid.isFloor(x, y)) continue;
      if ((grid.flags(x, y) & (FLAG_LINK | FLAG_NO_FLOOR)) !== 0) continue;
      this.cells.push([x, y]);
      this.inRoom.add(ckey(x, y));
    }
    let sx = 0;
    let sy = 0;
    for (const [x, y] of this.cells) {
      sx += x + 0.5;
      sy += y + 0.5;
      const walls = wallSides(grid, x, y);
      for (const s of walls) this.wallPairs.push([x, y, s]);
      if (SIDES.some((s, i) => walls.includes(s) && walls.includes(SIDES[(i + 1) % 4] as Side)))
        this.cornerPairs.add(ckey(x, y));
      // the vertex of each inner corner: its post takes the 0.5 square beside it
      for (const v of ["N", "S"] as const)
        for (const h of ["W", "E"] as const)
          if (walls.includes(v) && walls.includes(h))
            this.posts.push([h === "E" ? x + 1 : x, v === "S" ? y + 1 : y]);
    }
    const n = Math.max(1, this.cells.length);
    this.centroid = [sx / n, sy / n];
    this.findThresholds();
    this.entry = this.thresholds.length > 0 ? this.meanOf(this.thresholds) : this.centroid;
    this.reach = this.walk(new Set());
    for (const [lx, ly] of grid.lightCells?.() ?? [])
      if (this.inRoom.has(ckey(lx, ly))) this.lights.push([lx, ly]);
  }

  private meanOf(list: ReadonlyArray<readonly [number, number]>): [number, number] {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of list) {
      sx += x + 0.5;
      sy += y + 0.5;
    }
    return [sx / list.length, sy / list.length];
  }

  /** Cells at the doors, flights of steps and open sides of the room; a cleared zone round each. */
  private findThresholds(): void {
    const g = this.grid;
    const seen = new Set<number>();
    for (const [x, y] of this.cells) {
      for (const s of SIDES) {
        const e = g.edge(x, y, s);
        const [nx, ny] = stepSide(x, y, s);
        let door = e === EDGE_OPENING || e === EDGE_STAIR;
        if (!door && e === 0 && g.inBounds(nx, ny) && !this.inRoom.has(ckey(nx, ny)))
          door = g.isFloor(nx, ny) || (g.flags(nx, ny) & FLAG_LINK) !== 0;
        if (
          !door &&
          g.inBounds(nx, ny) &&
          (g.flags(nx, ny) & FLAG_LINK) !== 0 &&
          !this.inRoom.has(ckey(nx, ny))
        )
          door = true;
        if (!door) continue;
        if (!seen.has(ckey(x, y))) {
          seen.add(ckey(x, y));
          this.thresholds.push([x, y]);
        }
        const inward = INWARD[s];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.zone.add(ckey(x + dx, y + dy));
        this.zone.add(ckey(x + inward[0] * 2, y + inward[1] * 2));
      }
    }
  }

  blocked(x: number, y: number): boolean {
    return this.taken.has(ckey(x, y)) || (this.grid.flags(x, y) & FLAG_FEATURE) !== 0;
  }

  /** The room cells reachable from its doors when `extra` is also blocked. */
  walk(extra: ReadonlySet<number>): Set<number> {
    const seen = new Set<number>();
    const queue: Array<[number, number]> = [];
    const open = (x: number, y: number): boolean =>
      this.inRoom.has(ckey(x, y)) && !this.blocked(x, y) && !extra.has(ckey(x, y));
    for (const [x, y] of this.thresholds)
      if (open(x, y) && !seen.has(ckey(x, y))) {
        seen.add(ckey(x, y));
        queue.push([x, y]);
      }
    if (queue.length === 0) {
      const first = this.cells.find(([x, y]) => open(x, y));
      if (first) {
        seen.add(ckey(first[0], first[1]));
        queue.push([first[0], first[1]]);
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = queue[h] as [number, number];
      for (const s of SIDES) {
        if (this.grid.edge(x, y, s) === EDGE_WALL) continue;
        const [nx, ny] = stepSide(x, y, s);
        if (!open(nx, ny) || seen.has(ckey(nx, ny))) continue;
        seen.add(ckey(nx, ny));
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  /** May these cells be blocked: every cell still reachable from the doors stays reachable. */
  keepsWay(cells: ReadonlyArray<readonly [number, number]>): Set<number> | null {
    const extra = new Set(cells.map(([x, y]) => ckey(x, y)));
    const after = this.walk(extra);
    let lost = 0;
    for (const k of this.reach) if (!after.has(k) && !extra.has(k)) lost++;
    return lost === 0 ? after : null;
  }

  free(x: number, y: number): boolean {
    const k = ckey(x, y);
    return this.inRoom.has(k) && !this.taken.has(k) && !this.used.has(k) && !this.grid.occupied(x, y);
  }

  oneHeight(cells: ReadonlyArray<readonly [number, number]>): boolean {
    const g = this.grid;
    if (!g.height || cells.length === 0) return true;
    const first = cells[0] as readonly [number, number];
    const h0 = g.height(first[0], first[1]);
    return cells.every(([x, y]) => g.height?.(x, y) === h0);
  }

  push(p: GeneratedPlacement): boolean {
    if (this.out.length >= this.remaining) {
      this.capped = true;
      return false;
    }
    this.out.push(p);
    return true;
  }

  has(type: FeatureType, variant?: string): boolean {
    return this.grid.piece4?.(type, variant) !== undefined;
  }

  /** Candidate wall-backed positions for a run of pieces of `base` size [along, depth]. */
  candidates(
    type: FeatureType,
    base: readonly [number, number],
    run: number,
    cornerOnly: boolean,
    variant?: string,
  ): Cand[] {
    const out: Cand[] = [];
    const blocking = featureInfo(type).blocking;
    const ext = this.grid.piece4?.(type, variant);
    for (const [x, y, s] of this.wallPairs) {
      const corner = this.cornerPairs.has(ckey(x, y));
      if (cornerOnly && !corner) continue;
      const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
      const total: [number, number] = [base[0] * run, base[1]];
      const rot = SIDE_ROT[s];
      const size = rotatedSize(total, rot);
      const at = wallFootprint(x, y, s, total);
      const cells = footprintCells(at, size);
      let ok = true;
      for (let i = 0; i < total[0] && ok; i++) {
        const ax = x + along[0] * i;
        const ay = y + along[1] * i;
        if (!this.inRoom.has(ckey(ax, ay)) || this.grid.edge(ax, ay, s) !== EDGE_WALL) ok = false;
      }
      if (!ok) continue;
      for (const [cx, cy] of cells) {
        if (!this.free(cx, cy) || (blocking && this.zone.has(ckey(cx, cy)))) {
          ok = false;
          break;
        }
      }
      if (!ok || !this.oneHeight(cells) || this.crossesWall(at, size)) continue;
      const pieces: Cand["pieces"] = [];
      for (let k = 0; k < run && ok; k++) {
        const sx = x + along[0] * k * base[0];
        const sy = y + along[1] * k * base[0];
        const pat = wallFootprint(sx, sy, s, base);
        const psize = rotatedSize(base, rot);
        // where it stands: against its wall(s), clear of the next cell; a piece too big for its walls is no candidate
        const shift: [number, number] | null =
          ext === undefined || ext.tile ? [0, 0] : touchShift(this.grid, pat, psize, rot, ext);
        if (shift === null) ok = false;
        else pieces.push({ at: pat, size: psize, shift });
      }
      if (!ok) continue;
      out.push({ pieces, side: s, rot, corner, cells });
    }
    return out;
  }

  crossesWall(at: readonly [number, number], size: readonly [number, number]): boolean {
    for (let y = at[1]; y < at[1] + size[1]; y++)
      for (let x = at[0]; x < at[0] + size[0]; x++) {
        if (x + 1 < at[0] + size[0] && this.grid.edge(x, y, "E") !== 0) return true;
        if (y + 1 < at[1] + size[1] && this.grid.edge(x, y, "S") !== 0) return true;
      }
    return false;
  }

  /** Is the cell on the wall side `s` close to a placed piece (a run of furniture along the wall). */
  nextToPlaced(c: Cand): boolean {
    return c.cells.some(([x, y]) => SIDES.some((s) => this.taken.has(ckey(...stepSide(x, y, s)))));
  }

  /** Choose and place one wall item of the spec; returns the pieces placed or null. */
  placeWall(spec: Spec, opts: { far?: boolean; family: Family }): Placed[] | null {
    // a crate that carries things is the small one (the large crate's top is a taller piece than the height we lift to)
    if (
      spec.type === "crate" &&
      spec.variant === undefined &&
      spec.top !== "none" &&
      this.has("crate", "small")
    )
      spec = { ...spec, variant: "small" };
    const info = featureInfo(spec.type);
    // a preferred variant the theme lacks (a straw bed, a small crate) gives way to the theme's own; stacking needs it
    if (spec.variant !== undefined && !this.has(spec.type, spec.variant)) {
      const alt: Spec = { ...spec, stack: false };
      delete alt.variant;
      return this.placeWall(alt, opts);
    }
    if (!this.has(spec.type, spec.variant)) return null;
    const base = spec.size ?? info.size;
    const run = spec.run ?? 1;
    const all = this.candidates(spec.type, base, run, spec.corner === true, spec.variant);
    if (all.length === 0) return null;
    const scored = all.map((c) => {
      const mid = this.meanOf(c.cells);
      const dEntry = Math.hypot(mid[0] - this.entry[0], mid[1] - this.entry[1]);
      let score = this.rng.next();
      if (opts.far === true) score += dEntry * 0.35;
      else {
        if (this.nextToPlaced(c)) score += 0.35;
        if (c.corner) score += spec.corner === true ? 0.6 : 0.25;
        if (dEntry < 3) score -= 0.3;
      }
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const pool = opts.far === true ? scored.slice(0, 4) : scored.slice(0, 7);
    for (const { c } of this.rng.shuffle(pool)) {
      const blocking = info.blocking && !info.wallMounted;
      let after: Set<number> | null = null;
      if (blocking) {
        after = this.keepsWay(c.cells);
        if (after === null) continue;
      }
      return this.commitCand(spec, c, opts.family, after);
    }
    return null;
  }

  commitCand(spec: Spec, c: Cand, family: Family, after: Set<number> | null): Placed[] | null {
    const info = featureInfo(spec.type);
    const placed: Placed[] = [];
    const ext = this.grid.piece4?.(spec.type, spec.variant);
    const variant = spec.variant;
    for (const pc of c.pieces) {
      // a tile (a bar counter block) stands exactly on its cell; a prop is pushed against the wall it backs onto
      const shift = pc.shift;
      const g: GeneratedPlacement = {
        type: spec.type,
        at: pc.at,
        size: pc.size,
        rot: c.rot,
        rotFine: c.rot,
      };
      // always explicit: the resolver's own 0.45 push off a wall must not apply to a piece placed exactly
      g.offset = shift;
      if (variant !== undefined) g.variant = variant;
      if (!this.push(g)) break;
      // a role whose variants are some tiles and some props has no one top height or centre: nothing stands on it
      const fam =
        ext?.mixed === true ? "none" : spec.top === undefined ? (TOP[spec.type]?.family ?? family) : spec.top;
      placed.push({
        type: spec.type,
        at: pc.at,
        size: pc.size,
        centre: [pc.at[0] + pc.size[0] / 2 + shift[0], pc.at[1] + pc.size[1] / 2 + shift[1]],
        side: c.side,
        family: fam,
        height: ext?.hMax ?? 1,
        light: false,
        ...(variant !== undefined ? { variant } : {}),
      });
    }
    if (placed.length === 0) return null;
    for (const [x, y] of c.cells) {
      if (info.blocking && !info.wallMounted) {
        this.taken.add(ckey(x, y));
        this.blockCells++;
      } else this.used.add(ckey(x, y));
    }
    if (after) this.reach = after;
    this.placed.push(...placed);
    return placed;
  }

  /** Seats for a run of pieces: `seat.n` in all, spread over them. */
  seat(pieces: readonly Placed[], seat: { type: FeatureType; n: number }): void {
    const each = Math.max(1, Math.ceil(seat.n / Math.max(1, pieces.length)));
    for (const pl of pieces) this.addSeats(pl, { type: seat.type, n: each });
  }

  /** Seats on the open side of a piece, facing it. */
  addSeats(p: Placed, seat: { type: FeatureType; n: number }): void {
    if (!this.has(seat.type)) return;
    const open = OPPOSITE[p.side];
    const cells: Array<[number, number]> = [];
    const [x0, y0] = p.at;
    const [w, h] = p.size;
    if (open === "S") for (let x = x0; x < x0 + w; x++) cells.push([x, y0 + h]);
    else if (open === "N") for (let x = x0; x < x0 + w; x++) cells.push([x, y0 - 1]);
    else if (open === "E") for (let y = y0; y < y0 + h; y++) cells.push([x0 + w, y]);
    else for (let y = y0; y < y0 + h; y++) cells.push([x0 - 1, y]);
    let placed = 0;
    for (const [x, y] of this.rng.shuffle(cells)) {
      if (placed >= seat.n) break;
      if (!this.free(x, y) || this.zone.has(ckey(x, y))) continue;
      if (this.grid.edge(x, y, p.side) === EDGE_WALL) continue;
      const after = this.keepsWay([[x, y]]);
      if (after === null) continue;
      const turn = FACE_ROT[p.side];
      const g: GeneratedPlacement = { type: seat.type, at: [x, y], size: [1, 1], rot: turn, rotFine: turn };
      const sext = this.grid.piece4?.(seat.type);
      const shift =
        sext && !sext.tile ? (touchShift(this.grid, [x, y], [1, 1], turn, sext) ?? [0, 0]) : [0, 0];
      g.offset = [shift[0] as number, shift[1] as number];
      if (!this.push(g)) return;
      this.taken.add(ckey(x, y));
      this.blockCells++;
      this.reach = after;
      this.placed.push({
        type: seat.type,
        at: [x, y],
        size: [1, 1],
        centre: [x + 0.5 + (shift[0] as number), y + 0.5 + (shift[1] as number)],
        side: p.side,
        family: "none",
        height: this.grid.piece4?.(seat.type)?.h ?? 0.5,
        light: false,
      });
      placed++;
    }
  }

  /** Small things on the top of a support, spread along its length, at its real top height. */
  addToppers(p: Placed, family: Family, rule: SurfaceLoad, stacked: boolean): void {
    const ext = this.grid.piece4?.(p.type, p.variant);
    if (!ext || ext.mixed) return;
    // variants of very different height (a large and a small crate): a thing lifted to one sinks into, or floats over, another
    if (ext.hMax - ext.h > 0.15) return;
    // a second crate on the first (things resting on things): the small crate again, at the small crate's top
    if (stacked && p.variant === "small") {
      const cx = clampTo(p.centre[0], p.at[0], p.size[0]);
      const cy = clampTo(p.centre[1], p.at[1], p.size[1]);
      if (this.grid.inBounds(cx, cy))
        this.push({
          type: p.type,
          at: [cx, cy],
          size: [1, 1],
          rot: 0,
          rotFine: this.rng.int(24) * 15,
          variant: "small",
          lift: ext.hMax,
          offset: [
            p.centre[0] - (cx + 0.5) + (this.rng.next() - 0.5) * 0.12,
            p.centre[1] - (cy + 0.5) + (this.rng.next() - 0.5) * 0.12,
          ],
        });
      return;
    }
    const fam = this.grid.piece4?.("clutter", family) ? family : null;
    if (fam === null) return;
    const n = surfaceCount(rule, (k) => this.rng.int(k));
    const alongX = p.size[0] >= p.size[1];
    const longReal = Math.max(ext.w, ext.d);
    const crossReal = Math.min(ext.w, ext.d);
    const avail = Math.max(0, Math.min(longReal, alongX ? p.size[0] : p.size[1]) - 0.4);
    const spread = Math.max(0, crossReal / 2 - 0.2);
    const tops: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? (this.rng.next() - 0.5) * Math.min(avail, 0.5) : (i / (n - 1) - 0.5) * avail;
      const c = (this.rng.next() * 2 - 1) * spread * 0.6;
      let px = p.centre[0] + (alongX ? t : c);
      let py = p.centre[1] + (alongX ? c : t);
      // a thing stands 0.31 clear of the wall behind its support (it has a width of its own)
      const hosted = this.grid.wallHosted?.(p.at[0], p.at[1], p.side) === true;
      const clear = (hosted ? 0.5 : 0) + 0.31;
      if (p.side === "N") py = Math.max(py, p.at[1] + clear);
      else if (p.side === "S") py = Math.min(py, p.at[1] + p.size[1] - clear);
      else if (p.side === "W") px = Math.max(px, p.at[0] + clear);
      else px = Math.min(px, p.at[0] + p.size[0] - clear);
      if (tops.some(([qx, qy]) => Math.hypot(qx - px, qy - py) < 0.26)) continue;
      // nothing stands in a corner post (some themes' posts are wider than they look)
      if (this.nearPost(px, py)) continue;
      tops.push([px, py]);
    }
    for (const [px, py] of tops) {
      // the cell is one of the support's own (the pieces may overhang it by a little)
      const cx = clampTo(px, p.at[0], p.size[0]);
      const cy = clampTo(py, p.at[1], p.size[1]);
      if (!this.grid.inBounds(cx, cy)) continue;
      const g: GeneratedPlacement = {
        type: "clutter",
        at: [cx, cy],
        size: [1, 1],
        rot: 0,
        rotFine: this.rng.int(24) * 15,
        variant: family,
        lift: ext.hMax,
        offset: [
          Math.max(-0.5, Math.min(0.5, px - (cx + 0.5))),
          Math.max(-0.5, Math.min(0.5, py - (cy + 0.5))),
        ],
      };
      if (!this.push(g)) return;
      this.used.add(ckey(cx, cy));
    }
  }

  /** A shelf plank along one stretch of wall with small things on it (the reference's built-in shelving). */
  addShelf(family: Family): void {
    const g = this.grid;
    if (!this.has("shelf_line") || !this.has("clutter", family)) return;
    // wall cells where a plank may hang: a tall wall, nothing tall beneath it, off the door zones
    const tallBelow = (x: number, y: number): boolean =>
      this.placed.some(
        (q) =>
          q.height > 1.1 &&
          x >= q.at[0] &&
          x < q.at[0] + q.size[0] &&
          y >= q.at[1] &&
          y < q.at[1] + q.size[1],
      );
    const mountable = (x: number, y: number, s: Side): boolean =>
      g.edge(x, y, s) === EDGE_WALL &&
      (g.wallHeight?.(x, y, s) ?? 2) >= 1.75 &&
      !isNaturalWallStyle(g.wallStyle?.(x, y, s)) &&
      !tallBelow(x, y) &&
      !this.hung.has(ckey(x, y) * 4 + SIDES.indexOf(s));
    const runs: Array<Array<[number, number, Side]>> = [];
    for (const s of SIDES) {
      const along: readonly [number, number] = s === "N" || s === "S" ? [1, 0] : [0, 1];
      const cells = this.cells
        .filter(([x, y]) => mountable(x, y, s))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const set = new Set(cells.map(([x, y]) => ckey(x, y)));
      for (const [x, y] of cells) {
        if (set.has(ckey(x - along[0], y - along[1]))) continue;
        const run: Array<[number, number, Side]> = [];
        for (let cx = x, cy = y; set.has(ckey(cx, cy)); cx += along[0], cy += along[1]) run.push([cx, cy, s]);
        if (run.length >= 3) runs.push(run);
      }
    }
    if (runs.length === 0) return;
    runs.sort((a, b) => b.length - a.length);
    const run = this.rng.pick(runs.slice(0, 2));
    const len = Math.min(run.length, 3 + this.rng.int(4));
    const start = this.rng.int(run.length - len + 1);
    for (const [x, y, s] of run.slice(start, start + len)) {
      const turn = SIDE_ROT[s];
      if (!this.push({ type: "shelf_line", at: [x, y], size: [1, 1], rot: turn, rotFine: turn, wall: s }))
        return;
      this.hung.add(ckey(x, y) * 4 + SIDES.indexOf(s));
      const hosted = g.wallHosted?.(x, y, s) ?? false;
      // the things stand against the wall on the plank (0.18 deep), 0.09 off its back face: over its middle
      const depth = (hosted ? 0.5 : 0) + 0.09;
      const toward = 0.5 - depth;
      const kinds = this.rng.chance(0.85) ? 1 + this.rng.int(2) : 0;
      for (let i = 0; i < kinds; i++) {
        const along = (this.rng.next() - 0.5) * 0.7;
        const [dx, dy] = SIDE_STEP[s];
        const ox = dx !== 0 ? dx * toward : along;
        const oy = dy !== 0 ? dy * toward : along;
        if (
          !this.push({
            type: "clutter",
            at: [x, y],
            size: [1, 1],
            rot: 0,
            rotFine: this.rng.int(24) * 15,
            variant: "shelf",
            lift: SHELF_TOP,
            offset: [ox, oy],
          })
        )
          return;
      }
    }
  }

  readonly hung = new Set<number>();

  /** A rug on a free 2×2 near the middle of the room (it blocks nothing). */
  addRug(): void {
    if (!this.has("rug")) return;
    let best: Array<[number, number]> = [];
    let bestD = Infinity;
    for (const [x, y] of this.cells) {
      const block = footprintCells([x, y], [2, 2]);
      if (!block.every(([cx, cy]) => this.free(cx, cy) && !this.zone.has(ckey(cx, cy)))) continue;
      if (this.crossesWall([x, y], [2, 2]) || !this.oneHeight(block)) continue;
      const d = Math.hypot(x + 1 - this.centroid[0], y + 1 - this.centroid[1]) + this.rng.next() * 0.9;
      if (d < bestD) {
        bestD = d;
        best = block;
      }
    }
    if (best.length === 0) return;
    const at = best[0] as [number, number];
    if (!this.push({ type: "rug", at, size: [2, 2], rot: 0, rotFine: 0 })) return;
    for (const [x, y] of best) this.used.add(ckey(x, y));
  }

  /**
   * Lights the room until every cell is within `radius` of a light and it has `target` lights. Each round finds the
   * darkest cell and lights it with the first of these that works: a flame on furniture near it (every second light),
   * a floor light when no wall is near enough for a torch, a wall torch, and a floor light after all.
   */
  light(opts: LightOpts): void {
    const torch = this.has("torch_wall");
    for (let guard = 0; guard < 40; guard++) {
      if (this.out.length >= this.remaining) {
        this.capped = true;
        return;
      }
      const dark = this.darkestCell();
      if (dark === null) return;
      if (this.lights.length >= opts.target && dark.dist <= opts.radius) return;
      const [wx, wy] = dark.at;
      let r: LightStep = "none";
      if (!opts.torchOnly && this.lights.length % 2 === 0) r = this.lampOnFurniture(wx, wy);
      if (r === "full") return;
      // the wall spot is chosen every round (its draw keeps the seeded sequence), used only if nothing is lit yet
      const wall = torch ? this.nearestTorchSpot(wx, wy) : null;
      if (r === "none" && (wall === null || wall.dist > 3.2)) r = this.floorLight(wx, wy, opts.floor);
      if (r === "none" && wall !== null) r = this.wallTorch(wall.at);
      if (r === "none") r = this.floorLight(wx, wy, opts.floor);
      if (r !== "lit") return;
    }
  }

  /** The cell farthest from every light (the one the next light must reach), and that distance. */
  private darkestCell(): { at: [number, number]; dist: number } | null {
    let worst: [number, number] | null = null;
    let worstD = -1;
    for (const [x, y] of this.cells) {
      let d = Infinity;
      for (const [lx, ly] of this.lights) d = Math.min(d, Math.hypot(lx - (x + 0.5), ly - (y + 0.5)));
      d += this.rng.next() * 0.01;
      if (d > worstD) {
        worstD = d;
        worst = [x, y];
      }
    }
    return worst === null ? null : { at: worst, dist: worstD };
  }

  /** A candle or a small lantern on the nearest piece of furniture within 3.4 of (wx, wy) whose top takes one. */
  private lampOnFurniture(wx: number, wy: number): LightStep {
    const near = (q: Placed): number => Math.hypot(q.centre[0] - wx, q.centre[1] - wy);
    const sups = this.placed
      .filter(
        (q) =>
          !q.light &&
          featureInfo(q.type).topLight !== undefined &&
          near(q) <= 3.4 &&
          !this.nearPost(q.centre[0], q.centre[1]),
      )
      .sort((a, b) => near(a) - near(b));
    for (const q of sups) {
      // a candle is the candles piece, a lantern the candelabra's lantern variant
      const lamp: FeatureType = featureInfo(q.type).topLight === "candle" ? "candles" : "candelabra";
      const variant = lamp === "candelabra" ? "lantern" : undefined;
      const ext = this.grid.piece4?.(q.type, q.variant);
      if (!ext || ext.mixed || ext.hMax - ext.h > 0.15 || !this.has(lamp, variant)) continue;
      const cx = clampTo(q.centre[0], q.at[0], q.size[0]);
      const cy = clampTo(q.centre[1], q.at[1], q.size[1]);
      const placement: GeneratedPlacement = {
        type: lamp,
        at: [cx, cy],
        size: [1, 1],
        rot: 0,
        rotFine: this.rng.int(24) * 15,
        lift: ext.hMax,
        offset: [
          q.centre[0] - (cx + 0.5) + (this.rng.next() - 0.5) * 0.3,
          q.centre[1] - (cy + 0.5) + (this.rng.next() - 0.5) * 0.3,
        ],
      };
      if (variant !== undefined) placement.variant = variant;
      if (!this.push(placement)) return "full";
      q.light = true;
      this.lights.push([cx, cy]);
      return "lit";
    }
    return "none";
  }

  /** May a wall torch hang on side `s` of (x, y): a tall wall, nothing hung there yet, nothing tall in front. */
  private torchFits(x: number, y: number, s: Side): boolean {
    const g = this.grid;
    if (g.edge(x, y, s) !== EDGE_WALL || (g.wallHeight?.(x, y, s) ?? 2) < 1.5) return false;
    const spot = ckey(x, y) * 4 + SIDES.indexOf(s);
    if (this.hung.has(spot) || this.torched.has(spot)) return false;
    if (g.occupied(x, y) && !this.taken.has(ckey(x, y))) return false;
    const under = this.placed.find(
      (q) =>
        x >= q.at[0] &&
        x < q.at[0] + q.size[0] &&
        y >= q.at[1] &&
        y < q.at[1] + q.size[1] &&
        q.type !== "clutter",
    );
    return under === undefined || under.height <= 1.1;
  }

  /** The wall spot for a torch nearest (wx, wy), door zones a little less welcome; with its distance. */
  private nearestTorchSpot(wx: number, wy: number): { at: [number, number, Side]; dist: number } | null {
    let best: [number, number, Side] | null = null;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (const [x, y, s] of this.wallPairs) {
      if (!this.torchFits(x, y, s)) continue;
      const d = Math.hypot(x - wx, y - wy);
      const sc = d + this.rng.next() * 0.6 + (this.zone.has(ckey(x, y)) ? 0.8 : 0);
      if (sc < bestScore) {
        bestScore = sc;
        bestDist = d;
        best = [x, y, s];
      }
    }
    return best === null ? null : { at: best, dist: bestDist };
  }

  /** A wall torch on the given spot. */
  private wallTorch([x, y, s]: [number, number, Side]): LightStep {
    const turn = SIDE_ROT[s];
    if (!this.push({ type: "torch_wall", at: [x, y], size: [1, 1], rot: turn, rotFine: turn, wall: s }))
      return "full";
    this.torched.add(ckey(x, y) * 4 + SIDES.indexOf(s));
    this.lights.push([x, y]);
    return "lit";
  }

  /**
   * A floor light within 3 of (wx, wy), for the middle of a big room a torch cannot reach: a brazier that keeps the way
   * clear, or, where fire does not belong (a library, a bedroom, a store), a stand of candles that blocks nothing.
   */
  private floorLight(wx: number, wy: number, kind: LightOpts["floor"]): LightStep {
    if (kind === null || !this.has(kind)) return "none";
    const near = ([x, y]: readonly [number, number]): number => Math.hypot(x - wx, y - wy);
    const spots = this.cells
      .filter((c) => this.free(c[0], c[1]) && !this.zone.has(ckey(c[0], c[1])) && near(c) <= 3)
      .sort((a, b) => near(a) - near(b));
    if (kind === "candles") {
      const at = spots[0];
      if (!at) return "none";
      const candles: GeneratedPlacement = {
        type: "candles",
        at: [at[0], at[1]],
        size: [1, 1],
        rot: 0,
        rotFine: this.rng.int(24) * 15,
      };
      if (!this.push(candles)) return "full";
      this.used.add(ckey(at[0], at[1]));
      this.lights.push([at[0], at[1]]);
      return "lit";
    }
    for (const [x, y] of spots.slice(0, 6)) {
      const after = this.keepsWay([[x, y]]);
      if (after === null) continue;
      const bext = this.grid.piece4?.("brazier");
      const shift = bext && !bext.tile ? (touchShift(this.grid, [x, y], [1, 1], 0, bext) ?? [0, 0]) : [0, 0];
      const bp: GeneratedPlacement = { type: "brazier", at: [x, y], size: [1, 1], rot: 0, rotFine: 0 };
      bp.offset = [shift[0] as number, shift[1] as number];
      if (!this.push(bp)) return "full";
      this.taken.add(ckey(x, y));
      this.blockCells++;
      this.reach = after;
      this.lights.push([x, y]);
      return "lit";
    }
    return "none";
  }

  readonly torched = new Set<number>();
}

/** What `Room.light` asks for. */
interface LightOpts {
  /** Lights the room wants (lightTarget). */
  target: number;
  /** No cell farther than this from a light (Infinity: an abandoned place keeps its dark pockets). */
  radius: number;
  /** Wall torches and floor lights only, nothing on the furniture. */
  torchOnly: boolean;
  /** The floor light of a big room, or none. */
  floor: "brazier" | "candles" | null;
}

/** One lighting step: it lit the cell, it found nowhere to, or the level's feature cap is reached (stop). */
type LightStep = "lit" | "none" | "full";

/** Height (tiles) of the top of the shelf plank above the floor; the palette's shelf_line variants lift to the same. */
export const SHELF_TOP = 1.66;

/** The cell of a support that holds a point, kept inside its footprint (a piece may overhang its cell a little). */
const clampTo = (v: number, lo: number, n: number): number =>
  Math.min(Math.max(Math.floor(v), lo), lo + n - 1);

const pickSpec = (rng: Prng, list: readonly Spec[]): Spec | null => {
  const total = list.reduce((a, s) => a + s.weight, 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const s of list) {
    r -= s.weight;
    if (r < 0) return s;
  }
  return list[list.length - 1] ?? null;
};

/** How many lights a room asks for: one per about 9 floor tiles when lived in, one per 50 (at least one) when not. */
export function lightTarget(floor: number, abandoned: boolean): number {
  if (abandoned) return floor >= 8 ? Math.max(1, Math.floor(floor / 50)) : 0;
  return floor >= 6 ? Math.max(1, Math.ceil(floor / 9)) : 0;
}

/**
 * Dress a room from the recipe of its purpose. Null when it cannot (the theme has no pieces to dress with, or the room
 * has no wall), so the caller keeps its other way.
 */
export function dressRoom(grid: PlacementGrid, p: RoomDressParams): ScatterResult | null {
  if (grid.piece4 === undefined) return null;
  const recipe = ROOM_RECIPES_4[p.purpose];
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining);
  if (room.cells.length < 4 || room.wallPairs.length === 0) return null;

  // the variant: one a sibling room of this purpose has not drawn, when there is one
  const used = grid.roomMemory?.get(p.purpose) ?? [];
  const free = recipe.variants.map((_, i) => i).filter((i) => !used.includes(i));
  const pool = free.length > 0 ? free : recipe.variants.map((_, i) => i);
  const vi = room.rng.pick(pool);
  grid.roomMemory?.set(p.purpose, [...used, vi]);
  const variant = recipe.variants[vi] as Variant;

  const n = room.cells.length;
  const maxBlock = Math.max(
    2,
    Math.round(n * recipe.fill * FILL_GAIN * Math.min(2, Math.max(0.2, p.density))),
  );
  const have = new Set(p.have ?? []);

  // 1. the anchor, on the wall away from the door
  const anchors = variant.anchors
    .map((a) => ({ a, k: a.weight * (0.4 + room.rng.next()) }))
    .sort((x, y) => y.k - x.k)
    .map((e) => e.a)
    .filter((a) => !have.has(a.type));
  for (const a of anchors) {
    const placed = room.placeWall(a, { far: true, family: variant.family });
    if (placed) {
      if (a.seats) room.seat(placed, a.seats);
      break;
    }
  }
  // 2. the wall run: furniture along the walls, corners first, the middle left clear
  let fails = 0;
  let guard = 0;
  const counts = new Map<Spec, number>();
  while (room.blockCells < maxBlock && fails < 18 && guard++ < 80) {
    const spec = pickSpec(room.rng, variant.wall);
    if (spec === null) break;
    if (spec.max !== undefined && (counts.get(spec) ?? 0) >= spec.max) {
      fails++;
      continue;
    }
    const placed = room.placeWall(spec, { family: variant.family });
    if (!placed) {
      fails++;
      continue;
    }
    counts.set(spec, (counts.get(spec) ?? 0) + 1);
    if (spec.seats) room.seat(placed, spec.seats);
  }

  // 3. things on the furniture
  for (const q of room.placed.slice()) {
    const rule = TOP[q.type];
    if (!rule || q.family === "none") continue;
    const spec = [...variant.anchors, ...variant.wall].find((s) => s.type === q.type);
    if (room.rng.chance(q.type === "chest" ? 0.8 : 0.94))
      room.addToppers(q, q.family, rule, spec?.stack === true && room.rng.chance(0.7));
  }
  if (variant.shelf === true) room.addShelf("shelf");

  // 4. a rug
  if (variant.rug === true) room.addRug();

  // 5. lights
  const floor = room.cells.length;
  room.light({
    target: lightTarget(floor, p.abandoned),
    // an abandoned place keeps its dark pockets: one light, then no more
    radius: p.abandoned ? Infinity : 3.6,
    torchOnly: p.abandoned,
    floor: floor >= 30 && !p.abandoned ? (ROOM_PURPOSE_INFO[p.purpose].noFire ? "candles" : "brazier") : null,
  });
  return { placements: room.out, capped: room.capped };
}

/**
 * Lights only: a room or passage nobody dressed (no purpose in its words, or the plan furnished it itself) still gets
 * its torches. Abandoned places keep one, a lived-in one about one per 12 floor tiles, a passage one per 18.
 */
export function lightArea(
  grid: PlacementGrid,
  p: {
    areaIndex: number;
    areaCells: Array<[number, number]>;
    seed: number;
    remaining: number;
    every: number;
    abandoned: boolean;
  },
): ScatterResult {
  const room = new Room(grid, p.areaIndex, p.areaCells, p.seed, p.remaining);
  const n = room.cells.length;
  if (n < 6 || grid.piece4 === undefined) return { placements: [], capped: false };
  const target = p.abandoned ? (n >= 8 ? 1 : 0) : Math.max(1, Math.ceil(n / p.every));
  room.light({
    target,
    radius: p.abandoned ? Infinity : 4.4,
    torchOnly: true,
    floor: n >= 60 && !p.abandoned ? "brazier" : null,
  });
  return { placements: room.out, capped: room.capped };
}
