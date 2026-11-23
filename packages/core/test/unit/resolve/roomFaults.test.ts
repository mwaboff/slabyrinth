/**
 * The room faults the owner's screenshots showed (generator 5, switches `freeCounters`, `roomMiddles`,
 * `keptRoomsClean`), measured on the fixtures they came from:
 *   - a shop counter stood in a back corner: a free-standing anchor faced the mean of the room's doors (the middle of
 *     the room when it has a street door and a back door), and its lane could not run along a window wall. It now faces
 *     the main door (the way in from outside or a passage) and stands free where it can;
 *   - an office's middle was bare between its bookcases: a study gets a reading table group;
 *   - a skeleton and bones lay on a dungeon shop floor: the rubble at the foot of rough walls now skips a room in use
 *     whose character is intact;
 *   - every interior doorway of the building-rooms street is a real opening at least a cell wide, no blocking piece
 *     stands on either side of it, and every room is reached from the street.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { EDGE, type ResolvedFeature, type ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan, walkPathsFrom } from "../../../src/resolve";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const interiors = loadPlan("interiors-lineup-v1");
const level = (plan: typeof interiors, theme: string): ResolvedLevel =>
  resolvePlan({ ...plan, theme }, pal).levels[0] as ResolvedLevel;
const inArea = (L: ResolvedLevel, name: string): ResolvedFeature[] => {
  const a = L.areas.find((q) => q.name === name);
  return L.features.filter((f) => f.area === a?.id);
};
const cellsOf = (f: ResolvedFeature): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
    for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) out.push([x, y]);
  return out;
};

describe("the shop counter", () => {
  for (const theme of ["wood_town", "stone_dungeon"])
    it(`stands free of the walls, facing the street door (${theme})`, () => {
      const L = level(interiors, theme);
      const counter = inArea(L, "Chandler's shop").find((f) => f.type === "counter");
      expect(counter).toBeDefined();
      const g = new LevelGrid(L);
      const c = counter as ResolvedFeature;
      // free: no wall touches its outline
      const walls = cellsOf(c).filter(([x, y]) =>
        (["N", "E", "S", "W"] as Side[]).some((s) => g.edgeKind(x, y, s) === EDGE.WALL),
      );
      expect(walls, JSON.stringify(c)).toEqual([]);
      // facing the street door (the shop's south wall, on the lane): rot 0 faces south
      expect(c.rot).toBe(0);
    });

  it("without the switch it stands against a wall, side-on to the street door", () => {
    P5.freeCounters = false;
    const L = level(interiors, "wood_town");
    const c = inArea(L, "Chandler's shop").find((f) => f.type === "counter") as ResolvedFeature;
    const g = new LevelGrid(L);
    const free = cellsOf(c).every(([x, y]) =>
      (["N", "E", "S", "W"] as Side[]).every((s) => g.edgeKind(x, y, s) !== EDGE.WALL),
    );
    expect(free && c.rot === 0).toBe(false);
  });
});

describe("room middles and kept rooms", () => {
  it("gives the office a table group in its middle, off every wall", () => {
    const L = level(interiors, "wood_town");
    const office = L.areas.find((a) => a.name === "Office");
    const g = new LevelGrid(L);
    const tables = inArea(L, "Office").filter(
      (f) =>
        f.type === "table" &&
        cellsOf(f).every(([x, y]) =>
          (["N", "E", "S", "W"] as Side[]).every((s) => g.edgeKind(x, y, s) !== EDGE.WALL),
        ),
    );
    expect(tables.length, office?.id).toBeGreaterThanOrEqual(1);
    P5.roomMiddles = false;
    const before = level(interiors, "wood_town");
    expect(inArea(before, "Office").filter((f) => f.type === "table")).toEqual([]);
  });

  it("leaves no rubble or debris in a dungeon's rooms in use, but keeps it in its passages", () => {
    const L = level(interiors, "stone_dungeon");
    const used = ["Taproom", "Chandler's shop", "Office", "Parlour", "Sick ward", "Kitchen"];
    for (const name of used)
      expect(
        inArea(L, name).filter((f) => f.type === "debris" || f.type === "rubble"),
        name,
      ).toEqual([]);
    P5.keptRoomsClean = false;
    const before = level(interiors, "stone_dungeon");
    const debris = used
      .flatMap((n) => inArea(before, n))
      .filter((f) => f.type === "debris" || f.type === "rubble");
    expect(debris.length).toBeGreaterThan(0);
  });
});

describe("building-rooms-street-v1 doorways", () => {
  for (const theme of ["wood_town", "stone_dungeon"])
    it(`opens every interior doorway a cell wide or more, unblocked, and reaches every room (${theme})`, () => {
      const plan = { ...loadPlan("building-rooms-street-v1"), theme };
      const resolved = resolvePlan(plan, pal);
      const L = resolved.levels[0] as ResolvedLevel;
      const g = new LevelGrid(L);
      const blocked = new Set<string>();
      for (const f of L.features) if (f.blocking) for (const [x, y] of cellsOf(f)) blocked.add(`${x},${y}`);
      const inner = L.openings.filter((o) => o.id.includes("~inner"));
      expect(inner.length).toBeGreaterThanOrEqual(5);
      for (const o of inner) {
        expect(o.width, o.id).toBeGreaterThanOrEqual(1);
        for (let k = 0; k < o.width; k++) {
          // the two cells either side of the doorway's edge
          const [x, y] = o.orientation === "h" ? [o.start[0] + k, o.start[1]] : [o.start[0], o.start[1] + k];
          const side: Side = o.orientation === "h" ? "N" : "W";
          // a door is an opening; an open way removes the wall
          expect([EDGE.OPENING, EDGE.NONE], o.id).toContain(g.edgeKind(x, y, side));
          const before: [number, number] = o.orientation === "h" ? [x, y - 1] : [x - 1, y];
          expect(blocked.has(`${x},${y}`), `${o.id} ${x},${y}`).toBe(false);
          expect(blocked.has(`${before[0]},${before[1]}`), `${o.id} ${before.join(",")}`).toBe(false);
        }
      }
      const walk = walkPathsFrom(resolved, undefined).reached.get("g") as Uint8Array;
      for (const r of L.areas.filter((a) => a.building !== undefined)) {
        const ai = L.areaIds.indexOf(r.id) + 1;
        expect(
          L.cells.area.some((a, i) => a === ai && walk[i] === 1),
          r.id,
        ).toBe(true);
      }
    });
});
