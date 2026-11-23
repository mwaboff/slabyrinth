/**
 * The harbour fixture (generator 5, vessel rooms): an original scene built in code. A timber wharf along the north of
 * the board on level "quay" (elevation 0), the harbour basin's bed (mud) on level "harbour" deep under it (a ship's
 * keel rests on it), under the wharf too, and two vessels moored port side to the wharf, bows east: a brig (30 long: a
 * hold, crew berth and galley below, the captain's cabin aft under the quarterdeck) and a barge (16 long: a cabin aft,
 * an open hold, a foredeck). Their decks below stand on a level the site stage adds one storey under the quay. No plan word asks for objects yet: the specs go to the site stage directly
 * (resolve/objectSite.ts `resolveWithObjects`), as a future plan field would pass them.
 *
 * The board water is a TaleSpire board setting (never in the slab): the vessels' waterline is about 0.75 under the quay
 * top; the GM raises the water plane there.
 */
import type { MapPlan } from "../../src/contracts/plan";
import type { ObjectSpec } from "../../src/resolve/objectSite";

/** The board: 72 x 26 cells. The quay is rows 0-8, the basin rows 9-25. */
export const HARBOUR_SIZE = { w: 72, h: 26 } as const;
/** The quay's last row (the landing row of each gangway). */
export const QUAY_EDGE = 8;

export const HARBOUR_SPECS: readonly ObjectSpec[] = [
  {
    id: "brig",
    kind: "vessel",
    level: "quay",
    at: [21, 14],
    heading: 90,
    size: 30,
    options: { kind: "ship", moored: "port" },
  },
  {
    id: "barge",
    kind: "vessel",
    level: "quay",
    at: [58, 12],
    heading: 90,
    size: 16,
    options: { kind: "barge", moored: "port" },
  },
];

export function harbourPlan(): MapPlan {
  const bounds = { x: 0, y: 0, w: HARBOUR_SIZE.w, h: HARBOUR_SIZE.h };
  const quayRows = QUAY_EDGE + 1;
  return {
    schema: "slabyrinth/plan@1",
    generator: 5,
    id: "7c1e2a90-5b44-4d0e-9a1f-3c2b8d6e4f10",
    title: "Harbour with a brig and a barge",
    summary: "A stone quay over a harbour basin; a brig and a river barge moored alongside.",
    kind: "town",
    seed: 2611,
    theme: "wood_town",
    entryLevel: "quay",
    levels: [
      {
        id: "harbour",
        name: "Harbour basin",
        // deep enough for a ship: the ship kit's hull is 5 deep under its deck, its keel on the bed
        elevation: -5.5,
        bounds,
        base: { type: "void" },
        areas: [
          {
            id: "basin",
            kind: "courtyard",
            name: "Harbour basin",
            shape: { type: "rect", x: 0, y: 0, w: HARBOUR_SIZE.w, h: HARBOUR_SIZE.h },
            // the basin's bed, under the wharf too: the water is the board's one plane, which the GM raises to the
            // vessels' waterline
            floor: "mud",
            walls: "none",
          },
        ],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
      },
      {
        id: "quay",
        name: "Quay",
        elevation: 0,
        bounds,
        base: { type: "void" },
        areas: [
          {
            id: "quay",
            kind: "courtyard",
            name: "Wharf",
            shape: { type: "rect", x: 0, y: 0, w: HARBOUR_SIZE.w, h: quayRows },
            floor: "bridge_wood",
            walls: "none",
          },
        ],
        openings: [],
        walls: [],
        features: [
          { id: "q_crate1", type: "crate", at: [30, 3] },
          { id: "q_crate2", type: "crate", at: [31, 3] },
          { id: "q_barrel1", type: "barrel", at: [33, 2] },
          { id: "q_barrel2", type: "barrel", at: [34, 2] },
          { id: "q_sack", type: "sack", at: [45, 4] },
        ],
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  };
}
