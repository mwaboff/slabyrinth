/**
 * Playability checks: one fixture per issue code, the in-game single-room regression, "no new errors" on the
 * shared fixtures, a never-throws fuzz pass and the speed target.
 */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  Area,
  Feature,
  Level,
  LevelLink,
  MapPlan,
  Opening,
  PlanIssue,
} from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { checkPlayability, resolvePlan, walkReachability } from "../../../src/resolve/index";
import { asciiView } from "../../../src/text/index";
import { VALID_PLAN_FIXTURES, loadPlan } from "../../fixtures/index";
import { EXTRA_FIXTURES } from "../../golden/resolve/extraFixtures";

const room = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Area> = {}): Area => ({
  id,
  kind: "room",
  shape: { type: "rect", x, y, w, h },
  ...extra,
});

function plan(over: Partial<Level>, more: Partial<Level>[] = [], links: LevelLink[] = []): MapPlan {
  const lvl = (id: string, elevation: number, o: Partial<Level>): Level => ({
    id,
    name: id,
    elevation,
    bounds: { x: 0, y: 0, w: 20, h: 12 },
    base: { type: "solid" },
    areas: [],
    openings: [],
    walls: [],
    features: [],
    terrain: [],
    labels: [],
    ...o,
  });
  return {
    schema: "slabyrinth/plan@1",
    generator: 1,
    id: "p",
    title: "p",
    kind: "dungeon",
    seed: 5,
    theme: "stone_dungeon",
    entryLevel: "l1",
    levels: [lvl("l1", 0, over), ...more.map((m, k) => lvl(`l${k + 2}`, 2.5 * (k + 1), m))],
    links,
  };
}

/** Two keyed rooms side by side (x 1..7 and 8..14, y 1..6) joined by `door`. */
function twoRooms(
  features: Feature[] = [],
  openings: Opening[] = [{ id: "door", kind: "door", between: ["a", "b"] }],
): MapPlan {
  return plan({
    areas: [room("a", 1, 1, 7, 6, { key: "1" }), room("b", 8, 1, 7, 6, { key: "2" })],
    openings,
    features,
  });
}

const run = (p: MapPlan): PlanIssue[] => checkPlayability(p, resolvePlan(p, bundledPalettes()));
const pick = (issues: PlanIssue[], code: string): PlanIssue[] => issues.filter((i) => i.code === code);

describe("issue codes (one fixture each)", () => {
  it("a bed in front of the only door → one opening_blocked error naming the bed, keyed or not", () => {
    // door between a and b is mid-wall at x = 8, y 1..6 → edge v 8,3; b's approach cell is (8,3)
    for (const keyed of [true, false]) {
      const q = twoRooms([{ id: "bed", type: "bed", at: [8, 3] }]);
      if (!keyed) for (const a of q.levels[0]?.areas ?? []) delete a.key;
      const issues = run(q);
      expect(
        issues.map((i) => [i.severity, i.code, i.elementId]),
        `keyed ${keyed}`,
      ).toEqual([["error", "opening_blocked", "door"]]);
      expect(issues[0]?.message).toContain('the bed "bed"');
      expect(issues[0]?.cell).toEqual([8, 3]);
    }
  });

  it("opening_blocked: a crate in front of one of two doors → warning naming the crate", () => {
    const p = twoRooms(
      [{ id: "crate", type: "crate", at: [8, 1] }],
      [
        { id: "door", kind: "door", between: ["a", "b"] },
        { id: "door2", kind: "door", at: { x: 7, y: 1, side: "E" } },
      ],
    );
    const ob = pick(run(p), "opening_blocked");
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ severity: "warning", elementId: "door2", cell: [8, 1] });
    expect(ob[0]?.message).toContain('the crate "crate"');
  });

  it("opening_dead_end: rock → warning, void → info, @outside → nothing", () => {
    const rock = run(
      plan({
        areas: [room("a", 2, 2, 5, 4, { key: "1" })],
        openings: [{ id: "d", kind: "door", at: { x: 2, y: 3, side: "W" } }],
      }),
    );
    expect(pick(rock, "opening_dead_end")[0]).toMatchObject({ severity: "warning", elementId: "d" });
    const air = run(
      plan({
        base: { type: "void" },
        areas: [room("a", 2, 2, 5, 4, { key: "1" })],
        openings: [{ id: "d", kind: "door", at: { x: 2, y: 3, side: "W" } }],
      }),
    );
    expect(pick(air, "opening_dead_end")[0]).toMatchObject({ severity: "info" });
    const exit = run(
      plan({
        areas: [room("a", 2, 2, 5, 4, { key: "1" })],
        openings: [{ id: "d", kind: "door", between: ["a", "@outside"] }],
      }),
    );
    expect(pick(exit, "opening_dead_end")).toEqual([]);
  });

  it("reachable_secret_only: only a secret door into room 2 → info", () => {
    const issues = run(twoRooms([], [{ id: "sd", kind: "secret_door", between: ["a", "b"] }]));
    expect(issues.map((i) => [i.severity, i.code, i.elementId])).toEqual([
      ["info", "reachable_secret_only", "b"],
    ]);
  });

  it("area_sealed: a keyed room with no way in → error, not also unreachable", () => {
    const issues = run(twoRooms([], []));
    expect(issues.map((i) => [i.severity, i.code, i.elementId])).toEqual([["error", "area_sealed", "b"]]);
  });

  const tower = (f1: Feature[] = [], f2: Feature[] = []): MapPlan =>
    plan(
      { areas: [room("a", 1, 1, 10, 9, { key: "1" })], features: f1 },
      [{ base: { type: "void" }, areas: [room("b", 1, 1, 10, 9, { key: "2" })], features: f2 }],
      [{ id: "st", kind: "stairs", from: { level: "l1", at: [5, 7] }, to: { level: "l2" }, dir: "N" }],
    );

  it("link_approach_blocked: a chest at the foot of the stairs and a table on the landing", () => {
    expect(run(tower())).toEqual([]);
    const foot = pick(run(tower([{ id: "chest", type: "chest", at: [5, 8] }])), "link_approach_blocked");
    expect(foot[0]).toMatchObject({ severity: "error", elementId: "st", levelId: "l1", cell: [5, 8] });
    expect(foot[0]?.message).toContain('the chest "chest"');
    const top = pick(run(tower([], [{ id: "tbl", type: "table", at: [5, 4] }])), "link_approach_blocked");
    expect(top[0]).toMatchObject({ severity: "error", levelId: "l2", cell: [5, 4] });
  });

  it("link_approach_blocked: stairs arriving against the upper room's wall (no walk move either)", () => {
    const q = plan(
      { areas: [room("a", 1, 1, 6, 9, { key: "1" })] },
      [{ base: { type: "void" }, areas: [room("b", 1, 1, 6, 5, { key: "2" })] }],
      [{ id: "st", kind: "stairs", from: { level: "l1", at: [3, 8] }, to: { level: "l2" }, dir: "N" }],
    );
    const issues = run(q);
    const lab = pick(issues, "link_approach_blocked")[0];
    expect(lab).toMatchObject({ severity: "error", elementId: "st", levelId: "l2", cell: [3, 5] });
    expect(lab?.message).toContain("a wall stands between the stairwell and that landing");
    expect(pick(issues, "unreachable")[0]).toMatchObject({ elementId: "b" });
    expect(
      walkReachability(q, resolvePlan(q, bundledPalettes()))
        .get("l2")
        ?.some((v) => v === 1),
    ).toBe(false);
  });

  it("trapdoors are walkable downwards only; an area reachable only upward through one is a warning", () => {
    const up = plan(
      { areas: [room("a", 1, 1, 8, 8, { key: "1" })] },
      [{ areas: [room("b", 1, 1, 8, 8, { key: "2" })] }],
      [{ id: "hatch", kind: "trapdoor", from: { level: "l1", at: [4, 4] }, to: { level: "l2" } }],
    );
    const u = pick(run(up), "unreachable")[0];
    expect(u).toMatchObject({ severity: "warning", elementId: "b" });
    expect(u?.hint).toBe("add a ladder link beside the trapdoor");
    // entering on the upper level: the trapdoor leads down, so the lower room is reachable
    const down = structuredClone(up);
    down.entryLevel = "l2";
    expect(pick(run(down), "unreachable")).toEqual([]);
  });

  it("pit drops are one-way down", () => {
    const pit = plan(
      { areas: [room("a", 1, 1, 8, 8, { key: "1" })] },
      [{ areas: [room("b", 1, 1, 8, 8, { key: "2" })] }],
      [{ id: "pit", kind: "pit_drop", from: { level: "l1", at: [4, 4] }, to: { level: "l2" } }],
    );
    expect(pick(run(pit), "unreachable")[0]).toMatchObject({ elementId: "b" });
    const down = structuredClone(pit);
    down.entryLevel = "l2";
    expect(pick(run(down), "unreachable")).toEqual([]);
  });

  it("link_run_blocked: a wall run across the stair run", () => {
    const p = tower();
    p.levels[0]?.walls.push({
      id: "w",
      op: "add",
      points: [
        [4, 6],
        [7, 6],
      ],
    });
    expect(pick(run(p), "link_run_blocked")[0]).toMatchObject({ severity: "error", elementId: "st" });
  });

  it("passage_blocked: a barrel plugging one of two corridors", () => {
    const p = plan({
      areas: [
        room("a", 1, 1, 4, 8, { key: "1" }),
        room("b", 12, 1, 4, 8, { key: "2" }),
        { id: "c1", kind: "corridor", shape: { type: "rect", x: 5, y: 2, w: 7, h: 1 } },
        { id: "c2", kind: "corridor", shape: { type: "rect", x: 5, y: 6, w: 7, h: 1 } },
      ],
      openings: [
        { id: "o1", kind: "open", between: ["a", "c1"] },
        { id: "o2", kind: "open", between: ["c1", "b"] },
        { id: "o3", kind: "open", between: ["a", "c2"] },
        { id: "o4", kind: "open", between: ["c2", "b"] },
      ],
      features: [{ id: "barrel", type: "barrel", at: [8, 2] }],
    });
    const issues = run(p);
    expect(issues.map((i) => [i.severity, i.code, i.elementId])).toEqual([
      ["warning", "passage_blocked", "barrel"],
    ]);
  });

  it("feature_not_at_wall and seat_detached", () => {
    const p = plan({
      areas: [room("a", 1, 1, 10, 9, { key: "1" })],
      features: [
        { id: "shelf_ok", type: "bookshelf", at: [1, 1] },
        { id: "shelf_mid", type: "bookshelf", at: [4, 5] },
        { id: "table", type: "table", at: [6, 2] },
        { id: "chair_ok", type: "chair", at: [6, 3], rot: 180 },
        { id: "chair_far", type: "chair", at: [9, 2] },
        { id: "chair_alone", type: "chair", at: [2, 8] },
      ],
    });
    const issues = run(p);
    expect(issues.map((i) => [i.severity, i.code, i.elementId])).toEqual([
      ["warning", "feature_not_at_wall", "shelf_mid"],
      ["warning", "seat_detached", "chair_far"],
    ]);
  });

  it("route_dead_end: a corridor whose path ends inside another room", () => {
    const p = plan({
      areas: [
        room("a", 1, 4, 3, 3, { key: "1" }),
        room("mid", 8, 2, 7, 7, { key: "2" }),
        room("b", 15, 4, 3, 3, { key: "3" }),
        { id: "c", kind: "corridor", shape: { type: "route", from: "a", to: "b", openings: "door" } },
      ],
      openings: [{ id: "m", kind: "door", between: ["mid", "c"] }],
    });
    const rd = pick(run(p), "route_dead_end");
    expect(rd[0]).toMatchObject({ severity: "warning", elementId: "c" });
    expect(rd[0]?.message).toContain('never opens into "b"');
  });
});

describe("in-game regression: the original single-room test plan (door behind the stairs; archived as 02-single-room.v4)", () => {
  const p = JSON.parse(
    readFileSync(new URL("./fixtures/invalid-single-room-door-behind-stairs.json", import.meta.url), "utf8"),
  ) as MapPlan;
  const r = resolvePlan(p, bundledPalettes());
  const issues = checkPlayability(p, r);
  it("flags the east door, naming the stairs as the blocker", () => {
    const e = issues.find((i) => i.code === "opening_blocked" && i.elementId === "door_e");
    expect(e).toBeDefined();
    expect(e?.cell).toEqual([9, 6]);
    expect(e?.message).toContain('the stairs "stairs"');
    expect(e?.hint).toContain('"stairs"');
  });
  it("the stairs' bottom step is the cell in front of the door, and the grid marks it", () => {
    const room = r.levels.find((l) => l.id === "room");
    expect(r.links[0]?.lowerCells[0]).toEqual([9, 6]);
    expect(((room?.cells.flags[6 * 12 + 9] as number) & 16) !== 0).toBe(true);
  });
  it("marks the offending cell in the ASCII view", () => {
    const text = asciiView(r, "room", { issues });
    expect(text).toContain("! 9,6 warning opening_blocked door_e");
  });
});

describe("no new errors on the valid fixtures", () => {
  const all: Array<[string, MapPlan]> = [
    ...VALID_PLAN_FIXTURES.map((n): [string, MapPlan] => [n, loadPlan(n)]),
    ...Object.entries(EXTRA_FIXTURES)
      .filter(([n]) => n !== "links")
      .map(([n, q]): [string, MapPlan] => [n, structuredClone(q)]),
  ];
  it.each(all)("%s", (_n, p) => {
    expect(run(p).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("reuse by the compiler: extra blocked cells and openings", () => {
  it("extraBlocked cells cut a room off and are named as built geometry", () => {
    const p = twoRooms();
    const issues = checkPlayability(p, resolvePlan(p, bundledPalettes()), {
      extraBlocked: { l1: [3 * 20 + 8] },
    });
    expect(pick(issues, "opening_blocked")[0]).toMatchObject({ severity: "error", elementId: "door" });
    expect(pick(issues, "opening_blocked")[0]?.message).toContain("built geometry");
  });
  it("extraBlockedOpenings close a door", () => {
    const p = twoRooms();
    const masks = walkReachability(p, resolvePlan(p, bundledPalettes()), {
      extraBlockedOpenings: { l1: [{ openingId: "door", side: 1 }] },
    });
    expect(masks.get("l1")?.[3 * 20 + 10]).toBe(0);
    expect(masks.get("l1")?.[3 * 20 + 3]).toBe(1);
  });
});

describe("robustness and speed", () => {
  it("never throws on random plans", () => {
    const featureTypes = ["table", "bed", "chair", "barrel", "bookshelf", "pillar", "rug"] as const;
    const kinds = ["door", "archway", "secret_door", "window", "open"] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.integer({ min: 0, max: 14 }),
            y: fc.integer({ min: 0, max: 8 }),
            w: fc.integer({ min: 1, max: 6 }),
            h: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.array(
          fc.record({
            t: fc.constantFrom(...featureTypes),
            x: fc.integer({ min: -1, max: 20 }),
            y: fc.integer({ min: -1, max: 12 }),
          }),
          { maxLength: 12 },
        ),
        fc.array(
          fc.record({
            k: fc.constantFrom(...kinds),
            x: fc.integer({ min: 0, max: 19 }),
            y: fc.integer({ min: 0, max: 11 }),
            s: fc.constantFrom("N", "E", "S", "W" as const),
          }),
          { maxLength: 6 },
        ),
        fc.option(
          fc.record({
            x: fc.integer({ min: 0, max: 19 }),
            y: fc.integer({ min: 0, max: 11 }),
            d: fc.constantFrom("N", "E", "S", "W" as const),
          }),
        ),
        (rects, feats, opens, link) => {
          const p = plan(
            {
              areas: rects.map((r, k) => room(`r${k}`, r.x, r.y, r.w, r.h, { key: String(k + 1) })),
              features: feats.map((f, k) => ({ id: `f${k}`, type: f.t, at: [f.x, f.y] })),
              openings: opens.map((o, k) => ({ id: `o${k}`, kind: o.k, at: { x: o.x, y: o.y, side: o.s } })),
            },
            [{ areas: [room("up", 0, 0, 20, 12, { key: "99" })] }],
            link
              ? [
                  {
                    id: "lk",
                    kind: "stairs",
                    from: { level: "l1", at: [link.x, link.y] },
                    to: { level: "l2" },
                    dir: link.d,
                  },
                ]
              : [],
          );
          const issues = run(p);
          for (const i of issues) expect(["error", "warning", "info"]).toContain(i.severity);
        },
      ),
      { numRuns: 300, seed: 42 },
    );
  });

  it("checks a 160×160 level with rooms, doors and 4,000+ features", () => {
    const areas: Area[] = [];
    const openings: Opening[] = [];
    for (let k = 0; k < 64; k++) {
      areas.push(room(`r${k}`, 2 + (k % 8) * 20, 2 + Math.floor(k / 8) * 20, 14, 14, { key: String(k + 1) }));
      openings.push({ id: `d${k}`, kind: "door", between: [`r${k}`, "@outside"] });
    }
    const p: MapPlan = {
      ...plan({}),
      levels: [
        {
          id: "l1",
          name: "big",
          elevation: 0,
          bounds: { x: 0, y: 0, w: 160, h: 160 },
          base: { type: "ground", material: "grass" },
          areas,
          openings,
          walls: [],
          features: [],
          terrain: [
            {
              id: "trees",
              op: "scatter",
              feature: "tree",
              density: 0.5,
              minSpacing: 1,
              avoid: ["areas", "walls"],
            },
          ],
          labels: [],
        },
      ],
    };
    const r = resolvePlan(p, bundledPalettes());
    expect(r.levels[0]?.features.length).toBeGreaterThan(4000);
    // A guard against a quadratic blow-up (it would run past the test's timeout); no elapsed-time assertion, which
    // measures the machine rather than the code.
    expect(Array.isArray(checkPlayability(p, r))).toBe(true);
  });
});
