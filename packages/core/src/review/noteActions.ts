/**
 * What the model should change, for each review note generator 5 added (the switches `qualityNotes`, `reviewByKind`,
 * `deadEndReview`, `roomSizeReview`, `corridorShareReview`, `entrancesReview`, `wayBackReview`): one table, so every
 * such note has a text and each text says what to change in plan terms (a field, a feature type, a word the generator
 * reads). The notes of released generators keep their own texts where they are made, so their output never moves.
 *
 * `{features}` in an action is filled with the plan features the note names.
 */
import type { DesignNoteCode } from "./review";

export const ADVISED_CODES = [
  "lane_blocked",
  "doors_unlit",
  "silhouette_flat",
  "facades_alike",
  "anchor_missing",
  "dead_end_empty",
  "rooms_same_size",
  "corridor_heavy",
  "entrances_few",
  "drop_trap_dead",
  "hall_unbroken",
] as const satisfies readonly DesignNoteCode[];
export type AdvisedCode = (typeof ADVISED_CODES)[number];

export const NOTE_ACTIONS: Readonly<Record<AdvisedCode, string>> = {
  lane_blocked: "keep a clear lane between a room's doors: move {features} against a wall",
  doors_unlit:
    "set lighting.doors on them, or stand a light beside each outside door; a building meant to be dark says so in its name or notes (dim, gloomy, abandoned)",
  silhouette_flat: "give each something above its roof: chimneys, a taller volume or tower, or roofFurniture",
  facades_alike:
    "vary the row: give neighbours different storeys (one at least twice another) or walls, or leave storeys and walls unset and give each its own use so the style draws them apart",
  anchor_missing:
    "add the anchor piece (the bed, the counter, the desk), or rename the room for what it holds",
  dead_end_empty:
    "give a dead end something worth the walk (a chest, bones, an altar, a trap), name it for a use so it is furnished (a store room, a shrine), or open it onto another room",
  rooms_same_size:
    "one option: make one room a set piece about twice the others, and a few small ones beside it (a closet, a cell, a niche)",
  corridor_heavy:
    "one option: let more rooms touch, with a door in a shared wall (between: [room, room]), and keep corridors short",
  entrances_few:
    'one option: add a second way in at another side or height (a door to "@outside", a drain, a stair from above), and light the main one (torch_wall either side)',
  drop_trap_dead:
    "give the low side of the drop its own way on (a stair, a ladder, a door to the rest of the map), unless a one-way trap is meant",
  hall_unbroken:
    "one option: name it for its use (a great hall, a throne room, a temple) so it is laid out as a hall with columns, or add pillar features in pairs at the third points of its long axis, or a raised dais (floorHeight) at its far end",
};

/** A note's action, with `{features}` filled in. */
export const noteAction = (code: AdvisedCode, features = ""): string =>
  NOTE_ACTIONS[code].replace("{features}", features);
