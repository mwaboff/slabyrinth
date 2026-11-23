/**
 * The building programme table (generator 5, switch `buildingRooms`): what rooms a kind of building has on its ground
 * storey, as general rules that hold in any theme (an inn, a smithy, a guardhouse, a ship chandler's).
 *
 * A building's kind is read from what the plan already says of it (its use, name, tags, notes and style; its
 * shopfront), never from a new plan field. Each kind has several programmes with weights, so a street of houses does
 * not get one layout. A programme is an ordered list of rooms: the first is the PUBLIC room, which takes the street
 * door; the others stand behind it (service) or furthest from the door (private). Room words are names the room
 * classifier reads (gen/roomPurpose.ts), so each room is furnished from its row of the room-kind table
 * (gen/roomTraits.ts) like any planned room.
 *
 * The rules behind the rows (the interior-sequence rules of the training notes):
 *   - public rooms at the door, service behind, private furthest; the public room takes 55-80 % of a public ground
 *     floor (the low end for a cramped or worn business);
 *   - a shop's counter room has the street door, the store behind it; an inn's taproom, the kitchen behind the bar,
 *     a store; a house's hall or kitchen and a bedroom or sleeping corner; a workshop's work room at the street;
 *   - a kitchen never opens into a sleeping room (`noDoorTo`);
 *   - a chimney breast gets a room with a hearth (`hearth`);
 *   - a small building is one room with zones (two rooms of the programme open to each other), not tiny rooms; a
 *     tiny one is a single room.
 *
 * What an optional plan field would add (not in the contract; the owner decides): `Building.rooms` naming the ground
 * storey's rooms in order ("taproom, kitchen, store"), and `Building.interior: "full" | "windows" | "none"` to turn the
 * interior off or keep it to window dressing on a big street.
 */
import type { RoomKind } from "./roomPurpose";

/** Where a room stands in the sequence from the street door. */
export type RoomRole = "public" | "service" | "private";

export interface ProgrammeRoom {
  /** The room's name: words the room classifier reads as `kind` (a test keeps them in step). */
  readonly name: string;
  /** What the room is furnished as (gen/roomTraits.ts). */
  readonly kind: RoomKind;
  readonly role: RoomRole;
  /** Share of the ground storey's floor (low, high); the splitter draws within it and then fits the grid. */
  readonly share: readonly [number, number];
  /** The fewest floor cells the room may have (it holds its kind's minimum set). */
  readonly minCells: number;
  /** The narrowest the room may be either way (default ROOM_MIN_WIDTH: a bed or a table and its seats fit). */
  readonly minWidth?: number;
  /** A hearth room: a chimney breast may stand in its wall. */
  readonly hearth?: boolean;
  /** Kinds of room it never opens into directly (a kitchen into a bedroom). */
  readonly noDoorTo?: readonly RoomKind[];
  /** The doorway into it: a door (a private or closed room) or an open way (default: a door for private rooms). */
  readonly doorway?: "door" | "open";
}

export interface Programme {
  readonly id: string;
  readonly weight: number;
  /** The fewest footprint cells the programme is drawn for. */
  readonly minCells: number;
  /** The public room is the largest (default true). */
  readonly publicLargest?: boolean;
  readonly rooms: readonly [ProgrammeRoom, ...ProgrammeRoom[]];
}

export interface BuildingKindRow {
  /** Words of the building (use, name, tags, notes, style) that name the kind; the first row that matches wins. */
  readonly words: RegExp;
  readonly programmes: readonly [Programme, ...Programme[]];
  /** A small building: one room with zones (the two rooms open to each other). */
  readonly zones: readonly [ProgrammeRoom, ProgrammeRoom];
  /** A tiny building: a single room. */
  readonly single: ProgrammeRoom;
}

/** The narrowest a room may be either way, unless its row says otherwise (a store or a pantry may be 2). */
export const ROOM_MIN_WIDTH = 3;

/** Footprint sizes (floor cells) at which a building is one room, or one room with zones, rather than partitioned. */
export const PROGRAMME_SIZES = {
  /** Under this many cells: a single room. */
  single: 16,
  /** Under this many cells: one room with zones. */
  zones: 32,
} as const;

// ───────────────────────────── rooms ─────────────────────────────

const R = (
  name: string,
  kind: RoomKind,
  role: RoomRole,
  share: readonly [number, number],
  minCells: number,
  more: Partial<Pick<ProgrammeRoom, "hearth" | "noDoorTo" | "doorway" | "minWidth">> = {},
): ProgrammeRoom => ({ name, kind, role, share, minCells, ...more });

const NO_SLEEP: readonly RoomKind[] = ["bedroom"];

const TAPROOM = (share: readonly [number, number]): ProgrammeRoom =>
  R("Taproom", "tavern", "public", share, 12, { hearth: true });
const KITCHEN_BEHIND = (share: readonly [number, number]): ProgrammeRoom =>
  R("Kitchen", "kitchen", "service", share, 6, { hearth: true, noDoorTo: NO_SLEEP, doorway: "open" });
const STORE = (share: readonly [number, number], name = "Store room"): ProgrammeRoom =>
  R(name, "storeroom", "service", share, 4, { doorway: "door", minWidth: 2 });
const BEDROOM = (share: readonly [number, number], name = "Bedroom"): ProgrammeRoom =>
  R(name, "bedroom", "private", share, 6, { doorway: "door" });
const SHOP_FLOOR = (share: readonly [number, number]): ProgrammeRoom =>
  R("Shop floor", "shop", "public", share, 9);
const WORKSHOP = (share: readonly [number, number], role: RoomRole = "public"): ProgrammeRoom =>
  R("Workshop", "forge", role, share, 9, { hearth: true, doorway: "open" });

// ───────────────────────────── the table ─────────────────────────────

/** One row per kind of building, tried in order; the last row (a dwelling) takes every building no other row names. */
export const BUILDING_KINDS = {
  inn: {
    words:
      /\b(inns?|taverns?|alehouses?|pubs?|taprooms?|taphouses?|saloons?|hostelr(y|ies)|coaching house)\b/,
    programmes: [
      {
        id: "inn-taproom-kitchen-store",
        weight: 3,
        minCells: 48,
        rooms: [TAPROOM([0.55, 0.65]), KITCHEN_BEHIND([0.2, 0.28]), STORE([0.1, 0.18])],
      },
      {
        id: "inn-taproom-kitchen",
        weight: 2,
        minCells: 30,
        rooms: [TAPROOM([0.6, 0.72]), KITCHEN_BEHIND([0.28, 0.4])],
      },
      {
        id: "inn-taproom-kitchen-store-keeper",
        weight: 2,
        minCells: 72,
        rooms: [
          TAPROOM([0.5, 0.6]),
          KITCHEN_BEHIND([0.16, 0.22]),
          STORE([0.08, 0.14]),
          BEDROOM([0.12, 0.18], "Keeper's bedroom"),
        ],
      },
    ],
    zones: [TAPROOM([0.65, 0.75]), KITCHEN_BEHIND([0.25, 0.35])],
    single: TAPROOM([1, 1]),
  },
  workshop: {
    words:
      /\b(workshops?|smith(y|ies)?|blacksmiths?|forges?|coopers?|carpenters?|joiners?|wheelwrights?|masons?|tanner(y|ies|s)?|foundr(y|ies)|potter(y|ies|s)?|weavers?|mills?)\b/,
    programmes: [
      {
        id: "workshop-store",
        weight: 3,
        minCells: 24,
        rooms: [WORKSHOP([0.62, 0.72]), STORE([0.28, 0.38])],
      },
      {
        id: "shopfront-workshop-store",
        weight: 2,
        minCells: 45,
        publicLargest: false,
        rooms: [SHOP_FLOOR([0.3, 0.38]), WORKSHOP([0.42, 0.5], "service"), STORE([0.15, 0.22])],
      },
      {
        id: "workshop-store-bedroom",
        weight: 2,
        minCells: 42,
        rooms: [WORKSHOP([0.55, 0.65]), STORE([0.15, 0.2]), BEDROOM([0.2, 0.28])],
      },
    ],
    zones: [WORKSHOP([0.65, 0.75]), STORE([0.25, 0.35])],
    single: WORKSHOP([1, 1]),
  },
  shop: {
    words:
      /\b(shops?|general store|stores?front|bakers?|baker(y|ies)|butchers?|cobblers?|tailors?|apothecar(y|ies)|chandler(y|ies|s)?|grocers?|merchants?|traders?|emporium|haberdasher(y|s)?|bookshops?|pawnshops?|jewell?ers?|drapers?|milliners?|boutiques?)\b/,
    programmes: [
      {
        id: "shop-store",
        weight: 3,
        minCells: 24,
        rooms: [SHOP_FLOOR([0.6, 0.7]), STORE([0.3, 0.4])],
      },
      {
        id: "shop-store-living",
        weight: 2,
        minCells: 42,
        rooms: [SHOP_FLOOR([0.5, 0.6]), STORE([0.15, 0.2]), BEDROOM([0.22, 0.3])],
      },
      {
        id: "shop-workroom-store",
        weight: 1,
        minCells: 48,
        rooms: [SHOP_FLOOR([0.5, 0.58]), WORKSHOP([0.26, 0.32], "service"), STORE([0.12, 0.18])],
      },
    ],
    zones: [SHOP_FLOOR([0.65, 0.75]), STORE([0.25, 0.35])],
    single: SHOP_FLOOR([1, 1]),
  },
  sacred: {
    words:
      /\b(temples?|shrines?|chapels?|church(es)?|sanctuar(y|ies)|monaster(y|ies)|abbey|oratory|kirk|mausoleum)\b/,
    programmes: [
      {
        id: "shrine-vestry",
        weight: 1,
        minCells: 30,
        rooms: [
          R("Shrine", "shrine", "public", [0.7, 0.8], 12),
          R("Study", "study", "private", [0.2, 0.3], 6),
        ],
      },
    ],
    zones: [R("Shrine", "shrine", "public", [0.7, 0.8], 9), R("Study", "study", "private", [0.2, 0.3], 4)],
    single: R("Shrine", "shrine", "public", [1, 1], 4),
  },
  guard: {
    words: /\b(guards?|guardhouses?|barracks|garrison|watch ?house|gatehouse|keeps?|outpost)\b/,
    programmes: [
      {
        id: "guardroom-armoury",
        weight: 2,
        minCells: 30,
        rooms: [
          R("Guardroom", "barracks", "public", [0.6, 0.7], 12, { hearth: true }),
          R("Armoury", "armoury", "service", [0.3, 0.4], 6, { doorway: "door" }),
        ],
      },
      {
        id: "guardroom-armoury-store",
        weight: 1,
        minCells: 48,
        rooms: [
          R("Guardroom", "barracks", "public", [0.55, 0.65], 12, { hearth: true }),
          R("Armoury", "armoury", "service", [0.18, 0.25], 6, { doorway: "door" }),
          STORE([0.12, 0.2]),
        ],
      },
    ],
    zones: [
      R("Guardroom", "barracks", "public", [0.65, 0.75], 9, { hearth: true }),
      R("Armoury", "armoury", "service", [0.25, 0.35], 4),
    ],
    single: R("Guardroom", "barracks", "public", [1, 1], 4, { hearth: true }),
  },
  barn: {
    words: /\b(warehouses?|storehouses?|granar(y|ies)|barns?|stables?|byres?|sheds?|depot|livery)\b/,
    programmes: [
      {
        id: "store-office",
        weight: 1,
        minCells: 30,
        rooms: [
          R("Store room", "storeroom", "public", [0.75, 0.85], 12),
          R("Office", "study", "private", [0.15, 0.25], 4, { minWidth: 2 }),
        ],
      },
    ],
    zones: [
      R("Store room", "storeroom", "public", [0.7, 0.8], 9),
      R("Office", "study", "private", [0.2, 0.3], 4),
    ],
    single: R("Store room", "storeroom", "public", [1, 1], 4),
  },
  dwelling: {
    words: /.*/,
    programmes: [
      {
        id: "kitchen-bedroom",
        weight: 3,
        minCells: 30,
        rooms: [R("Kitchen", "kitchen", "public", [0.55, 0.65], 12, { hearth: true }), BEDROOM([0.35, 0.45])],
      },
      {
        id: "hall-bedroom-pantry",
        weight: 2,
        minCells: 36,
        rooms: [
          R("Hall", "dining", "public", [0.5, 0.6], 12, { hearth: true }),
          BEDROOM([0.25, 0.33]),
          R("Pantry", "storeroom", "service", [0.12, 0.18], 4, { doorway: "door", minWidth: 2 }),
        ],
      },
      {
        id: "parlour-kitchen-bedroom",
        weight: 2,
        minCells: 42,
        rooms: [
          R("Parlour", "lounge", "public", [0.42, 0.5], 12, { hearth: true }),
          R("Kitchen", "kitchen", "service", [0.24, 0.3], 6, { hearth: true, noDoorTo: NO_SLEEP }),
          BEDROOM([0.24, 0.3]),
        ],
      },
      {
        id: "kitchen-two-bedrooms",
        weight: 1,
        minCells: 48,
        rooms: [
          R("Kitchen", "kitchen", "public", [0.48, 0.56], 12, { hearth: true }),
          BEDROOM([0.2, 0.26]),
          BEDROOM([0.2, 0.26], "Small bedroom"),
        ],
      },
    ],
    zones: [R("Kitchen", "kitchen", "public", [0.55, 0.65], 6, { hearth: true }), BEDROOM([0.35, 0.45])],
    single: R("Kitchen", "kitchen", "public", [1, 1], 4, { hearth: true }),
  },
} as const satisfies Record<string, BuildingKindRow>;

export type BuildingKind = keyof typeof BUILDING_KINDS;
export const BUILDING_KIND_NAMES = Object.keys(BUILDING_KINDS) as BuildingKind[];

/** What the plan says of a building that the kind is read from. */
export interface BuildingKindWords {
  readonly use?: string | undefined;
  readonly name?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly notes?: string | undefined;
  /** The style profile id ("cottage", "keep" …): a keep is a guard building when its words name nothing else. */
  readonly style?: string | undefined;
  /** The ground storey's street face is a shopfront. */
  readonly shopfront?: boolean | undefined;
}

/**
 * The kind of a building: its use first (the plan's own word for what it is for), then its name, tags and notes, then
 * a shopfront (a shop), then its style; a dwelling when nothing names one.
 */
export function buildingKind(w: BuildingKindWords): BuildingKind {
  const named = (text: string): BuildingKind | undefined =>
    BUILDING_KIND_NAMES.find((k) => k !== "dwelling" && BUILDING_KINDS[k].words.test(text));
  const lower = (s: string | undefined): string => (s ?? "").toLowerCase();
  return (
    named(lower(w.use)) ??
    named([w.name, ...(w.tags ?? [])].map(lower).join(" ")) ??
    named(lower(w.notes).slice(0, 160)) ??
    (w.shopfront === true ? "shop" : undefined) ??
    named(lower(w.style)) ??
    "dwelling"
  );
}

/**
 * The programmes a building of this kind and size may draw, each with its weight: those its footprint holds. Empty
 * when the footprint is too small for any (the caller then makes one room with zones, or a single room).
 */
export function programmesFor(kind: BuildingKind, cells: number): Programme[] {
  const row: BuildingKindRow = BUILDING_KINDS[kind];
  return row.programmes.filter((p) => cells >= p.minCells);
}

/** What the programme reads of a building's character (condition today; wealth and light later). */
export interface ProgrammeCharacter {
  readonly condition: "intact" | "weathered" | "ruined";
}

/**
 * A building's character as the programme reads it: the one place its condition (and, once the character accessor
 * lands on generator 5, its wealth and light) comes from, so that accessor replaces this body alone.
 */
export function programmeCharacter(b: {
  readonly condition: ProgrammeCharacter["condition"];
}): ProgrammeCharacter {
  return { condition: b.condition };
}

/** A building whose ground storey gets rooms: not a ruin (its interior is its rubble). */
export const furnishedCharacter = (c: ProgrammeCharacter): boolean => c.condition !== "ruined";

/** The row of a kind (zones and single room included). */
export const buildingKindRow = (kind: BuildingKind): BuildingKindRow => BUILDING_KINDS[kind];
