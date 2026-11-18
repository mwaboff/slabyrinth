/**
 * WP2's own small resolver fixtures (in addition to WP1's shared plans in test/fixtures/plans). They cover shape
 * kinds, edge cases of walls/openings/links and the dress presets that the shared fixtures do not exercise.
 */
import type { Level, MapPlan } from "../../../src/contracts/plan";

const level = (id: string, over: Partial<Level>): Level => ({
  id,
  name: id,
  elevation: 0,
  bounds: { x: 0, y: 0, w: 16, h: 12 },
  base: { type: "solid" },
  areas: [],
  openings: [],
  walls: [],
  features: [],
  terrain: [],
  labels: [],
  ...over,
});

const plan = (id: string, levels: Level[], over: Partial<MapPlan> = {}): MapPlan => ({
  schema: "slabyrinth/plan@1",
  generator: 1,
  id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
  title: id,
  kind: "dungeon",
  seed: 1234,
  theme: "stone_dungeon",
  levels,
  links: [],
  ...over,
});

export const EXTRA_FIXTURES: Record<string, MapPlan> = {
  shapes: plan("1", [
    level("l1", {
      bounds: { x: 0, y: 0, w: 30, h: 20 },
      areas: [
        {
          id: "poly",
          kind: "room",
          key: "1",
          shape: {
            type: "polygon",
            points: [
              [1, 1],
              [9, 1],
              [9, 4],
              [5, 8],
              [1, 8],
            ],
          },
        },
        {
          id: "rotunda",
          kind: "room",
          key: "2",
          shape: { type: "circle", cx: 15, cy: 5, r: 3.5 },
          floor: "marble",
        },
        { id: "oval", kind: "cave", key: "3", shape: { type: "ellipse", cx: 24.5, cy: 6, rx: 4, ry: 2.5 } },
        {
          id: "mask",
          kind: "room",
          key: "4",
          shape: { type: "cells", x: 2, y: 11, rows: ["####..", "######", "..####"] },
          floorHeight: -0.5,
        },
        {
          id: "hall",
          kind: "corridor",
          shape: {
            type: "path",
            points: [
              [5, 6],
              [5, 14],
              [22, 14],
            ],
            width: 2,
          },
        },
        { id: "pit", kind: "room", shape: { type: "rect", x: 22, y: 12, w: 6, h: 6 }, walls: "perimeter" },
        {
          id: "hole",
          kind: "room",
          shape: { type: "rect", x: 24, y: 14, w: 2, h: 2 },
          floor: "none",
          walls: "none",
        },
        {
          id: "r1",
          kind: "corridor",
          shape: { type: "route", from: "poly", to: "rotunda", openings: "door" },
        },
        {
          id: "r2",
          kind: "corridor",
          shape: { type: "route", from: "rotunda", to: "oval", bend: "vh", openings: "archway" },
        },
      ],
      openings: [
        { id: "o1", kind: "door", between: ["poly", "hall"] },
        { id: "o2", kind: "archway", between: ["hall", "pit"], width: 2 },
        { id: "o3", kind: "door", between: ["mask", "hall"] },
      ],
      walls: [
        {
          id: "screen",
          op: "add",
          points: [
            [3, 3],
            [3, 6],
          ],
          style: "iron_bars",
          height: 1,
        },
      ],
      terrain: [{ id: "dais", op: "height", shape: { type: "rect", x: 14, y: 4, w: 3, h: 2 }, set: 0.5 }],
    }),
  ]),
  openings: plan("2", [
    level("l1", {
      bounds: { x: 0, y: 0, w: 24, h: 10 },
      areas: [
        { id: "a", kind: "room", key: "1", shape: { type: "rect", x: 1, y: 1, w: 7, h: 7 } },
        { id: "b", kind: "room", key: "2", shape: { type: "rect", x: 8, y: 1, w: 7, h: 7 } },
        { id: "c", kind: "room", key: "3", shape: { type: "rect", x: 15, y: 1, w: 7, h: 7 } },
      ],
      openings: [
        { id: "front", kind: "double_door", between: ["a", "@outside"], position: 0.2 },
        { id: "ab", kind: "locked_door", between: ["a", "b"], position: 0.1 },
        { id: "ab2", kind: "portcullis", between: ["a", "b"], position: 0.9 },
        { id: "bc", kind: "secret_door", between: ["b", "c"] },
        { id: "win", kind: "window", at: { x: 10, y: 1, side: "N" }, width: 2 },
        { id: "slit", kind: "arrow_slit", at: { x: 21, y: 4, side: "E" } },
        { id: "gap", kind: "open", at: { x: 18, y: 7, side: "S" }, width: 2 },
        { id: "bars", kind: "bars", at: { x: 3, y: 7, side: "S" } },
        { id: "clash", kind: "door", at: { x: 10, y: 1, side: "N" } },
      ],
    }),
  ]),
  links: plan(
    "3",
    [
      level("low", {
        elevation: 0,
        areas: [{ id: "cellar", kind: "room", key: "1", shape: { type: "rect", x: 1, y: 1, w: 14, h: 10 } }],
      }),
      level("up", {
        elevation: 2.5,
        base: { type: "void" },
        areas: [
          {
            id: "loft",
            kind: "room",
            key: "2",
            shape: { type: "rect", x: 1, y: 1, w: 14, h: 10 },
            floor: "wood_plank",
          },
        ],
      }),
    ],
    {
      links: [
        {
          id: "ramp1",
          kind: "ramp",
          from: { level: "low", at: [3, 2] },
          to: { level: "up" },
          dir: "S",
          width: 2,
        },
        { id: "spiral", kind: "spiral_stairs", from: { level: "low", at: [8, 4] }, to: { level: "up" } },
        { id: "hatch", kind: "trapdoor", from: { level: "low", at: [12, 8] }, to: { level: "up" } },
        { id: "drop", kind: "pit_drop", from: { level: "low", at: [13, 2] }, to: { level: "up" } },
        { id: "bad", kind: "stairs", from: { level: "low", at: [1, 1] }, to: { level: "up" }, dir: "W" },
      ],
    },
  ),
  dress: plan("4", [
    level("l1", {
      bounds: { x: 0, y: 0, w: 34, h: 18 },
      areas: [
        {
          id: "tavern",
          kind: "room",
          key: "1",
          shape: { type: "rect", x: 1, y: 1, w: 11, h: 7 },
          floor: "wood_plank",
        },
        { id: "library", kind: "room", key: "2", shape: { type: "rect", x: 12, y: 1, w: 10, h: 7 } },
        { id: "crypt", kind: "room", key: "3", shape: { type: "rect", x: 22, y: 1, w: 10, h: 7 } },
        { id: "store", kind: "room", key: "4", shape: { type: "rect", x: 1, y: 8, w: 9, h: 7 } },
        {
          id: "throne",
          kind: "room",
          key: "5",
          shape: { type: "rect", x: 10, y: 8, w: 13, h: 8 },
          floor: "carpet",
        },
        { id: "forge", kind: "room", key: "6", shape: { type: "rect", x: 23, y: 8, w: 9, h: 7 } },
      ],
      openings: [
        { id: "d1", kind: "door", between: ["tavern", "library"] },
        { id: "d2", kind: "door", between: ["library", "crypt"] },
        { id: "d3", kind: "door", between: ["tavern", "store"] },
        { id: "d4", kind: "door", between: ["library", "throne"] },
        { id: "d5", kind: "door", between: ["throne", "forge"] },
      ],
      terrain: [
        { id: "t1", op: "dress", area: "tavern", preset: "tavern", density: 0.9 },
        { id: "t2", op: "dress", area: "library", preset: "library", density: 0.8 },
        { id: "t3", op: "dress", area: "crypt", preset: "crypt" },
        { id: "t4", op: "dress", area: "store", preset: "storeroom", density: 1 },
        { id: "t5", op: "dress", area: "throne", preset: "throne_room", density: 0.6, seed: 99 },
        { id: "t6", op: "dress", area: "forge", preset: "forge", density: 0.7 },
      ],
    }),
  ]),
  outdoor_town: plan(
    "5",
    [
      level("g", {
        bounds: { x: 0, y: 0, w: 30, h: 20 },
        base: { type: "ground", material: "grass" },
        areas: [
          { id: "square", kind: "courtyard", key: "1", shape: { type: "rect", x: 8, y: 6, w: 12, h: 8 } },
          {
            id: "inn",
            kind: "building",
            key: "2",
            shape: { type: "rect", x: 2, y: 2, w: 6, h: 5 },
            wallStyle: "wood",
          },
          {
            id: "shop",
            kind: "building",
            key: "3",
            shape: { type: "rect", x: 20, y: 2, w: 5, h: 5 },
            wallStyle: "brick",
          },
          {
            id: "garden",
            kind: "zone",
            name: "Herb garden",
            shape: { type: "rect", x: 20, y: 12, w: 8, h: 6 },
          },
          {
            id: "hedge",
            kind: "courtyard",
            shape: { type: "rect", x: 21, y: 13, w: 6, h: 4 },
            walls: "auto",
            wallStyle: "hedge",
            floor: "dirt",
          },
        ],
        openings: [
          { id: "inn_door", kind: "door", between: ["inn", "@outside"] },
          { id: "shop_door", kind: "door", between: ["shop", "@outside"], position: 0 },
          { id: "gate", kind: "open", between: ["hedge", "@outside"] },
        ],
        features: [
          { id: "well", type: "well", at: [13, 9] },
          { id: "cart", type: "wagon", at: [10, 11], rot: 90 },
          { id: "trap", type: "trap", at: [16, 8] },
          { id: "flowers", type: "flowers", at: [22, 14] },
        ],
        terrain: [
          {
            id: "road",
            op: "path",
            points: [
              [0, 16],
              [29, 16],
            ],
            width: 2,
            material: "cobble",
          },
          {
            id: "shore",
            op: "paint",
            layer: "under",
            shape: { type: "blob", cx: 4, cy: 13, r: 4.5, roughness: 0.5 },
            material: "mud",
          },
          {
            id: "pond",
            op: "paint",
            shape: { type: "blob", cx: 4, cy: 13, r: 3, roughness: 0.5 },
            material: "water_deep",
          },
        ],
        labels: [{ id: "lbl", text: "Market", at: [14, 7], size: "l" }],
      }),
    ],
    { kind: "town", theme: "town" },
  ),
};
