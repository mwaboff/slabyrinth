/**
 * The layout notes (review/layoutNotes.ts, generator 5): each fires on a small complex built for it, stays silent on
 * the same complex without the fault, and is not given to a plan of a generator without its switch (the same resolved
 * map reviewed as generator 4). Plans are written inline.
 */
import { describe, expect, it } from "vitest";
import type { Area, MapPlan, Opening } from "../../../src/contracts/plan";
import type { ResolvedPlan } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign, type DesignNoteCode } from "../../../src/review";
import { mapLayout } from "../../../src/review/layout";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

const room = (id: string, x: number, y: number, w = 4, h = 4): Area => ({
  id,
  kind: "room",
  name: `Chamber ${id}`,
  shape: { type: "rect", x, y, w, h },
});
const door = (a: string, b: string): Opening => ({ id: `${a}-${b}`, kind: "door", between: [a, b] });

/** Every note's code at generator 5 and, on the same resolved map, at generator 4. */
function codes(p: MapPlan, edit?: (r: ResolvedPlan) => void): { g5: DesignNoteCode[]; g4: DesignNoteCode[] } {
  const r = resolvePlan(p, pal);
  edit?.(r);
  const of = (plan: MapPlan): DesignNoteCode[] =>
    reviewDesign(plan, r, pal, { limit: 999 }).map((n) => n.code);
  return { g5: of(p), g4: of({ ...p, generator: 4 }) };
}

/** A row of rooms joined door to door, each `w` wide, plus `extra` areas and openings. */
function row(
  n: number,
  w: (i: number) => number,
  extra: { areas?: Area[]; openings?: Opening[] } = {},
): MapPlan {
  const areas: Area[] = [];
  let x = 1;
  for (let i = 0; i < n; i++) {
    areas.push(room(`r${i}`, x, 1, w(i), 4));
    x += w(i);
  }
  const openings = areas.slice(1).map((a, i) => door(`r${i}`, a.id));
  return dungeonPlan({
    generator: 5,
    w: x + 2,
    h: 14,
    areas: [...areas, ...(extra.areas ?? [])],
    openings: [...openings, ...(extra.openings ?? [])],
  });
}

describe("layout notes (generator 5)", () => {
  it("dead_end_empty: two empty rooms off a hall; a chest in one of them settles it", () => {
    const p = dungeonPlan({
      generator: 5,
      w: 20,
      h: 12,
      // a loop hub - b - d - c - hub, and two rooms off it with one door each: a and e
      areas: [
        room("hub", 1, 1, 8, 4),
        room("a", 1, 5),
        room("b", 5, 5),
        room("c", 9, 1),
        room("d", 9, 5),
        room("e", 13, 1),
      ],
      openings: [
        door("hub", "a"),
        door("hub", "b"),
        door("b", "d"),
        door("d", "c"),
        door("c", "hub"),
        door("c", "e"),
      ],
    });
    const empty = codes(p, (r) => {
      for (const L of r.levels) L.features = L.features.filter((f) => f.area === "hub");
    });
    expect(empty.g5).toContain("dead_end_empty");
    expect(empty.g4).not.toContain("dead_end_empty");
    const one = codes(p, (r) => {
      for (const L of r.levels) {
        L.features = L.features.filter((f) => f.area === "hub");
        L.features.push({
          id: "chest",
          type: "chest",
          at: [2, 6],
          size: [1, 1],
          rot: 0,
          rotFine: 0,
          baseHeight: 0.5,
          theme: "stone_dungeon",
          area: "a",
          blocking: true,
        });
      }
    });
    expect(one.g5).not.toContain("dead_end_empty");
  });

  it("rooms_same_size: six rooms of one size; one twice the median breaks it", () => {
    expect(codes(row(6, () => 4)).g5).toContain("rooms_same_size");
    expect(codes(row(6, () => 4)).g4).not.toContain("rooms_same_size");
    expect(codes(row(6, (i) => (i === 2 ? 9 : 4))).g5).not.toContain("rooms_same_size");
  });

  it("corridor_heavy: rooms strung on long corridors; rooms that touch are fine", () => {
    const strung = dungeonPlan({
      generator: 5,
      w: 40,
      h: 14,
      areas: [
        room("a", 1, 1),
        { id: "c1", kind: "corridor", shape: { type: "rect", x: 5, y: 2, w: 12, h: 2 } },
        room("b", 17, 1),
        { id: "c2", kind: "corridor", shape: { type: "rect", x: 21, y: 2, w: 12, h: 2 } },
        room("c", 33, 1),
        room("d", 33, 5),
      ],
      openings: [door("a", "c1"), door("c1", "b"), door("b", "c2"), door("c2", "c"), door("c", "d")],
    });
    expect(codes(strung).g5).toContain("corridor_heavy");
    expect(codes(strung).g4).not.toContain("corridor_heavy");
    expect(codes(row(4, () => 4)).g5).not.toContain("corridor_heavy");
  });

  it("entrances_few: twelve rooms with one way in; doors to the outside at both ends make two", () => {
    const closed = row(12, (i) => (i % 3 === 0 ? 6 : 4), {
      openings: [{ id: "gate", kind: "door", between: ["r0", "@outside"] }],
    });
    expect(mapLayout(resolvePlan(closed, pal)).entrances).toBe(1);
    expect(codes(closed).g5).toContain("entrances_few");
    expect(codes(closed).g4).not.toContain("entrances_few");
    const open = row(12, (i) => (i % 3 === 0 ? 6 : 4), {
      openings: [
        { id: "gate", kind: "door", between: ["r0", "@outside"] },
        { id: "back", kind: "door", between: ["r11", "@outside"] },
      ],
    });
    expect(mapLayout(resolvePlan(open, pal)).entrances).toBe(2);
    expect(codes(open).g5).not.toContain("entrances_few");
  });

  it("drop_trap_dead: a pit drop into a room with no way back up; a ladder beside it settles it", () => {
    const levels = (ladder: boolean): MapPlan => {
      const p = dungeonPlan({
        generator: 5,
        w: 14,
        h: 10,
        levelId: "up",
        areas: [room("top", 2, 2, 8, 6)],
      });
      const up = p.levels[0];
      if (!up) throw new Error("no level");
      return {
        ...p,
        entryLevel: "up",
        levels: [{ ...up, id: "low", name: "low", elevation: -4, areas: [room("pit", 2, 2, 8, 6)] }, up],
        links: [
          { id: "drop", kind: "pit_drop", from: { level: "low", at: [4, 4] }, to: { level: "up" } },
          ...(ladder
            ? [
                {
                  id: "ladder",
                  kind: "ladder" as const,
                  from: { level: "low", at: [8, 5] as [number, number] },
                  to: { level: "up" },
                },
              ]
            : []),
        ],
      };
    };
    expect(codes(levels(false)).g5).toContain("drop_trap_dead");
    expect(codes(levels(false)).g4).not.toContain("drop_trap_dead");
    expect(codes(levels(true)).g5).not.toContain("drop_trap_dead");
  });
});
