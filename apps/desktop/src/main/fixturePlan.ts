import type { MapPlan } from "@slabyrinth/core";

/**
 * A small valid plan: the packaged smoke check estimates it in the compile worker (main/index.ts), and the
 * main-process tests use it as their plan. Two keyed rooms joined by a corridor, one feature.
 */
export const FIXTURE_PLAN: MapPlan = {
  schema: "slabyrinth/plan@1",
  generator: 1,
  id: "00000000-0000-4000-8000-00000000f4ce",
  title: "The Fake Crypt",
  summary: "A two-room crypt (the fixture plan of the smoke check and the main-process tests).",
  kind: "dungeon",
  seed: 4242,
  theme: "stone_dungeon",
  entryLevel: "l1",
  levels: [
    {
      id: "l1",
      name: "Crypt",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 20, h: 14 },
      base: { type: "solid" },
      areas: [
        {
          id: "entry",
          kind: "room",
          name: "Entry Hall",
          key: "1",
          shape: { type: "rect", x: 2, y: 4, w: 6, h: 6 },
          notes: "Dusty footprints lead east.",
        },
        {
          id: "tomb",
          kind: "room",
          name: "Tomb of the Abbot",
          key: "2",
          shape: { type: "rect", x: 11, y: 3, w: 7, h: 8 },
          readAloud: "A stone coffin rests under a cracked vault.",
        },
        {
          id: "c1",
          kind: "corridor",
          shape: { type: "route", from: "entry", to: "tomb", width: 1, bend: "hv", openings: "door" },
        },
      ],
      openings: [],
      walls: [],
      features: [{ id: "coffin", type: "sarcophagus", at: [14, 6], size: [1, 2] }],
      terrain: [],
      labels: [],
    },
  ],
  links: [],
};
