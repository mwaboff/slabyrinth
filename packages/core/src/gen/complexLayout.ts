/**
 * How a complex of rooms is laid out (generator 5, package WP-DG; technique catalogue Part 4, Q4 `dead-ends-pay` and
 * Q10 `doors-by-role`): the numbers the resolver and the review share, and the options the resolver draws where the
 * plan leaves it free. The plan fixes its rooms, corridors and doors; core decides only what the plan leaves open: the
 * kind of a route's openings when the route names none, and what stands in a room the plan and its purpose leave bare.
 *
 * The numbers marked [E] are one builder's dungeon: they are ranges and allowances, never a single target, and stay
 * advisory until a second dungeon confirms them. Every family of options keeps a plain one.
 */
import type { OpeningKind } from "../contracts/plan";
import type { RoomPurpose } from "../contracts/plan";
import type { RoomKind } from "./roomPurpose";
import type { Companion, GroupSpec, PieceChoice } from "./roomTraits";
import type { Family } from "./rooms4/recipes";

/**
 * The layout numbers the generator and the review (review/thresholds.ts REVIEW.layout) both read.
 *   minRooms       a level with fewer rooms is not judged as a complex;
 *   emptyDeadEnds  dead ends (one way on) that may stand empty in one map [E: "at most 1 empty"]: the generator leaves
 *                  at most this many plain, so a complex it dresses is never faulted for them.
 */
export const COMPLEX = {
  minRooms: 4,
  emptyDeadEnds: 1,
} as const;

// ───────────────────────────── dead ends (Q4) ─────────────────────────────

const P = (type: PieceChoice["type"], variant?: string): PieceChoice =>
  variant === undefined ? { type } : { type, variant };
const C = (
  name: string,
  pieces: readonly PieceChoice[],
  slot: Companion["slot"],
  more: Partial<Omit<Companion, "name" | "pieces" | "slot">> = {},
): Companion => ({ name, pieces, slot, gap: 0.2, facing: "anchor", count: 1, ...more });
const G = (name: string, anchor: GroupSpec["anchor"], companions: readonly Companion[]): GroupSpec => ({
  name,
  anchor,
  place: "farWall",
  companions,
  keep: 1,
});

/**
 * What a dead end holds: a small set against its far wall (a reward, a vignette), drawn per room by weight, one weight
 * for a room someone keeps and one for an abandoned or ruined one. `plain` leaves the room as it is; the resolver draws
 * it only while the map's plain dead ends stay within COMPLEX.emptyDeadEnds.
 */
export interface DeadEndOption {
  readonly name: "cache" | "remains" | "stores" | "shrine" | "plain";
  readonly weight: { readonly kept: number; readonly abandoned: number };
  readonly group: GroupSpec | null;
  /** The small things on its top (a chest's coins, a barrel's goods). */
  readonly family: Family;
}

const LOOT: readonly PieceChoice[] = [P("chest"), P("crate", "small"), P("crate")];

export const DEAD_END_OPTIONS: readonly DeadEndOption[] = [
  {
    // a cache: a chest with a crate beside it
    name: "cache",
    weight: { kept: 3, abandoned: 2 },
    group: G("chest", { type: "chest", weight: 1, top: "store" }, [
      C("crate", [P("crate", "small"), P("barrel")], "head", { facing: "same", gap: 0.1, chance: 0.6 }),
    ]),
    family: "store",
  },
  {
    // a dead explorer and the loot: a chest with remains before and beside it
    name: "remains",
    weight: { kept: 1, abandoned: 4 },
    group: G("chest", { type: "chest", weight: 1, top: "none" }, [
      C("bones", [P("bones")], "front", { facing: "same", gap: 0.1 }),
      C("skull", [P("skull_pile"), P("bones")], "head", { facing: "same", gap: 0.1, chance: 0.6 }),
    ]),
    family: "store",
  },
  {
    // stores left in a side room: barrels and a crate
    name: "stores",
    weight: { kept: 3, abandoned: 1 },
    group: G("barrel", { type: "barrel", weight: 1, top: "store" }, [
      C("crate", LOOT, "head", { facing: "same", gap: 0.1, count: 2 }),
    ]),
    family: "store",
  },
  {
    // a figure at the end of the way: a statue with an offering
    name: "shrine",
    weight: { kept: 1, abandoned: 1 },
    group: G("statue", { type: "statue", weight: 1 }, [
      C("offering", [P("chest"), P("crate", "small")], "front", { facing: "same", gap: 0.1, chance: 0.5 }),
    ]),
    family: "store",
  },
  { name: "plain", weight: { kept: 1, abandoned: 1 }, group: null, family: "store" },
];

/** The dead-end option for a draw u in [0, 1): by weight, for a kept or an abandoned room; `plain` only when allowed. */
export function drawDeadEnd(u: number, abandoned: boolean, plainAllowed: boolean): DeadEndOption {
  const pool = DEAD_END_OPTIONS.filter((o) => plainAllowed || o.group !== null);
  const w = pool.map((o) => (abandoned ? o.weight.abandoned : o.weight.kept));
  let r = u * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    r -= w[i] as number;
    if (r < 0) return pool[i] as DeadEndOption;
  }
  return pool[pool.length - 1] as DeadEndOption;
}

/** The smallest room (floor cells) a dead end is dressed in. */
export const DEAD_END_MIN_CELLS = 2;

// ───────────────────────────── doors by role (Q10) ─────────────────────────────

/**
 * What a door says about the room it opens into:
 *   hub      a hall, a taproom, a throne room, a shrine, or any room of HUB_CELLS or more: an arch, double doors when wide;
 *   secure   a treasury, an armoury, cells: a locked door;
 *   tomb     a crypt: an arch, no leaf;
 *   private  a room someone uses (a bedroom, a store, a workroom): a door, double doors when wide;
 *   open     a passage, a ruin, a room with no purpose: a plain gap, as before.
 */
export type DoorRole = "hub" | "secure" | "tomb" | "private" | "open";

/** A room of this many floor cells or more is a hub whatever its kind. */
export const HUB_CELLS = 100;

const ROLE_OF_KIND: Readonly<Partial<Record<RoomKind, DoorRole>>> = {
  dining: "hub",
  tavern: "hub",
  throne_room: "hub",
  shrine: "hub",
  treasury: "secure",
  armoury: "secure",
  prison: "secure",
  crypt: "tomb",
};

/** The door role of a room: its kind (a furnished room), else its purpose, by size. */
export function doorRole(
  room: { readonly purpose?: RoomPurpose | undefined; readonly kind?: RoomKind | undefined },
  cells: number,
): DoorRole {
  const kind = room.kind ?? room.purpose;
  if (kind === undefined || kind === "passage" || kind === "ruin") return "open";
  if (cells >= HUB_CELLS) return "hub";
  return ROLE_OF_KIND[kind] ?? "private";
}

/** The opening kind of a role, by the opening's width in cells (1, 2 or 3); a gap past what a leaf spans. */
export const DOOR_BY_ROLE: Readonly<Record<DoorRole, readonly [OpeningKind, OpeningKind, OpeningKind]>> = {
  hub: ["archway", "double_door", "open"],
  secure: ["locked_door", "double_door", "open"],
  tomb: ["archway", "archway", "open"],
  private: ["door", "double_door", "open"],
  open: ["open", "open", "open"],
};

/**
 * How a complex treats the openings its routes leave unnamed, drawn once per level: by the role of the room each opens
 * into, or plain (every one a gap, as the generators before 5 did).
 */
export const DOOR_TREATMENTS = { byRole: 3, plain: 1 } as const;
