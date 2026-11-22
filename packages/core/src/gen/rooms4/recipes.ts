/**
 * The room recipes of generator 4 (gen/rooms4/dress.ts dresses a room from them) and the measures a room is dressed
 * and lit by. One recipe per furnished purpose: the share of floor its furniture covers, and variants of an anchor list,
 * a wall list, a shelf plank and a rug, so sibling rooms of one purpose draw different ones.
 */
import type { FeatureType } from "../../contracts/plan";
import type { Prng } from "../../util/prng";
import type { FurnishedPurpose } from "../roomPurpose";
import type { SmallFamily } from "../surfaces";

/** The families of small things (gen/surfaces.ts: palette variant name = family, roles SMALL_THINGS_ROLES). */
export type Family = SmallFamily;

export interface Spec {
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

export interface Variant {
  anchors: readonly Spec[];
  wall: readonly Spec[];
  /** A shelf plank along one wall, carrying small things. */
  shelf?: boolean;
  rug?: boolean;
  /** Default family of the small things on tables and counters. */
  family: Family;
}

export interface Recipe {
  /** Share of the room's floor cells that furniture covers (the rest is lane and open floor). */
  fill: number;
  variants: readonly Variant[];
}

export const S = (type: FeatureType, weight: number, more: Omit<Spec, "type" | "weight"> = {}): Spec => ({
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
export const FILL_GAIN = 1.3;

/** The measures a room is dressed and lit by (tiles unless said). */
export const ROOM_DRESS = {
  /** Variants of one support whose heights differ by more than this take nothing on top (it would sink or float). */
  heightSpread: 0.15,
  /** A piece taller than this is tall: no shelf plank hangs over it, no torch in front of it. */
  tall: 1.1,
  /** The lowest wall a shelf plank hangs on, and a wall torch. */
  shelfWall: 1.75,
  torchWall: 1.5,
  /** Chance a support takes small things on its top, unless its SURFACE_LOAD row says another. */
  topChance: 0.94,
  /** A dark point with no wall nearer than this for a torch gets a floor light first. */
  torchReach: 3.2,
  /** Furniture whose top takes a light is lit when it stands within this of the dark point. */
  lampReach: 3.4,
  /** No cell farther than this from a light: a dressed room, and an area that only gets lights. */
  roomLightRadius: 3.6,
  areaLightRadius: 4.4,
  /** A lived-in place of this many floor tiles gets a floor light: a dressed room, and an area that only gets lights. */
  roomFloorLightCells: 30,
  areaFloorLightCells: 60,
} as const;

/** The small-things family a shelf plank carries. */
export const SHELF_FAMILY: Family = "shelf";

/** Height (tiles) of the top of the shelf plank above the floor; the palette's shelf_line variants lift to the same. */
export const SHELF_TOP = 1.66;

/** One spec of a weighted list, drawn by weight. */
export const pickSpec = (rng: Prng, list: readonly Spec[]): Spec | null => {
  const total = list.reduce((a, s) => a + s.weight, 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const s of list) {
    r -= s.weight;
    if (r < 0) return s;
  }
  return list[list.length - 1] ?? null;
};
