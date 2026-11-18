/**
 * Wall rule and host-cell rule test matrix (architecture §2.4 steps 5 and 10).
 * Each case: two neighbouring cells A (west) and B (east) on one row; we read the vertical edge between them.
 */
import { describe, expect, it } from "vitest";
import type { Area, Level, LevelBase, MapPlan, WallRun } from "../../../src/contracts/plan";
import { EDGE } from "../../../src/contracts/resolved";
import { resolvePlan } from "../../../src/resolve/index";

function planOf(base: LevelBase, areas: Area[], walls: WallRun[] = [], w = 12, h = 5): MapPlan {
  const level: Level = {
    id: "l1",
    name: "L",
    elevation: 0,
    bounds: { x: 0, y: 0, w, h },
    base,
    areas,
    openings: [],
    walls,
    features: [],
    terrain: [],
    labels: [],
  };
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "t",
    title: "t",
    kind: "dungeon",
    seed: 1,
    theme: "stone_dungeon",
    levels: [level],
    links: [],
  };
}

/** Vertical edge at vertex x on row y: [kind, host, height]. */
function vEdge(plan: MapPlan, x: number, y = 2): [number, number, number] {
  const l = resolvePlan(plan).levels[0];
  if (!l) throw new Error("no level");
  const i = y * (l.bounds.w + 1) + x;
  return [l.vEdges.kind[i] as number, l.vEdges.host[i] as number, l.vEdges.height[i] as number];
}

const rect = (x: number, y: number, w: number, h: number) => ({ type: "rect" as const, x, y, w, h });
const room = (id: string, x: number, w: number, extra: Partial<Area> = {}): Area => ({
  id,
  kind: "room",
  shape: rect(x, 1, w, 3),
  ...extra,
});

const SOLID: LevelBase = { type: "solid" };
const VOID: LevelBase = { type: "void" };
const GRASS: LevelBase = { type: "ground", material: "grass" };

describe("wall test and host rule", () => {
  const cases: Array<[string, MapPlan, number, [number, number]]> = [
    ["room | rock → wall hosted in rock (rule 1)", planOf(SOLID, [room("a", 2, 4)]), 6, [EDGE.WALL, 1]],
    ["rock | room → wall hosted in rock (rule 1)", planOf(SOLID, [room("a", 2, 4)]), 2, [EDGE.WALL, 0]],
    ["room | void → hosted in void", planOf(VOID, [room("a", 2, 4)]), 6, [EDGE.WALL, 1]],
    [
      "building | grass → hosted on grass (rule 2)",
      planOf(GRASS, [room("a", 2, 4, { kind: "building" })]),
      6,
      [EDGE.WALL, 1],
    ],
    [
      "grass | building → hosted on grass (rule 2)",
      planOf(GRASS, [room("a", 2, 4, { kind: "building" })]),
      2,
      [EDGE.WALL, 0],
    ],
    [
      "big room | corridor → hosted in the room (rule 3)",
      planOf(SOLID, [room("a", 1, 5), { id: "c", kind: "corridor", shape: rect(6, 2, 4, 1) }]),
      6,
      [EDGE.WALL, 0],
    ],
    [
      "corridor | big room → hosted in the room (rule 3)",
      planOf(SOLID, [{ id: "c", kind: "corridor", shape: rect(1, 2, 4, 1) }, room("b", 5, 5)]),
      5,
      [EDGE.WALL, 1],
    ],
    [
      "equal rooms → second (east) hosts (rule 4)",
      planOf(SOLID, [room("a", 1, 4), room("b", 5, 4)]),
      5,
      [EDGE.WALL, 1],
    ],
    [
      "perimeter | perimeter → open",
      planOf(SOLID, [room("a", 1, 4, { walls: "perimeter" }), room("b", 5, 4, { walls: "perimeter" })]),
      5,
      [EDGE.NONE, 0],
    ],
    [
      "perimeter | auto → wall",
      planOf(SOLID, [room("a", 1, 4, { walls: "perimeter" }), room("b", 5, 5)]),
      5,
      [EDGE.WALL, 1],
    ],
    [
      "courtyard | grass → no wall",
      planOf(GRASS, [room("a", 2, 4, { kind: "courtyard" })]),
      6,
      [EDGE.NONE, 0],
    ],
    [
      "courtyard | rock → wall in rock",
      planOf(SOLID, [room("a", 2, 4, { kind: "courtyard" })]),
      6,
      [EDGE.WALL, 1],
    ],
    ["walls none | rock → no wall", planOf(SOLID, [room("a", 2, 4, { walls: "none" })]), 6, [EDGE.NONE, 0]],
    [
      "zone is transparent: building | zone-over-grass → hosted on grass",
      planOf(GRASS, [
        { id: "z", kind: "zone", shape: rect(0, 0, 12, 5) },
        room("a", 2, 4, { kind: "building" }),
      ]),
      6,
      [EDGE.WALL, 1],
    ],
    [
      "zone between two rooms does not create walls",
      planOf(SOLID, [
        room("a", 1, 8, { walls: "perimeter" }),
        { id: "z", kind: "zone", shape: rect(5, 0, 4, 5) },
      ]),
      5,
      [EDGE.NONE, 0],
    ],
    ["room at the level border hosts in bounds", planOf(SOLID, [room("a", 0, 4)]), 0, [EDGE.WALL, 1]],
    [
      "explicit wall run hosts on the second cell",
      planOf(
        SOLID,
        [room("a", 1, 8)],
        [
          {
            id: "w",
            op: "add",
            points: [
              [5, 1],
              [5, 4],
            ],
          },
        ],
      ),
      5,
      [EDGE.WALL, 1],
    ],
    [
      "wall run remove clears a wall",
      planOf(
        SOLID,
        [room("a", 2, 4)],
        [
          {
            id: "w",
            op: "remove",
            points: [
              [6, 0],
              [6, 5],
            ],
          },
        ],
      ),
      6,
      [EDGE.NONE, 0],
    ],
  ];
  it.each(cases)("%s", (_name, plan, x, [kind, host]) => {
    const [k, hst] = vEdge(plan, x);
    expect(k).toBe(kind);
    if (kind !== EDGE.NONE) expect(hst).toBe(host);
  });

  it("ledge where floor heights differ by ≥ 0.25 and no wall", () => {
    const plan = planOf(SOLID, [
      room("a", 1, 8, { walls: "perimeter" }),
      room("dais", 5, 4, { walls: "perimeter", floorHeight: 0.75 }),
    ]);
    expect(vEdge(plan, 5)).toEqual([EDGE.LEDGE, 0, 0.75]);
  });

  it("wall height: area wallHeight, else level wallHeight, else 2", () => {
    expect(vEdge(planOf(SOLID, [room("a", 2, 4)]), 6)[2]).toBe(2);
    expect(vEdge(planOf(SOLID, [room("a", 2, 4, { wallHeight: 3.5 })]), 6)[2]).toBe(3.5);
    const p = planOf(SOLID, [room("a", 2, 4)]);
    (p.levels[0] as Level).wallHeight = 1.5;
    expect(vEdge(p, 6)[2]).toBe(1.5);
  });

  it("room beside a cave gets a thin wall whichever area is bigger; two caves merge", () => {
    for (const [rw, cw] of [
      [3, 6],
      [6, 3],
    ] as const) {
      const p = planOf(SOLID, [room("r", 1, rw), room("c", 1 + rw, cw, { kind: "cave" })]);
      const l = resolvePlan(p).levels[0];
      if (!l) throw new Error("level");
      const e = 2 * (l.bounds.w + 1) + 1 + rw;
      expect([l.vEdges.kind[e], l.wallStyles[l.vEdges.ref[e] as number]], `room ${rw} cave ${cw}`).toEqual([
        EDGE.WALL,
        "wall",
      ]);
    }
    const caves = planOf(SOLID, [room("a", 1, 3, { kind: "cave" }), room("b", 4, 6, { kind: "cave" })]);
    expect(vEdge(caves, 4)[0]).toBe(EDGE.NONE);
  });

  it("cave walls default to cave_rock style; others to the theme wall", () => {
    const l = resolvePlan(planOf(SOLID, [room("a", 1, 4, { kind: "cave" }), room("b", 6, 4)])).levels[0];
    expect(l?.wallStyles).toEqual(["cave_rock", "wall"]);
  });

  it("route corridors claim only unowned cells and keep 1-wide corridors from hosting room walls", () => {
    const plan = planOf(SOLID, [
      room("a", 0, 3),
      room("b", 8, 3),
      { id: "c", kind: "corridor", shape: { type: "route", from: "a", to: "b", width: 1, openings: "door" } },
    ]);
    const l = resolvePlan(plan).levels[0];
    if (!l) throw new Error("level");
    expect(l.areas.find((a) => a.id === "c")?.bbox).toEqual({ x: 3, y: 2, w: 5, h: 1 });
    expect(l.openings.map((o) => [o.id, o.kind, o.orientation, o.start])).toEqual([
      ["c~a", "door", "v", [3, 2]],
      ["c~b", "door", "v", [8, 2]],
    ]);
    // door edges between corridor (5 cells) and rooms (9 cells) are hosted in the rooms
    expect(vEdge(plan, 3)[1]).toBe(0);
    expect(vEdge(plan, 8)[1]).toBe(1);
  });
});
