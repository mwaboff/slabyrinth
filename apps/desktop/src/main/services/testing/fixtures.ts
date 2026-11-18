import type { MapPlan } from "@slabyrinth/core";

/** Two rooms joined by door d1 on the edge x=7, y=3; an altar at `altar` ([7,3] blocks the door). */
export function doorPlan(altar: [number, number]): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "00000000-0000-4000-8000-0000000000d1",
    title: "Blocked",
    kind: "dungeon",
    seed: 7,
    theme: "stone_dungeon",
    levels: [
      {
        id: "l1",
        name: "One",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 16, h: 10 },
        base: { type: "solid" },
        areas: [
          { id: "entry", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } },
          { id: "hall", kind: "room", shape: { type: "rect", x: 7, y: 1, w: 6, h: 5 } },
        ],
        openings: [{ id: "d1", kind: "door", between: ["entry", "hall"] }],
        walls: [],
        features: [{ id: "altar", type: "altar", at: altar }],
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  };
}
