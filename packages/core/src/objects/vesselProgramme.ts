/**
 * The vessel programme (generator 5): what rooms a vessel has below and aft, by kind and size, in the building
 * programme's own form (gen/buildingProgramme.ts `BuildingKindRow`), so the ground-storey splitter
 * (resolve/building/rooms.ts) lays out a hold as it lays out a ground floor. Room names are words the room classifier
 * reads (gen/roomPurpose.ts: hold and cargo are a storeroom, a berth a barracks, a galley a kitchen, a cabin a bedroom),
 * so every room aboard is furnished and lit from its row of the room-kind table like any planned room.
 *
 * The rules behind the rows (general, any theme):
 *   - the hold is the PUBLIC room of the deck below: the main hatch's ladder comes down into it, the other rooms open
 *     off it (cargo stacks with an aisle down the middle: the storeroom row's own layout);
 *   - a ship's crew sleeps in a berth (bunks in rows: the barracks row), cooks in a galley, keeps its gear in a store;
 *     a small ship has a hold and a berth only;
 *   - the master sleeps aft: a cabin under the raised aft deck (the captain's cabin of a ship, the bargee's of a barge);
 *     a ship's forecastle under its raised fore deck is a second berth;
 *   - a barge's hold is one open room (no deck over most of it); a rowing boat has no rooms.
 */
import { type BuildingKindRow, type ProgrammeRoom } from "../gen/buildingProgramme";
import type { RoomKind } from "../gen/roomPurpose";
import type { VesselKind } from "./vessel";

const R = (
  name: string,
  kind: RoomKind,
  role: ProgrammeRoom["role"],
  share: readonly [number, number],
  minCells: number,
  more: Partial<Pick<ProgrammeRoom, "doorway" | "minWidth">> = {},
): ProgrammeRoom => ({ name, kind, role, share, minCells, ...more });

const HOLD = (share: readonly [number, number]): ProgrammeRoom => R("Hold", "storeroom", "public", share, 9);
const BERTH = (share: readonly [number, number]): ProgrammeRoom =>
  R("Crew berth", "barracks", "private", share, 8, { doorway: "door" });
// a galley and a store are 3 wide, so the wall each shares with the hold holds a doorway off its corners: every room
// below opens off the hold, none is reached through another (a furnished berth may close its own aisle)
const GALLEY = (share: readonly [number, number]): ProgrammeRoom =>
  R("Galley", "kitchen", "service", share, 6, { doorway: "open" });
const STORE = (share: readonly [number, number]): ProgrammeRoom =>
  R("Bosun's store", "storeroom", "service", share, 6, { doorway: "door" });

/** The deck below the main deck, by kind of vessel (a boat has none). */
export const VESSEL_HOLDS: Readonly<Record<Exclude<VesselKind, "boat">, BuildingKindRow>> = {
  ship: {
    // never read from words: a vessel's kind is its recipe's, not a building's
    words: /(?!)/,
    programmes: [
      {
        id: "hold-berth-galley-store",
        weight: 2,
        minCells: 64,
        rooms: [HOLD([0.42, 0.5]), BERTH([0.26, 0.32]), GALLEY([0.1, 0.14]), STORE([0.08, 0.12])],
      },
      {
        id: "hold-berth-galley",
        weight: 3,
        minCells: 40,
        rooms: [HOLD([0.45, 0.55]), BERTH([0.28, 0.36]), GALLEY([0.12, 0.18])],
      },
    ],
    // a small ship (a hold under 40 cells, or one no programme fits): the hold and the berth open to each other
    zones: [HOLD([0.6, 0.7]), BERTH([0.3, 0.4])],
    single: HOLD([1, 1]),
  },
  barge: {
    words: /(?!)/,
    programmes: [
      { id: "open-hold", weight: 1, minCells: 4, rooms: [R("Open hold", "storeroom", "public", [1, 1], 4)] },
    ],
    zones: [
      R("Open hold", "storeroom", "public", [0.7, 0.8], 4),
      R("Open hold", "storeroom", "public", [0.2, 0.3], 4),
    ],
    single: R("Open hold", "storeroom", "public", [1, 1], 4),
  },
};

/** A cabin on the main deck under a raised deck: its name (classifier words) and what it is furnished as. */
export interface CabinRoom {
  readonly name: string;
  readonly kind: RoomKind;
}

/** The cabins under the raised decks, by kind of vessel and end (aft: the stern cabin; fore: the forecastle). */
export const VESSEL_CABINS: Readonly<
  Record<Exclude<VesselKind, "boat">, Readonly<Record<"aft" | "fore", CabinRoom>>>
> = {
  ship: {
    aft: { name: "Captain's cabin", kind: "bedroom" },
    fore: { name: "Forecastle berth", kind: "barracks" },
  },
  barge: {
    aft: { name: "Bargee's cabin", kind: "bedroom" },
    fore: { name: "Forepeak store", kind: "storeroom" },
  },
};
