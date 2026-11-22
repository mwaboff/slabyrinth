/**
 * The room-kind table (generator 5, switches `roomKinds`, `companionGroups`, `occupancyLights`): one row per kind of
 * room a generator-5 room is furnished as (every furnished purpose and the new kinds of gen/roomPurpose.ts), with what
 * skilled builders put in such a room, as general rules that hold in any theme (a tavern, a guardroom, a cave camp, a
 * crew room). The numbers are the aggregates measured on the training builds (docs: the room-purpose table).
 *
 * Columns:
 *   host       the contract purpose written on the resolved area (a new kind's nearest purpose);
 *   layout     how the room is laid out: along its walls, floor groups (tables in the middle), station rows (desks,
 *              beds, stalls in a row), a work line (an ordered wall of equipment) or a store aisle;
 *   groups     the anchor groups, in order (a sibling room of the kind draws another first): the anchor object, the rule
 *              that places it, and its companions (where, how far, facing what, how many);
 *   lining     what lines the walls (weighted; an item may bring companions of its own: a bunk its chest);
 *   family     the small things on its surfaces; `shelf` a shelf plank of them on one wall;
 *   rug        a rug under the group;
 *   lights     lights per 10 floor tiles (low, high), a light on every seat-bearing surface, a light either side of the
 *              main door;
 *   props10    props per 10 floor tiles (low, high): the dresser stops at the high end; `fill` the floor share of
 *              blocking furniture;
 *   minimum    the minimum convincing set: the names of the pieces (the anchor, companions, "light") a room of the kind
 *              must show to read as its kind; a room too small for the whole group gets these first;
 *   nearWall   share of blockers within a tile of a wall (low, high), and `clear` the floor share not under a blocker:
 *              what the review by purpose (package B) and the floor groups (package D) read, through `roomTargets`.
 *
 * Pieces are feature types with stand-ins tried in order where the palettes have no role for the thing (a nightstand
 * is a small crate, then a chest, then a stool); a companion the theme has no piece for is left out, never replaced
 * by a wrong one.
 */
import type { FeatureType } from "../contracts/plan";
import { NEW_KIND_INFO, type FurnishedPurpose, type NewRoomKind, type RoomKind } from "./roomPurpose";
import type { Family, Spec } from "./rooms4/recipes";

/** A piece a slot may take: a feature type and a preferred variant. */
export interface PieceChoice {
  readonly type: FeatureType;
  readonly variant?: string;
}

/**
 * Where the anchor stands:
 *   facingDoor  against the wall facing the main door, 3-7 tiles from it where the room allows (in view of the entrance);
 *   farWall     against a wall far from the door (private anchors: a bed, a forge, a sarcophagus);
 *   window      against a wall with a window (a desk under the light), else as farWall; never a tall piece;
 *   free        free-standing parallel to the wall facing the door, its back side a staff lane (a bar, a shop counter),
 *               else as facingDoor;
 *   axis        free-standing on the room's long axis with a tile clear all round (a dining table, a chart table),
 *               else as farWall.
 */
export type AnchorPlace = "facingDoor" | "farWall" | "window" | "free" | "axis";

/**
 * Where a companion stands, in the anchor's frame (its back to a wall or to the staff lane, its face toward the room):
 *   head        beside the anchor at its back end (a nightstand at a bed's head), one each side at most;
 *   front       along the anchor's open face (stools at a bar, the chair at a desk, the chest at a bed's foot);
 *   back        along its back face, when it stands free (the visitor's chair across a desk, a seat behind a counter);
 *   wallBehind  against the wall behind a free-standing anchor, across its staff lane (a bar's back store);
 *   flank       at the front corners, turned toward the anchor (seats angled at a fire, a statue either side).
 */
export type CompanionSlot = "head" | "front" | "back" | "wallBehind" | "flank";

/** Which way a companion faces: toward the anchor, the way the anchor faces, or away from it. */
export type Facing = "anchor" | "same" | "away";

export interface Companion {
  /** What it is in the group (the minimum set names it). */
  readonly name: string;
  /** The pieces it may be, in order; the first the theme has. */
  readonly pieces: readonly PieceChoice[];
  readonly slot: CompanionSlot;
  /** The clear gap in tiles between the anchor's outline and the companion's (0 = touching). */
  readonly gap: number;
  readonly facing: Facing;
  /** How many: a count, or one per tile of the anchor's face ("perTile": stools along a counter at a pitch of 1). */
  readonly count: number | "perTile";
  /** A light on its top (a nightstand's candle). */
  readonly light?: boolean;
  /** The small things on its top; none by default. */
  readonly top?: Family;
  /** Share of groups that get it (a chest by one bunk in three); always by default. */
  readonly chance?: number;
}

export interface GroupSpec {
  /** What the anchor is (the minimum set names it). */
  readonly name: string;
  readonly anchor: Spec;
  readonly place: AnchorPlace;
  readonly companions: readonly Companion[];
  /** A light on the anchor's top, one per two tiles of a run (a desk lamp, candles along a bar). */
  readonly light?: boolean;
  /** Rows kept clear in front of the group's face (standing room at a seat; a tile before a fire). */
  readonly keep: number;
}

/** A wall-lining item: a spec, with companions of its own when it is a station (a bunk and its chest). */
export interface LiningSpec extends Spec {
  readonly companions?: readonly Companion[];
  readonly light?: boolean;
}

export type RoomLayout = "wall" | "floorGroups" | "stationRows" | "workLine" | "storeAisle";

export interface RoomTraits {
  readonly host: FurnishedPurpose;
  readonly layout: RoomLayout;
  readonly groups: readonly [GroupSpec, ...GroupSpec[]];
  readonly lining: readonly LiningSpec[];
  readonly family: Family;
  readonly shelf: boolean;
  readonly rug: boolean;
  readonly lights: {
    readonly per10: readonly [number, number];
    /** A light on every seat-bearing surface (table, desk, nightstand, bar segment). */
    readonly onSurfaces: boolean;
    /** A light either side of the room's main door (a shared room). */
    readonly doorPair: boolean;
  };
  readonly props10: readonly [number, number];
  readonly fill: number;
  readonly minimum: readonly string[];
  readonly nearWall: readonly [number, number];
  readonly clear: readonly [number, number];
}

// ───────────────────────────── pieces and their stand-ins ─────────────────────────────

const P = (type: FeatureType, variant?: string): PieceChoice =>
  variant === undefined ? { type } : { type, variant };

/** No palette has a nightstand: a small crate, a chest, then a stool stands beside the bed. */
const NIGHTSTAND = [P("crate", "small"), P("chest"), P("stool")];
const STOOL = [P("stool"), P("chair")];
const CHAIR = [P("chair"), P("stool")];
const CHEST = [P("chest"), P("crate", "small")];
const STORE = [P("barrel"), P("crate")];
const SHELVES = [P("bookshelf"), P("wardrobe")];
/** No palette has a bucket: a barrel stands in (a tub, a water butt). */
const BUCKET = [P("barrel")];
const CANDLESTAND = [P("candelabra", "candle")];
const STATUE = [P("statue")];
const BRAZIER = [P("brazier")];

const S = (
  type: FeatureType,
  weight: number,
  more: Omit<LiningSpec, "type" | "weight"> = {},
): LiningSpec => ({
  type,
  weight,
  ...more,
});

const C = (
  name: string,
  pieces: readonly PieceChoice[],
  slot: CompanionSlot,
  more: Partial<Omit<Companion, "name" | "pieces" | "slot">> = {},
): Companion => ({ name, pieces, slot, gap: 0.2, facing: "anchor", count: 1, ...more });

const G = (
  name: string,
  anchor: Spec,
  place: AnchorPlace,
  companions: readonly Companion[],
  more: { light?: boolean; keep?: number } = {},
): GroupSpec => ({
  name,
  anchor,
  place,
  companions,
  keep: more.keep ?? 1,
  ...(more.light ? { light: true } : {}),
});

const A = (type: FeatureType, more: Omit<Spec, "type" | "weight"> = {}): Spec => ({
  type,
  weight: 1,
  ...more,
});

/** Seats along an anchor's face, facing it (a desk chair, stools at a bar), at a small gap. */
const seatsFront = (name: string, pieces: readonly PieceChoice[], gap: number): Companion =>
  C(name, pieces, "front", { gap, count: "perTile" });

// ───────────────────────────── the table ─────────────────────────────

export const ROOM_TRAITS: Readonly<Record<RoomKind, RoomTraits>> = {
  tavern: {
    host: "tavern",
    layout: "floorGroups",
    groups: [
      // the bar: a counter free of the wall, facing the door, stools on the public face, the back store behind
      G(
        "counter",
        A("bar_counter", { size: [1, 1], run: 3, top: "table" }),
        "free",
        [
          seatsFront("stool", STOOL, 0.25),
          C("back store", STORE, "wallBehind", { facing: "away", count: 2, top: "store" }),
        ],
        { light: true },
      ),
      G(
        "counter",
        A("bar_counter", { size: [1, 1], run: 2, top: "table" }),
        "facingDoor",
        [seatsFront("stool", STOOL, 0.25), C("back store", STORE, "head", { facing: "same", top: "store" })],
        { light: true },
      ),
    ],
    lining: [
      S("table", 4, { companions: [seatsFront("seat", CHAIR, 0.2)], light: true }),
      S("barrel", 3, { corner: true, top: "store" }),
      S("bench", 2),
      S("chest", 1),
    ],
    family: "table",
    shelf: true,
    rug: false,
    lights: { per10: [3.5, 4.7], onSurfaces: true, doorPair: true },
    props10: [25, 35],
    fill: 0.3,
    minimum: ["counter", "stool", "light"],
    nearWall: [0.6, 0.75],
    clear: [0.54, 0.68],
  },
  dining: {
    host: "dining",
    layout: "floorGroups",
    groups: [
      G(
        "table",
        A("table", { run: 2, top: "table" }),
        "axis",
        [seatsFront("chair", CHAIR, 0.2), C("chair", CHAIR, "back", { count: "perTile" })],
        { light: true },
      ),
      G("table", A("table", { run: 2, top: "table" }), "farWall", [seatsFront("chair", STOOL, 0.2)], {
        light: true,
      }),
    ],
    lining: [
      S("bench", 3),
      S("barrel", 2, { corner: true, top: "store" }),
      S("chest", 1),
      S("brazier", 1, { corner: true }),
    ],
    family: "table",
    shelf: true,
    rug: true,
    lights: { per10: [2, 3], onSurfaces: true, doorPair: true },
    props10: [20, 25],
    fill: 0.3,
    minimum: ["table", "chair", "light"],
    nearWall: [0.5, 0.75],
    clear: [0.47, 0.7],
  },
  kitchen: {
    host: "kitchen",
    layout: "workLine",
    groups: [
      // the heat on a wall with a counter either side of it along the same wall
      G("heat", A("cauldron"), "farWall", [
        C("counter", [P("counter"), P("table")], "head", { facing: "same", count: 2, top: "table", gap: 0 }),
      ]),
      G("heat", A("cauldron"), "facingDoor", [
        C("counter", [P("counter"), P("table")], "head", { facing: "same", count: 1, top: "table", gap: 0 }),
        C("water", BUCKET, "head", { facing: "same", count: 1, gap: 0 }),
      ]),
    ],
    lining: [
      S("counter", 3, { top: "table" }),
      S("barrel", 3, { corner: true, top: "store" }),
      S("sack", 2, { corner: true }),
      S("crate", 1, { corner: true }),
      S("table", 1, { top: "table" }),
    ],
    family: "table",
    shelf: true,
    rug: false,
    lights: { per10: [1, 2], onSurfaces: false, doorPair: false },
    props10: [50, 75],
    fill: 0.45,
    minimum: ["heat", "counter", "light"],
    nearWall: [0.9, 1],
    clear: [0.4, 0.63],
  },
  library: {
    host: "library",
    layout: "wall",
    groups: [
      G(
        "desk",
        A("desk", { top: "study" }),
        "window",
        [seatsFront("chair", CHAIR, 0.2), C("shelves", SHELVES, "head", { facing: "same", gap: 0.1 })],
        { light: true },
      ),
      G("shelves", A("bookshelf", { size: [1, 1], run: 3 }), "farWall", [
        C("chair", CHAIR, "front", { gap: 0.6 }),
      ]),
    ],
    lining: [
      S("bookshelf", 6, { size: [1, 1] }),
      S("desk", 2, { top: "study", companions: [seatsFront("chair", CHAIR, 0.2)], light: true }),
      S("chest", 1),
    ],
    family: "study",
    shelf: false,
    rug: true,
    lights: { per10: [1.5, 3.6], onSurfaces: true, doorPair: false },
    props10: [15, 25],
    fill: 0.34,
    minimum: ["desk", "chair", "light"],
    nearWall: [0.85, 1],
    clear: [0.6, 0.68],
  },
  study: {
    host: "study",
    layout: "wall",
    groups: [
      G(
        "desk",
        A("desk", { top: "study" }),
        "window",
        [
          seatsFront("chair", CHAIR, 0.2),
          C("shelves", SHELVES, "head", { facing: "same", gap: 0.1 }),
          C("visitor chair", CHAIR, "back", { gap: 0.3 }),
        ],
        { light: true },
      ),
      G(
        "desk",
        A("table", { top: "study" }),
        "farWall",
        [seatsFront("chair", CHAIR, 0.2), C("chest", CHEST, "head", { facing: "same", top: "study" })],
        { light: true },
      ),
    ],
    lining: [S("bookshelf", 4, { size: [1, 1] }), S("chest", 2, { top: "study" }), S("armor_stand", 1)],
    family: "study",
    shelf: true,
    rug: true,
    lights: { per10: [1, 2], onSurfaces: true, doorPair: false },
    props10: [15, 25],
    fill: 0.26,
    minimum: ["desk", "chair", "light"],
    nearWall: [0.85, 1],
    clear: [0.6, 0.68],
  },
  armoury: {
    host: "armoury",
    layout: "wall",
    groups: [
      G("rack", A("weapon_rack", { run: 2 }), "facingDoor", [
        C("chest", CHEST, "front", { gap: 0.1, facing: "same", top: "tools" }),
      ]),
      G("rack", A("armor_stand", { run: 2 }), "farWall", [
        C("bench", STOOL, "head", { facing: "same", gap: 0.1 }),
      ]),
    ],
    lining: [
      S("weapon_rack", 4),
      S("armor_stand", 4),
      S("chest", 2, { top: "tools" }),
      S("crate", 1, { corner: true }),
    ],
    family: "tools",
    shelf: true,
    rug: false,
    lights: { per10: [0.5, 1], onSurfaces: false, doorPair: false },
    props10: [10, 25],
    fill: 0.3,
    minimum: ["rack", "chest"],
    nearWall: [1, 1],
    clear: [0.4, 0.6],
  },
  barracks: {
    host: "barracks",
    layout: "stationRows",
    groups: [
      G("bunk", A("bunk_bed"), "farWall", [
        C("chest", CHEST, "front", { gap: 0.2, facing: "same", top: "table" }),
        C("lamp", NIGHTSTAND, "head", { light: true, gap: 0.1, facing: "same" }),
      ]),
      G("table", A("table", { top: "table" }), "facingDoor", [seatsFront("stool", STOOL, 0.25)], {
        light: true,
      }),
    ],
    lining: [
      S("bunk_bed", 5, {
        companions: [C("chest", CHEST, "front", { gap: 0.2, facing: "same", chance: 0.4 })],
      }),
      S("weapon_rack", 2),
      S("armor_stand", 1),
      S("barrel", 1, { corner: true }),
    ],
    family: "table",
    shelf: false,
    rug: false,
    lights: { per10: [0.6, 1.2], onSurfaces: true, doorPair: false },
    props10: [6, 15],
    fill: 0.34,
    minimum: ["bunk", "chest", "light"],
    nearWall: [0.7, 1],
    clear: [0.39, 0.5],
  },
  bedroom: {
    host: "bedroom",
    layout: "wall",
    groups: [
      // a single bed: head to the wall, a nightstand touching its head with a light, a chest at its foot
      G("bed", A("bed"), "farWall", [
        C("nightstand", NIGHTSTAND, "head", { gap: 0.1, facing: "same", light: true }),
        C("chest", CHEST, "front", { gap: 0.2, facing: "same", top: "table" }),
      ]),
      // a double: a nightstand each side
      G("bed", A("bed", { run: 2 }), "farWall", [
        C("nightstand", NIGHTSTAND, "head", { gap: 0.1, facing: "same", light: true, count: 2 }),
        C("chest", CHEST, "front", { gap: 0.2, facing: "same", top: "study" }),
      ]),
    ],
    lining: [
      S("wardrobe", 2, { max: 1, corner: true }),
      S("chest", 1, { top: "table" }),
      S("desk", 1, { top: "study", companions: [seatsFront("chair", CHAIR, 0.2)], light: true }),
      S("chair", 1),
    ],
    family: "table",
    shelf: true,
    rug: true,
    lights: { per10: [2, 3], onSurfaces: true, doorPair: false },
    props10: [25, 30],
    fill: 0.26,
    minimum: ["bed", "nightstand", "light"],
    nearWall: [0.85, 1],
    clear: [0.39, 0.5],
  },
  storeroom: {
    host: "storeroom",
    layout: "storeAisle",
    groups: [
      G("stack", A("crate", { run: 3, stack: true, variant: "small" }), "farWall", [
        C("barrel", STORE, "head", { facing: "same", gap: 0, count: 2, top: "store" }),
      ]),
      G("barrels", A("barrel", { run: 3, top: "store" }), "farWall", [
        C("sack", [P("sack"), P("crate")], "head", { facing: "same", gap: 0, count: 2 }),
      ]),
    ],
    lining: [
      S("crate", 3, { stack: true, variant: "small" }),
      S("barrel", 3, { top: "store" }),
      S("sack", 3, { corner: true }),
      S("chest", 1),
    ],
    family: "store",
    shelf: true,
    rug: false,
    lights: { per10: [0.5, 1], onSurfaces: false, doorPair: false },
    props10: [10, 22],
    fill: 0.42,
    minimum: ["stack", "barrel"],
    nearWall: [0.85, 1],
    clear: [0.3, 0.55],
  },
  shrine: {
    host: "shrine",
    layout: "wall",
    groups: [
      G("altar", A("altar", { size: [3, 2], top: "none" }), "facingDoor", [
        C("candles", CANDLESTAND, "head", { facing: "same", gap: 0.1, count: 2 }),
      ]),
      G("altar", A("altar", { size: [3, 2], top: "none" }), "farWall", [
        C("statue", STATUE, "head", { facing: "same", gap: 0.1, count: 2 }),
      ]),
    ],
    lining: [
      S("bench", 3),
      S("candelabra", 2, { corner: true, variant: "candle" }),
      S("statue", 1, { max: 1 }),
      S("chest", 1, { top: "table" }),
    ],
    family: "table",
    shelf: true,
    rug: true,
    lights: { per10: [1.5, 3], onSurfaces: false, doorPair: true },
    props10: [10, 20],
    fill: 0.3,
    minimum: ["altar", "candles"],
    nearWall: [0.6, 0.9],
    clear: [0.5, 0.7],
  },
  crypt: {
    host: "crypt",
    layout: "wall",
    groups: [
      G("sarcophagus", A("sarcophagus"), "farWall", []),
      G("coffin", A("coffin", { run: 2 }), "farWall", []),
    ],
    lining: [
      S("sarcophagus", 3),
      S("coffin", 1),
      S("bones", 2, { corner: true }),
      S("skull_pile", 1, { corner: true }),
      S("web", 2, { corner: true }),
    ],
    family: "store",
    shelf: false,
    rug: false,
    lights: { per10: [0, 0.5], onSurfaces: false, doorPair: false },
    props10: [2, 6],
    fill: 0.16,
    minimum: ["sarcophagus"],
    nearWall: [0.8, 1],
    clear: [0.6, 0.8],
  },
  prison: {
    host: "prison",
    layout: "wall",
    groups: [
      // the cell kit of a cell nobody keeps: a cot and a bucket
      G("cot", A("bed", { variant: "straw" }), "farWall", [
        C("bucket", BUCKET, "head", { facing: "same", gap: 0.2 }),
      ]),
      G("stocks", A("stocks", { size: [2, 1] }), "farWall", []),
    ],
    lining: [
      S("bones", 2, { corner: true }),
      S("skull_pile", 1, { corner: true }),
      S("web", 1, { corner: true }),
      S("debris", 1, { corner: true }),
    ],
    family: "store",
    shelf: false,
    rug: false,
    lights: { per10: [0, 0.5], onSurfaces: false, doorPair: false },
    props10: [2, 6],
    fill: 0.12,
    minimum: ["cot", "bucket"],
    nearWall: [1, 1],
    clear: [0.3, 0.5],
  },
  forge: {
    host: "forge",
    layout: "workLine",
    groups: [
      // the heat on the wall, the anvil a step in front of it, the quench beside, a bench on the other side
      G(
        "heat",
        A("forge"),
        "farWall",
        [
          C("anvil", [P("anvil")], "front", { gap: 0.6, facing: "same", top: "tools" }),
          C("quench", BUCKET, "head", { facing: "same", gap: 0.1 }),
          C("bench", [P("counter"), P("table")], "head", { facing: "same", gap: 0.1, top: "tools" }),
        ],
        { keep: 1 },
      ),
      G("bench", A("counter", { run: 2, top: "tools" }), "farWall", [
        C("anvil", [P("anvil")], "front", { gap: 0.6, facing: "same" }),
      ]),
    ],
    lining: [
      S("weapon_rack", 2),
      S("barrel", 2, { corner: true }),
      S("crate", 1, { corner: true }),
      S("anvil", 1, { top: "tools" }),
    ],
    family: "tools",
    shelf: true,
    rug: false,
    lights: { per10: [1, 2], onSurfaces: false, doorPair: false },
    props10: [25, 50],
    fill: 0.28,
    minimum: ["heat", "anvil", "light"],
    nearWall: [0.85, 1],
    clear: [0.4, 0.45],
  },
  laboratory: {
    host: "laboratory",
    layout: "workLine",
    groups: [
      G(
        "bench",
        A("table", { run: 2, top: "shelf" }),
        "farWall",
        [seatsFront("stool", STOOL, 0.25), C("still", [P("cauldron")], "head", { facing: "same", gap: 0.1 })],
        { light: true },
      ),
      G("still", A("cauldron"), "facingDoor", [
        C("bench", [P("table")], "head", { facing: "same", gap: 0, top: "shelf" }),
      ]),
    ],
    lining: [
      S("bookshelf", 3, { size: [1, 1] }),
      S("cauldron", 1),
      S("chest", 1, { top: "study" }),
      S("barrel", 1, { corner: true }),
    ],
    family: "shelf",
    shelf: true,
    rug: false,
    lights: { per10: [1.5, 3], onSurfaces: true, doorPair: false },
    props10: [25, 40],
    fill: 0.3,
    minimum: ["bench", "stool", "light"],
    nearWall: [0.85, 1],
    clear: [0.4, 0.63],
  },
  treasury: {
    host: "treasury",
    layout: "wall",
    groups: [
      G("chests", A("chest", { run: 3, top: "table" }), "facingDoor", [
        C("statue", STATUE, "head", { facing: "same", gap: 0.2 }),
      ]),
      G("statue", A("statue"), "farWall", [
        C("chest", CHEST, "head", { facing: "same", gap: 0.1, count: 2, top: "table" }),
      ]),
    ],
    lining: [S("chest", 4, { corner: true }), S("armor_stand", 1), S("weapon_rack", 1)],
    family: "store",
    shelf: false,
    rug: true,
    lights: { per10: [1, 2], onSurfaces: false, doorPair: false },
    props10: [10, 20],
    fill: 0.24,
    minimum: ["chests"],
    nearWall: [0.85, 1],
    clear: [0.4, 0.6],
  },
  washroom: {
    host: "washroom",
    layout: "wall",
    groups: [
      G("tub", A("barrel", { run: 2, top: "store" }), "farWall", [C("stool", STOOL, "front", { gap: 0.3 })]),
      G("basin", A("counter", { top: "store" }), "facingDoor", [C("stool", STOOL, "front", { gap: 0.3 })]),
    ],
    lining: [
      S("bench", 3),
      S("barrel", 2, { corner: true, top: "store" }),
      S("stool", 1),
      S("chest", 1, { top: "store" }),
    ],
    family: "store",
    shelf: true,
    rug: false,
    lights: { per10: [0.5, 1], onSurfaces: false, doorPair: false },
    props10: [10, 20],
    fill: 0.26,
    minimum: ["tub", "stool"],
    nearWall: [1, 1],
    clear: [0.4, 0.6],
  },
  throne_room: {
    host: "throne_room",
    layout: "wall",
    groups: [
      G("throne", A("throne"), "facingDoor", [
        C("brazier", BRAZIER, "head", { facing: "same", gap: 0.4, count: 2 }),
      ]),
      G("throne", A("throne"), "facingDoor", [
        C("statue", STATUE, "head", { facing: "same", gap: 0.4, count: 2 }),
      ]),
    ],
    lining: [S("statue", 2, { max: 2 }), S("brazier", 2, { corner: true }), S("chest", 1)],
    family: "table",
    shelf: false,
    rug: true,
    lights: { per10: [2, 4], onSurfaces: false, doorPair: true },
    props10: [8, 16],
    fill: 0.18,
    minimum: ["throne", "light"],
    nearWall: [0.5, 0.8],
    clear: [0.6, 0.8],
  },
  shop: {
    host: "storeroom",
    layout: "floorGroups",
    groups: [
      // the counter at the back facing the door, the keeper's seat behind it, the till light on it
      G(
        "counter",
        A("counter", { top: "store" }),
        "free",
        [
          C("seat", CHAIR, "back", { facing: "away", gap: 0.2 }),
          C("goods", STORE, "wallBehind", { facing: "away", count: 2, top: "store" }),
        ],
        { light: true },
      ),
      G(
        "counter",
        A("bar_counter", { size: [1, 1], run: 2, top: "store" }),
        "facingDoor",
        [C("goods", STORE, "head", { facing: "same", top: "store" })],
        {
          light: true,
        },
      ),
    ],
    lining: [
      S("bookshelf", 4, { size: [1, 1] }),
      S("table", 3, { top: "store", light: true }),
      S("crate", 2, { stack: true, variant: "small" }),
      S("barrel", 2, { top: "store" }),
      S("chest", 1, { top: "store" }),
    ],
    family: "store",
    shelf: true,
    rug: false,
    lights: { per10: [2, 3], onSurfaces: true, doorPair: true },
    props10: [8, 14],
    fill: 0.26,
    minimum: ["counter", "seat", "light"],
    nearWall: [0.7, 1],
    clear: [0.54, 0.68],
  },
  stable: {
    host: "storeroom",
    layout: "stationRows",
    groups: [
      // no palette has a stall divider or a manger: a trough of barrels with feed beside it
      G("trough", A("barrel", { run: 2 }), "farWall", [
        C("feed", [P("sack"), P("crate")], "head", { facing: "same", gap: 0.1, count: 2 }),
      ]),
      G("feed", A("sack", { run: 2 }), "farWall", [C("water", BUCKET, "head", { facing: "same", gap: 0.1 })]),
    ],
    lining: [S("sack", 3, { corner: true }), S("barrel", 2), S("crate", 2, { corner: true }), S("bench", 1)],
    family: "store",
    shelf: false,
    rug: false,
    lights: { per10: [1, 2], onSurfaces: false, doorPair: true },
    props10: [12, 18],
    fill: 0.3,
    minimum: ["trough", "feed", "light"],
    nearWall: [0.3, 0.8],
    clear: [0.55, 0.67],
  },
  lounge: {
    host: "study",
    layout: "floorGroups",
    groups: [
      // a low table with seats round it, off the walls, a lamp on it and a rug under it
      G(
        "table",
        A("table", { top: "table" }),
        "axis",
        [seatsFront("seat", CHAIR, 0.3), C("seat", CHAIR, "back", { count: "perTile", gap: 0.3 })],
        { light: true },
      ),
      G("table", A("table", { top: "table" }), "farWall", [seatsFront("seat", CHAIR, 0.3)], { light: true }),
    ],
    lining: [
      S("bookshelf", 2, { size: [1, 1] }),
      S("bench", 2),
      S("candelabra", 1, { corner: true, variant: "candle" }),
      S("chest", 1, { top: "study" }),
    ],
    family: "study",
    shelf: true,
    rug: true,
    lights: { per10: [1.5, 3], onSurfaces: true, doorPair: false },
    props10: [10, 16],
    fill: 0.24,
    minimum: ["table", "seat", "light"],
    nearWall: [0.5, 1],
    clear: [0.47, 0.57],
  },
  classroom: {
    host: "library",
    layout: "stationRows",
    groups: [
      // the focus: the master's desk before the front wall, his seat behind it facing the room
      G(
        "desk",
        A("desk", { top: "study" }),
        "free",
        [C("seat", CHAIR, "back", { facing: "away", gap: 0.2 })],
        { light: true },
      ),
      G("desk", A("desk", { top: "study" }), "facingDoor", [seatsFront("seat", CHAIR, 0.2)], {
        light: true,
      }),
    ],
    lining: [
      S("desk", 6, { top: "study", companions: [seatsFront("chair", CHAIR, 0.18)], light: true }),
      S("bookshelf", 2, { size: [1, 1] }),
    ],
    family: "study",
    shelf: true,
    rug: false,
    lights: { per10: [3, 3.6], onSurfaces: true, doorPair: false },
    props10: [18, 22],
    fill: 0.32,
    minimum: ["desk", "seat", "light"],
    nearWall: [0.3, 0.5],
    clear: [0.6, 0.68],
  },
  command: {
    host: "study",
    layout: "wall",
    groups: [
      // a chart table on the axis with seats both sides; desks on the side walls come from the lining
      G(
        "table",
        A("table", { top: "study" }),
        "axis",
        [seatsFront("chair", CHAIR, 0.2), C("chair", CHAIR, "back", { count: "perTile" })],
        { light: true },
      ),
      G("desk", A("desk", { top: "study" }), "facingDoor", [seatsFront("chair", CHAIR, 0.2)], {
        light: true,
      }),
    ],
    lining: [
      S("desk", 4, { top: "study", companions: [seatsFront("chair", CHAIR, 0.2)], light: true }),
      S("bookshelf", 1, { size: [1, 1] }),
      S("chest", 1, { top: "study" }),
    ],
    family: "study",
    shelf: true,
    rug: false,
    lights: { per10: [1.8, 2.4], onSurfaces: true, doorPair: true },
    props10: [16, 40],
    fill: 0.3,
    minimum: ["table", "chair", "light"],
    nearWall: [0.6, 0.8],
    clear: [0.5, 0.7],
  },
  ward: {
    host: "laboratory",
    layout: "stationRows",
    groups: [
      G("bed", A("bed"), "farWall", [
        C("nightstand", NIGHTSTAND, "head", { gap: 0.1, facing: "same", light: true }),
      ]),
      G("bed", A("bed"), "facingDoor", [C("chest", CHEST, "front", { gap: 0.2, facing: "same" })]),
    ],
    lining: [
      S("bed", 4, {
        companions: [C("nightstand", NIGHTSTAND, "head", { gap: 0.1, facing: "same", chance: 0.5 })],
      }),
      S("chest", 1, { top: "shelf" }),
      S("table", 1, { top: "shelf" }),
    ],
    family: "shelf",
    shelf: true,
    rug: false,
    lights: { per10: [1.5, 3], onSurfaces: true, doorPair: false },
    props10: [15, 25],
    fill: 0.32,
    minimum: ["bed", "nightstand", "light"],
    nearWall: [0.3, 0.6],
    clear: [0.4, 0.55],
  },
};

/** The kinds the table covers, every furnished purpose first, then the new kinds. */
export const ROOM_KINDS = Object.keys(ROOM_TRAITS) as RoomKind[];

/** The row of a kind. */
export const roomTraits = (kind: RoomKind): RoomTraits => ROOM_TRAITS[kind];

/** True when the kind is a new one (hosted by a purpose; gen/roomPurpose.ts NEW_KIND_INFO). */
export const isNewRoomKind = (kind: RoomKind): kind is NewRoomKind => Object.hasOwn(NEW_KIND_INFO, kind);

/**
 * What a room of a kind should measure, for the review by purpose (package B) and the floor groups and station rows
 * (package D): share of blockers near the walls, clear floor share, lights and props per 10 floor tiles, its anchor
 * objects (the anchors of its groups) and whether it lays out floor groups or station rows.
 */
export interface RoomTargets {
  readonly nearWall: readonly [number, number];
  readonly clear: readonly [number, number];
  readonly lightsPer10: readonly [number, number];
  readonly props10: readonly [number, number];
  readonly anchors: readonly FeatureType[];
  readonly floorGroups: boolean;
  readonly stationRows: boolean;
}

export function roomTargets(kind: RoomKind): RoomTargets {
  const t = ROOM_TRAITS[kind];
  return {
    nearWall: t.nearWall,
    clear: t.clear,
    lightsPer10: t.lights.per10,
    props10: t.props10,
    anchors: [...new Set(t.groups.map((g) => g.anchor.type))],
    floorGroups: t.layout === "floorGroups",
    stationRows: t.layout === "stationRows",
  };
}
