/**
 * Large synthetic plans for the size tests and measurements (test/unit/compile/sizeCap.test.ts, test/sweep/sizes.ts):
 * a dungeon of stacked levels, each a dense grid of named rooms with a door through every shared wall, a ladder from
 * each level to the one above; and an outdoor level with ground noise and scattered trees and rocks. Original layouts,
 * generated from the side length, so a plan exists at any size up to the plan limit.
 */
import type { Area, Feature, LevelLink, MapPlan, Opening, TerrainOp } from "../../src/contracts/plan";

const ROOM_NAMES = [
  "Guard Room",
  "Barracks",
  "Storeroom",
  "Kitchen",
  "Library",
  "Shrine",
  "Armoury",
  "Cell Block",
  "Wine Cellar",
  "Study",
] as const;

/** Storey step between the dungeon's levels, in tiles. */
export const LARGE_DUNGEON_STOREY = 4;

/**
 * A dungeon of `levels` levels, each `side` × `side` cells, carved from solid rock into `rooms` × `rooms` rooms that
 * share their walls (a door in the middle of each shared wall). Level k stands LARGE_DUNGEON_STOREY × k tiles up; a
 * ladder in a corner room joins each level to the one above. Rooms per side default to 12 (144 rooms, 264 doors per
 * level, under the plan's per-level limits).
 */
export function largeDungeonPlan(side: number, levels = 1, rooms = 12, generator: 4 = 4): MapPlan {
  const pitch = Math.floor((side - 2) / rooms);
  const levelIds = Array.from({ length: levels }, (_, k) => `l${k + 1}`);
  const roomId = (k: number, i: number, j: number): string => `l${k + 1}r${i}_${j}`;
  const links: LevelLink[] = levelIds.slice(1).map((up, k) => ({
    id: `ladder_${k + 1}`,
    kind: "ladder",
    // alternate corners so the ladders do not stack
    from: {
      level: levelIds[k] ?? "l1",
      at: k % 2 === 0 ? [2, 2] : [1 + rooms * pitch - 2, 1 + rooms * pitch - 2],
    },
    to: { level: up },
    label: `Ladder up to level ${k + 2}`,
  }));
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: `5e1f0c2a-7b3d-4e8f-9a01-${String(side).padStart(6, "0")}${String(levels).padStart(6, "0")}`,
    title: `Large dungeon ${side} x ${side}, ${levels} level${levels > 1 ? "s" : ""}`,
    kind: "dungeon",
    seed: side * 31 + levels,
    theme: "stone_dungeon",
    links,
    levels: levelIds.map((id, k) => {
      const areas: Area[] = [];
      const openings: Opening[] = [];
      for (let j = 0; j < rooms; j++)
        for (let i = 0; i < rooms; i++) {
          areas.push({
            id: roomId(k, i, j),
            kind: "room",
            name: ROOM_NAMES[(i * 3 + j * 7 + k) % ROOM_NAMES.length] ?? "Room",
            shape: { type: "rect", x: 1 + i * pitch, y: 1 + j * pitch, w: pitch, h: pitch },
          });
          if (i > 0)
            openings.push({
              id: `l${k + 1}d${i}_${j}w`,
              kind: "door",
              between: [roomId(k, i - 1, j), roomId(k, i, j)],
            });
          if (j > 0)
            openings.push({
              id: `l${k + 1}d${i}_${j}n`,
              kind: "door",
              between: [roomId(k, i, j - 1), roomId(k, i, j)],
            });
        }
      return {
        id,
        name: `Level ${k + 1}`,
        elevation: LARGE_DUNGEON_STOREY * k,
        bounds: { x: 0, y: 0, w: side, h: side },
        base: { type: "solid" },
        areas,
        openings,
        walls: [],
        features: [] as Feature[],
        terrain: [],
        labels: [],
      };
    }),
  };
}

/** An outdoor level `side` × `side`: grass with dirt patches, a winding trail, trees and rocks scattered over it. */
export function largeOutdoorPlan(side: number, generator: 4 = 4): MapPlan {
  const terrain: TerrainOp[] = [
    {
      id: "dirt",
      op: "noise",
      shape: { type: "rect", x: 0, y: 0, w: side, h: side },
      material: "dirt",
      coverage: 0.25,
      scale: 6,
    },
    {
      id: "trail",
      op: "path",
      points: [
        [0, Math.floor(side * 0.7)],
        [Math.floor(side * 0.4), Math.floor(side * 0.45)],
        [side - 1, Math.floor(side * 0.6)],
      ],
      width: 1,
      material: "dirt",
      jitter: 0.2,
    },
    { id: "trees", op: "scatter", feature: "tree", density: 0.06, minSpacing: 2 },
    { id: "rocks", op: "scatter", feature: "rock", density: 0.02, randomRotation: true, seed: 77 },
  ] as TerrainOp[];
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: `5e1f0c2a-7b3d-4e8f-9a01-0000${String(side).padStart(8, "0")}`,
    title: `Large forest ${side} x ${side}`,
    kind: "outdoor",
    seed: side * 17,
    theme: "outdoor",
    links: [],
    levels: [
      {
        id: "g",
        name: "Forest",
        elevation: 0,
        bounds: { x: 0, y: 0, w: side, h: side },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
      },
    ],
  };
}

/**
 * A typical mixed map: the forest of largeOutdoorPlan with a village of 64 huts on an 8 × 8 grid round the middle
 * (each a wooden building with a door to the outside and a fire in front), the trees and rocks kept off the village.
 */
export function largeMixedPlan(side: number, generator: 4 = 4): MapPlan {
  const plan = largeOutdoorPlan(side, generator);
  const level = plan.levels[0];
  if (!level) return plan;
  plan.title = `Large forest village ${side} x ${side}`;
  const huts = 8;
  const pitch = 10;
  const x0 = Math.floor(side / 2 - (huts * pitch) / 2);
  const y0 = x0;
  const village: Area[] = [];
  const doors: Opening[] = [];
  const fires: Feature[] = [];
  for (let j = 0; j < huts; j++)
    for (let i = 0; i < huts; i++) {
      const id = `hut${i}_${j}`;
      const x = x0 + i * pitch + 2;
      const y = y0 + j * pitch + 2;
      village.push({
        id,
        kind: "building",
        name: ROOM_NAMES[(i + j) % ROOM_NAMES.length] ?? "Hut",
        shape: { type: "rect", x, y, w: 6, h: 5 },
        floor: "wood_plank",
        wallStyle: "wood",
      });
      doors.push({ id: `${id}_door`, kind: "door", between: [id, "@outside"], position: 0.5 });
      fires.push({ id: `${id}_fire`, type: "campfire", at: [x + 3, y + 7] });
    }
  level.areas = village;
  level.openings = doors;
  level.features = fires;
  const keepOff = { type: "rect", x: x0, y: y0, w: huts * pitch, h: huts * pitch };
  level.terrain = level.terrain.map((op) =>
    op.op === "scatter" ? ({ ...op, exclude: [keepOff] } as TerrainOp) : op,
  );
  return plan;
}
