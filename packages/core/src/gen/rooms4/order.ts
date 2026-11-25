/**
 * Placement by room order (generator 5, switch `placementOrder`): how squarely a room's loose things are set, by its
 * kind's order (gen/roomTraits.ts `order`), never by the building's condition. A tidy room (a study, a shrine, a ward)
 * sets the things on its tables square to them and evenly spaced; a lived-in, working or messy room lets them lie as
 * hands left them: turned in 15° steps and shifted by the arrangement engine's hand-built amounts (arrange HAND_BUILT:
 * 0.08 along, 0.04 across, one 15° step), more often and further the rougher the room. Seats sit a little askew in a
 * rough room and square in a tidy one. Structure and big furniture (tables, beds, counters, shelves) are never turned
 * off their quarter turns here.
 */
import type { RoomOrder } from "../roomTraits";
import type { Room } from "./room";

export interface OrderJitter {
  /** Share of loose things turned off square; `anyTurn` turns them any 15° step, else one or two steps. */
  readonly looseTurn: number;
  readonly anyTurn: boolean;
  /** Largest shift of a loose thing along and across its support (tiles). */
  readonly along: number;
  readonly across: number;
  /** Share of seats turned one 15° step off facing their table. */
  readonly seatTurn: number;
}

/** The jitter of each order (tidy rows on exact pitch; lived ± a hand's width; messy heaps). */
export const ORDER_JITTER: Readonly<Record<RoomOrder, OrderJitter>> = {
  tidy: { looseTurn: 0.1, anyTurn: false, along: 0, across: 0, seatTurn: 0 },
  lived: { looseTurn: 0.4, anyTurn: false, along: 0.08, across: 0.04, seatTurn: 0.3 },
  working: { looseTurn: 0.25, anyTurn: false, along: 0.08, across: 0.04, seatTurn: 0.15 },
  messy: { looseTurn: 0.8, anyTurn: true, along: 0.12, across: 0.06, seatTurn: 0.4 },
};

/** The fine turn of a loose thing on a support set square at `square` (degrees), by the room's order. */
export function looseTurn(room: Room, order: RoomOrder, square: number): number {
  const j = ORDER_JITTER[order];
  if (!room.rng.chance(j.looseTurn)) return norm(square + 90 * room.rng.int(4));
  if (j.anyTurn) return room.rng.int(24) * 15;
  const steps = (room.rng.chance(0.5) ? -1 : 1) * (1 + room.rng.int(2));
  return norm(square + 90 * room.rng.int(4) + steps * 15);
}

/** A loose thing's shift along and across its support (tiles), by the room's order. */
export function looseShift(room: Room, order: RoomOrder): [number, number] {
  const j = ORDER_JITTER[order];
  return [(room.rng.next() * 2 - 1) * j.along, (room.rng.next() * 2 - 1) * j.across];
}

/** A seat's fine turn, set to face its table at `facing` (degrees), by the room's order. */
export function seatTurn(room: Room, order: RoomOrder, facing: number): number {
  const j = ORDER_JITTER[order];
  if (j.seatTurn <= 0 || !room.rng.chance(j.seatTurn)) return facing;
  return norm(facing + (room.rng.chance(0.5) ? -15 : 15));
}

const norm = (deg: number): number => ((deg % 360) + 360) % 360;
