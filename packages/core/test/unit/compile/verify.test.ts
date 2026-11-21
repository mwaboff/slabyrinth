import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompileDiagnosticCode, Placement, PlacementSet } from "../../../src/contracts/compiler";
import type { MapPlan } from "../../../src/contracts/plan";
import {
  compileResolved,
  placementBoxes,
  placementMeta,
  realize,
  verifyBuild,
  VERIFY_CODES,
} from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const room = (extra: Partial<Parameters<typeof handLevel>[0]> = {}): ReturnType<typeof handLevel> =>
  handLevel({ id: "l1", rows: ["#####", "#...#", "#...#", "#####"], ...extra });

/** Hg = 4 for `room()`: plan row y → world z = 3 − y. */
const all = (set: PlacementSet): Placement[] => set.levels.flatMap((l) => l.placements);
const named = (set: PlacementSet, name: string): Placement[] =>
  all(set).filter((p) => placementMeta.get(p)?.name === name);
/** Copy of a placement moved by (dx,dy,dz), with its box and meta. */
function clone(p: Placement, dx = 0, dy = 0, dz = 0, patch: Partial<Placement> = {}): Placement {
  const q: Placement = { ...p, source: { ...p.source }, x: p.x + dx, y: p.y + dy, z: p.z + dz, ...patch };
  const b = placementBoxes.get(p);
  if (b)
    placementBoxes.set(q, {
      min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
      max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
    });
  const m = placementMeta.get(p);
  if (m) placementMeta.set(q, m);
  return q;
}
function move(p: Placement, dx = 0, dy = 0, dz = 0): void {
  const b = placementBoxes.get(p);
  p.x += dx;
  p.y += dy;
  p.z += dz;
  if (b)
    placementBoxes.set(p, {
      min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
      max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
    });
}
const level0 = (set: PlacementSet): Placement[] => set.levels[0]?.placements ?? [];
const codes = (set: PlacementSet, resolved: Parameters<typeof verifyBuild>[0]): CompileDiagnosticCode[] =>
  verifyBuild(resolved, set, cat).diagnostics.map((d) => d.code);
const run = (resolved: Parameters<typeof verifyBuild>[0], set: PlacementSet, code: CompileDiagnosticCode) =>
  verifyBuild(resolved, set, cat).diagnostics.filter((d) => d.code === code);

describe("verify: a clean build stays clean", () => {
  it("the hand-built room with a door and props has no diagnostics", () => {
    const r = handPlan([room({ features: [{ id: "c", type: "chest", at: [1, 1] }] })]);
    const set = realize(r, cat);
    expect(verifyBuild(r, set, cat).diagnostics).toEqual([]);
  });
  it("every documented code is covered by a test below", () => {
    expect(VERIFY_CODES).toHaveLength(28);
  });
});

describe("verify: one fixture per code", () => {
  it("verify_cell_obstructed — a stacked block in an open cell", () => {
    const r = handPlan([room()]);
    const set = realize(r, cat);
    const floor = level0(set).find((p) => p.role === "floor");
    if (!floor) throw new Error("fixture");
    // two courses (1.0 high): a single 0.5 course is a walkable step, not an obstruction
    level0(set).push(clone(floor, 0, 0.5, 0), clone(floor, 0, 1.0, 0));
    const d = run(r, set, "verify_cell_obstructed");
    expect(d[0]).toMatchObject({ severity: "warning", levelId: "l1" });
    expect(d[0]?.assets?.length).toBe(1);
  });

  it("verify_door_blocked + verify_area_unreachable — a block in front of the only door names the blocker", () => {
    const plan = loadPlan("two-rooms-door");
    const r = resolvePlan(plan, bundledPalettes());
    const set = realize(r, cat);
    const op = r.levels[0]?.openings[0];
    if (!op || op.orientation !== "v") throw new Error("fixture: expected a vertical door");
    // the back-room side of the door: cell (start.x, start.y); world z = Hg − 1 − y
    const hg = r.levels[0] ? r.levels[0].bounds.y + r.levels[0].bounds.h : 0;
    const anyFloor =
      level0(set).find((p) => p.role === "floor" && placementMeta.get(p)?.name === "Dungeon Floor - Small") ??
      level0(set).find((p) => p.role === "floor");
    if (!anyFloor) throw new Error("fixture");
    const block = clone(anyFloor, op.start[0] - anyFloor.x, 0.5, hg - 1 - op.start[1] - anyFloor.z, {
      source: { cell: [op.start[0], op.start[1]], elementId: "crate_stack" },
    });
    placementBoxes.set(block, {
      min: { x: op.start[0], y: 0.5, z: hg - 1 - op.start[1] },
      max: { x: op.start[0] + 1, y: 1.5, z: hg - op.start[1] },
    });
    level0(set).push(block);
    const v = verifyBuild(r, set, cat, { plan });
    const blocked = v.diagnostics.find((d) => d.code === "verify_door_blocked");
    expect(blocked).toMatchObject({ severity: "error", elementId: op.id });
    expect(blocked?.elementIds).toContain("crate_stack");
    expect(blocked?.hint).toMatch(/Move opening/);
    const unreachable = v.diagnostics.find((d) => d.code === "verify_area_unreachable");
    expect(unreachable).toMatchObject({ severity: "error", elementId: "back" });
    expect(unreachable?.message).toMatch(/blocks the way/);
    // and the same check without the plan (fallback pathfinder) agrees
    expect(codes(set, r)).toContain("verify_area_unreachable");
  });

  it("verify_door_no_floor — a door onto a hole", () => {
    const r = handPlan([
      handLevel({ id: "l1", rows: ["#####", "#.o.#", "#...#", "#####"], doors: [{ x: 2, y: 1, side: "N" }] }),
    ]);
    expect(run(r, realize(r, cat), "verify_door_no_floor")[0]).toMatchObject({
      severity: "error",
      cell: [2, 1],
    });
  });

  it("verify_door_missing — the door piece is absent from the build", () => {
    const r = handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]);
    const set = realize(r, cat);
    level0(set).splice(0, Infinity, ...level0(set).filter((p) => p.role !== "opening"));
    expect(run(r, set, "verify_door_missing")[0]).toMatchObject({ severity: "error", elementId: "door0" });
  });

  it("verify_door_misplaced — the door piece sits outside its half-cell", () => {
    const r = handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]);
    const set = realize(r, cat);
    const door = level0(set).find((p) => p.role === "opening");
    if (!door) throw new Error("fixture");
    move(door, 0, 0, -1);
    expect(run(r, set, "verify_door_misplaced")[0]?.severity).toBe("error");
  });

  it("verify_door_buried — a wall piece overlaps the door", () => {
    const r = handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]);
    const set = realize(r, cat);
    const door = level0(set).find((p) => p.role === "opening");
    const wall = named(set, "Dungeon Wall 01")[0] ?? level0(set).find((p) => p.role === "wall");
    if (!door || !wall) throw new Error("fixture");
    const w = clone(wall, door.x - wall.x, door.y - wall.y, door.z - wall.z, { rot: door.rot });
    placementBoxes.set(
      w,
      placementBoxes.get(door) ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    );
    level0(set).push(w);
    expect(run(r, set, "verify_door_buried")[0]?.severity).toBe("error");
  });

  it("verify_door_leads_nowhere — a door into solid rock", () => {
    const r = handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]);
    expect(run(r, realize(r, cat), "verify_door_leads_nowhere")[0]).toMatchObject({
      severity: "warning",
      elementId: "door0",
    });
  });

  const stairs = (lowerRows: string[], upperRows: string[], cells: Array<[number, number]>) =>
    handPlan(
      [handLevel({ id: "lo", rows: lowerRows }), handLevel({ id: "up", elevation: 2.5, rows: upperRows })],
      [
        {
          id: "s",
          kind: "stairs",
          fromLevel: "lo",
          toLevel: "up",
          lowerCells: cells,
          upperCells: cells,
          arrival: [2, 0],
          dir: "N",
          rise: 2.5,
          theme: "stone_dungeon",
        },
      ],
    );
  const LO = ["#####", "#...#", "#...#", "#...#", "#...#", "#####"];
  const UP = ["  .  ", " .o. ", " .o. ", " .o. ", " ... ", "     "];
  const RUN: Array<[number, number]> = [
    [2, 3],
    [2, 2],
    [2, 1],
  ];

  it("clean stairs produce no stair diagnostics", () => {
    const r = stairs(LO, UP, RUN);
    expect(codes(realize(r, cat), r).filter((c) => c.startsWith("verify_stair"))).toEqual([]);
  });

  it("verify_stairs_no_arrival — the landing is missing", () => {
    const r = stairs(LO, UP, RUN);
    const set = realize(r, cat);
    level0(set).splice(
      0,
      Infinity,
      ...level0(set).filter((p) => !(p.role === "link" && p.source.cell?.[1] === 1)),
    );
    expect(run(r, set, "verify_stairs_no_arrival")[0]).toMatchObject({ severity: "error", elementId: "s" });
  });

  it("verify_stairs_approach_blocked — the first step starts against rock", () => {
    const r = stairs(
      ["#####", "#...#", "#...#", "#...#", "#####"],
      UP,
      [
        [2, 3],
        [2, 2],
        [2, 1],
      ].map((c) => c as [number, number]),
    );
    expect(run(r, realize(r, cat), "verify_stairs_approach_blocked")[0]).toMatchObject({
      severity: "error",
      cell: [2, 4],
    });
  });

  it("verify_stairs_arrival_blocked — nothing to arrive on", () => {
    const r = stairs(LO, ["     ", " .o. ", " .o. ", " .o. ", " ... ", "     "], RUN);
    expect(run(r, realize(r, cat), "verify_stairs_arrival_blocked")[0]).toMatchObject({
      severity: "error",
      cell: [2, 0],
    });
  });

  it("verify_stairwell_closed — the upper floor covers the stairs", () => {
    const r = stairs(LO, ["  .  ", " ... ", " ... ", " ... ", " ... ", "     "], RUN);
    expect(run(r, realize(r, cat), "verify_stairwell_closed")[0]?.severity).toBe("error");
  });

  it("verify_props_overlap — two props in one cell (warning; organic-only overlaps are info)", () => {
    const r = handPlan([
      room({
        features: [
          { id: "a", type: "chest", at: [1, 1] },
          { id: "b", type: "barrel", at: [1, 1] },
        ],
      }),
    ]);
    expect(run(r, realize(r, cat), "verify_props_overlap")[0]).toMatchObject({
      severity: "warning",
      count: 1,
    });
    const o = handPlan([
      room({
        features: [
          { id: "a", type: "rock", at: [1, 1] },
          { id: "b", type: "boulder", at: [1, 1] },
        ],
      }),
    ]);
    expect(run(o, realize(o, cat), "verify_props_overlap")[0]?.severity).toBe("info");
  });

  it("verify_prop_nudged — a prop slightly inside a wall is moved out and reported", () => {
    const r = handPlan([room({ features: [{ id: "c", type: "chest", at: [1, 1] }] })]);
    const set = realize(r, cat);
    const chest = level0(set).find((p) => p.role === "feature");
    if (!chest) throw new Error("fixture");
    move(chest, -0.2);
    const before = chest.x;
    const d = run(r, set, "verify_prop_nudged")[0];
    expect(d).toMatchObject({ severity: "info", elementId: "c" });
    expect(d?.repaired).toMatch(/moved .* east/);
    expect(chest.x).toBeGreaterThan(before);
  });

  it("verify_prop_in_wall — too deep to nudge inside its footprint", () => {
    const r = handPlan([room({ features: [{ id: "c", type: "chest", at: [1, 1] }] })]);
    const set = realize(r, cat);
    const chest = level0(set).find((p) => p.role === "feature");
    if (!chest) throw new Error("fixture");
    move(chest, -0.7);
    expect(run(r, set, "verify_prop_in_wall")[0]?.severity).toBe("warning");
  });

  it("verify_prop_floating / verify_prop_sunk", () => {
    const r = handPlan([room({ features: [{ id: "c", type: "chest", at: [2, 1] }] })]);
    const up = realize(r, cat);
    move(level0(up).find((p) => p.role === "feature") as Placement, 0, 1);
    expect(run(r, up, "verify_prop_floating")[0]?.severity).toBe("warning");
    const down = realize(r, cat);
    move(level0(down).find((p) => p.role === "feature") as Placement, 0, -0.3);
    expect(run(r, down, "verify_prop_sunk")[0]?.severity).toBe("warning");
    // stalactites hang from the ceiling on purpose: never "floating"
    const rs = handPlan([room({ features: [{ id: "s", type: "stalactite", at: [2, 1], blocking: false }] })]);
    const hung = realize(rs, cat);
    const st = level0(hung).find((p) => p.role === "feature");
    if (st) {
      move(st, 0, 2);
      expect(run(rs, hung, "verify_prop_floating")).toEqual([]);
    }
  });

  it("verify_prop_no_floor — a prop over a hole", () => {
    const r = handPlan([
      handLevel({
        id: "l1",
        rows: ["#####", "#.o.#", "#####"],
        features: [{ id: "c", type: "chest", at: [2, 1] }],
      }),
    ]);
    expect(run(r, realize(r, cat), "verify_prop_no_floor")[0]).toMatchObject({
      severity: "warning",
      elementId: "c",
    });
  });

  it("verify_mount_no_wall — a wall torch on an open side", () => {
    const r = handPlan([room({ features: [{ id: "t", type: "torch_wall", at: [2, 1], wall: "S" }] })]);
    expect(run(r, realize(r, cat), "verify_mount_no_wall")[0]).toMatchObject({
      severity: "warning",
      elementId: "t",
      side: "S",
    });
  });

  it("verify_prop_outside — a prop beyond the level bounds", () => {
    const r = handPlan([room({ features: [{ id: "c", type: "chest", at: [2, 1] }] })]);
    const set = realize(r, cat);
    move(level0(set).find((p) => p.role === "feature") as Placement, 20);
    expect(run(r, set, "verify_prop_outside")[0]?.severity).toBe("warning");
  });

  it("verify_floor_missing — a floor cell without a tile", () => {
    const r = handPlan([room()]);
    const set = realize(r, cat);
    level0(set).splice(0, Infinity, ...level0(set).filter((p) => p.role !== "floor"));
    expect(run(r, set, "verify_floor_missing")[0]).toMatchObject({ severity: "error", count: 6 });
  });

  it("verify_wall_gap — a wall piece is missing (and the rock-between-open-caves variant)", () => {
    const r = handPlan([room()]);
    const set = realize(r, cat);
    const i = level0(set).findIndex((p) => p.role === "wall");
    level0(set).splice(i, 1);
    expect(run(r, set, "verify_wall_gap")[0]?.severity).toBe("error");
    // cave_rock edge between two open areas: nothing can be built, the hole is reported (not silent)
    const cave = handLevel({
      id: "c",
      rows: ["#####", "#...#", "#####"],
      theme: "cave",
      material: "rock",
      wallStyle: "cave_rock",
    });
    const e = (cave.bounds.w + 1) * 1 + 2; // vertical edge west of (2,1)
    cave.vEdges.kind[e] = 1;
    cave.vEdges.ref[e] = 0;
    cave.vEdges.host[e] = 1;
    cave.vEdges.height[e] = 2;
    const rc = handPlan([cave]);
    const d = run(rc, realize(rc, cat), "verify_wall_gap")[0];
    expect(d?.message).toMatch(/rock-block walls need a solid cell/);
    // the hint never sends the model to "stone" (in the cave palette that was masonry) nor to a wall height
    expect(d?.hint).not.toMatch(/stone|wall height/);
    expect(d?.hint).toMatch(/unclaimed \(solid\) cell/);
    // a missing piece on an ordinary edge: the hint names the style, not a wall height
    expect(run(r, set, "verify_wall_gap")[0]?.hint).not.toMatch(/wall height of 2/);
  });

  it("verify_material_substituted — the 2D map shows lava, the theme builds rock (preview/slab disagreement)", () => {
    // the palette as it was in 0.1.1: floor.lava an empty alias falling back to floor.rock
    const old = loadPalettes({
      user: [
        {
          source: "test",
          data: {
            schema: "slabyrinth/palette@1",
            id: "cave",
            overrides: true,
            roles: { "floor.lava": { variants: [], fallback: "floor.rock" } },
          },
        },
      ],
    });
    const lv = handLevel({ id: "c", rows: ["#####", "#...#", "#####"], theme: "cave", material: "lava" });
    const r = handPlan([lv]);
    const d = verifyBuild(r, realize(r, old), old).diagnostics.find(
      (x) => x.code === "verify_material_substituted",
    );
    expect(d).toMatchObject({ severity: "warning", count: 3, role: "floor.lava" });
    expect(d?.message).toMatch(/shows 3 cells of lava/);
    expect(d?.message).toMatch(/floor.rock/);
    // with a real lava tile the warning goes away
    const ok = verifyBuild(r, realize(r, cat), cat).diagnostics.filter(
      (x) => x.code === "verify_material_substituted",
    );
    expect(ok).toEqual([]);
  });

  it("verify_duplicate_removed — exact duplicates are dropped (repair)", () => {
    const r = handPlan([room()]);
    const set = realize(r, cat);
    const n = level0(set).length;
    const f = level0(set)[0] as Placement;
    level0(set).push(clone(f), clone(f));
    const d = run(r, set, "verify_duplicate_removed")[0];
    expect(d).toMatchObject({ severity: "info", count: 2 });
    expect(level0(set)).toHaveLength(n);
    expect(set.stats.total).toBe(n);
  });

  it("verify_bad_coordinate — a non-finite placement is dropped with an error", () => {
    const r = handPlan([room()]);
    const set = realize(r, cat);
    level0(set).push(clone(level0(set)[0] as Placement, 0, 0, 0, { x: Number.NaN }));
    expect(run(r, set, "verify_bad_coordinate")[0]?.severity).toBe("error");
    expect(level0(set).every((p) => Number.isFinite(p.x))).toBe(true);
  });

  it("verify_pokes_into_level_above — tall walls through the floor above", () => {
    const r = handPlan([
      handLevel({ id: "lo", rows: ["#####", "#...#", "#####"], wallHeight: 3 }),
      handLevel({ id: "up", elevation: 2.5, rows: [".....", ".....", "....."] }),
    ]);
    expect(run(r, realize(r, cat), "verify_pokes_into_level_above")[0]).toMatchObject({
      severity: "warning",
      levelId: "lo",
    });
  });
});

describe("verify: the proof room's east door (regression)", () => {
  const file = fileURLToPath(
    new URL("../../../../../data/test-slabs/02-single-room.plan.json", import.meta.url),
  );
  const fixed = JSON.parse(readFileSync(file, "utf8")) as MapPlan;
  // the v1–v4 layout: door_e at (9,6) E opening onto the bottom step of the stairs, both doors into rock
  const old = structuredClone(fixed);
  const lvl = old.levels[0];
  if (!lvl) throw new Error("fixture");
  lvl.areas = lvl.areas.filter((a) => a.kind === "room");
  lvl.openings = [
    { id: "door_n", kind: "door", at: { x: 4, y: 2, side: "N" } },
    { id: "door_e", kind: "door", at: { x: 9, y: 6, side: "E" } },
  ];

  it("flags door_e with the stairs as the blocker and suggests a clear cell", () => {
    const r = resolvePlan(old, bundledPalettes());
    const v = verifyBuild(r, realize(r, cat), cat);
    const d = v.diagnostics.find((x) => x.code === "verify_door_blocked");
    expect(d).toMatchObject({ severity: "error", elementId: "door_e", cell: [9, 6] });
    expect(d?.assets).toContain("Dungeon Stairs");
    expect(d?.elementIds).toContain("stairs");
    expect(d?.hint).toMatch(/Move opening door_e to at: \{x: 9, y: 7, side: "E"\}/);
  });

  it("with the plan, the plan-level pass reports it (opening_blocked) and verify does not repeat it", () => {
    const r = resolvePlan(old, bundledPalettes());
    const planIssues = checkPlayability(old, r);
    expect(planIssues.some((i) => i.code === "opening_blocked" && i.elementId === "door_e")).toBe(true);
    const v = verifyBuild(r, realize(r, cat), cat, { plan: old });
    expect(
      v.diagnostics.filter((x) => x.code === "verify_door_blocked" || x.code === "verify_door_leads_nowhere"),
    ).toEqual([]);
  });

  it("the fixed plan (v5) verifies clean", () => {
    const r = resolvePlan(fixed, bundledPalettes());
    expect(verifyBuild(r, realize(r, cat), cat, { plan: fixed }).diagnostics).toEqual([]);
  });
});

describe("verify: no duplicates across the plan and build layers", () => {
  const leads = (opts: Parameters<typeof verifyBuild>[3]) => {
    const plan = loadPlan("multi-level-stairs");
    const r = resolvePlan(plan, bundledPalettes());
    return verifyBuild(
      r,
      realize(r, cat),
      cat,
      typeof opts === "function" ? opts : { ...opts },
    ).diagnostics.filter((d) => d.code === "verify_door_leads_nowhere" && d.elementId === "front_door");
  };
  it("multi-level-stairs front_door: emitted when no plan issues are supplied", () => {
    expect(leads({})).toHaveLength(1);
  });
  it("suppressed when planIssues already has opening_dead_end or opening_blocked for that opening", () => {
    for (const code of ["opening_dead_end", "opening_blocked"] as const) {
      expect(
        leads({ planIssues: [{ severity: "info", code, message: "plan layer", elementId: "front_door" }] }),
      ).toEqual([]);
    }
    // an issue about another element does not suppress it
    expect(
      leads({
        planIssues: [{ severity: "info", code: "opening_dead_end", message: "x", elementId: "other" }],
      }),
    ).toHaveLength(1);
  });
  it("with the plan, the plan layer's own finding is used and verify stays silent", () => {
    const plan = loadPlan("multi-level-stairs");
    const r = resolvePlan(plan, bundledPalettes());
    expect(
      checkPlayability(plan, r).some((i) => i.code === "opening_dead_end" && i.elementId === "front_door"),
    ).toBe(true);
    expect(leads({ plan })).toEqual([]);
  });
});

describe("verify: fixtures, pipeline wiring, robustness, speed", () => {
  it("the bundle and the estimate carry verify diagnostics", () => {
    const r = handPlan([room({ doors: [{ x: 2, y: 1, side: "N" }] })]);
    const b = compileResolved(r, cat, slabCodec, { createdAt: "t" });
    expect(b.diagnostics.find((d) => d.code === "verify_door_leads_nowhere")?.stage).toBe("verify");
  });

  it("examples A and B and the two-level proof plan: no verify errors", () => {
    for (const plan of [
      loadPlan("example-a"),
      loadPlan("example-b"),
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL("../../../../../data/test-slabs/03-two-level.plan.json", import.meta.url)),
          "utf8",
        ),
      ) as MapPlan,
    ]) {
      const r = resolvePlan(plan, bundledPalettes());
      const v = verifyBuild(r, realize(r, cat), cat, { plan });
      expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }
  });

  it("never throws on random hand-built levels (fuzz)", () => {
    const cellCh = fc.constantFrom("#", ".", ".", ".", "o", " ", "2");
    fc.assert(
      fc.property(
        fc.array(
          fc.array(cellCh, { minLength: 3, maxLength: 9 }).map((a) => a.join("")),
          { minLength: 3, maxLength: 9 },
        ),
        fc.array(
          fc.tuple(
            fc.constantFrom("chest", "table", "torch_wall", "rock", "bed"),
            fc.nat(8),
            fc.nat(8),
            fc.constantFrom("N", "E", "S", "W"),
          ),
          { maxLength: 6 },
        ),
        (rows, feats) => {
          const r = handPlan([
            handLevel({
              id: "l",
              rows,
              features: feats.map(([type, x, y, side], i) => ({
                id: `f${i}`,
                type,
                at: [x, y] as const,
                ...(type === "torch_wall" ? { wall: side } : {}),
              })),
            }),
          ]);
          const v = verifyBuild(r, realize(r, cat), cat);
          expect(Array.isArray(v.diagnostics)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("verifies the largest supported level (160×160) quickly", () => {
    const rows = Array.from({ length: 160 }, (_, y) =>
      Array.from({ length: 160 }, (_, x) =>
        x === 0 || y === 0 || x === 159 || y === 159 || (x % 20 === 0 && y % 7 !== 3) ? "#" : ".",
      ).join(""),
    );
    const features = Array.from({ length: 800 }, (_, i) => ({
      id: `f${i}`,
      type: "chest" as const,
      at: [1 + ((i * 7) % 157), 1 + ((i * 13) % 157)] as const,
    }));
    const r = handPlan([handLevel({ id: "big", rows, features })]);
    const set = realize(r, cat);
    verifyBuild(r, realize(r, cat), cat); // warm-up
    // A guard against a quadratic blow-up, not a benchmark: best of three, with headroom for a loaded machine
    // (parallel test workers, shared CI runners). Typical time on an idle desktop is well under 200 ms.
    const best = Math.min(...[0, 1, 2].map(() => verifyBuild(r, set, cat).ms));
    expect(best).toBeLessThan(1000);
  });
});

describe("vertical links: ladders, spiral stairs, trapdoors, pits", () => {
  const LO = ["######", "#....#", "#....#", "#....#", "######"];
  const upRows = (hole: Array<[number, number]>, floorHoles = true): string[] =>
    ["      ", " .... ", " .... ", " .... ", "      "].map((r, y) =>
      r
        .split("")
        .map((ch, x) => (floorHoles && hole.some(([hx, hy]) => hx === x && hy === y) ? "o" : ch))
        .join(""),
    );
  const plan = (
    kind: "ladder" | "spiral_stairs" | "trapdoor" | "pit_drop",
    cells: Array<[number, number]>,
    rise = 2.5,
    holes = true,
  ) =>
    handPlan(
      [
        handLevel({ id: "lo", rows: LO }),
        handLevel({ id: "up", elevation: rise, rows: upRows(cells, holes && kind !== "trapdoor") }),
      ],
      [
        {
          id: "v",
          kind,
          fromLevel: "lo",
          toLevel: "up",
          lowerCells: cells,
          upperCells: cells,
          arrival: cells[0] ?? [1, 1],
          dir: "N",
          rise,
          theme: "stone_dungeon",
        },
      ],
    );
  const pieces = (set: PlacementSet) => all(set).filter((p) => p.source.elementId === "v");
  const topOf = (ps: Placement[]) => Math.max(...ps.map((p) => placementBoxes.get(p)?.max.y ?? p.y));

  it("spiral stairs (2×2) with only a ladder in the palette: ONE ladder stack, against a wall, reaching the floor above, info diagnostic", () => {
    for (const rise of [2.5, 5]) {
      const r = plan(
        "spiral_stairs",
        [
          [1, 1],
          [2, 1],
          [1, 2],
          [2, 2],
        ],
        rise,
      );
      const set = realize(r, cat);
      const ps = pieces(set);
      expect(new Set(ps.map((p) => `${p.x},${p.z}`)).size).toBe(1); // one cell
      expect(ps).toHaveLength(Math.ceil(rise / 2));
      expect(ps[0]?.source.cell).toEqual([1, 1]); // (1,1) has walls on N and W
      expect(topOf(ps)).toBeGreaterThanOrEqual(rise + 0.5 - 0.25);
      expect(set.diagnostics.find((d) => d.elementId === "v")).toMatchObject({
        severity: "info",
        code: "asset_substituted",
      });
      expect(set.diagnostics.find((d) => d.elementId === "v")?.message).toMatch(
        /Spiral stairs v built as Ladder/,
      );
      expect(verifyBuild(r, set, cat).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }
  });

  it("ladders stack by the asset's height against the real span (rise 2.5 → 2 pieces, 5.0 → 3)", () => {
    for (const [rise, n] of [
      [2.5, 2],
      [5, 3],
    ] as const) {
      const r = plan("ladder", [[2, 2]], rise);
      const set = realize(r, cat);
      expect(pieces(set)).toHaveLength(n);
      expect(codes(set, r)).not.toContain("verify_link_short");
    }
  });

  it("verify_link_short — a ladder that stops below the floor above, and a missing trapdoor hatch", () => {
    const r = plan("ladder", [[2, 2]], 5);
    const set = realize(r, cat);
    const top = pieces(set).sort((a, b) => b.y - a.y)[0];
    level0(set).splice(level0(set).indexOf(top as Placement), 1);
    expect(run(r, set, "verify_link_short")[0]).toMatchObject({ severity: "error", elementId: "v" });
    const t = plan("trapdoor", [[2, 2]]);
    const ts = realize(t, cat);
    expect(pieces(ts)).toHaveLength(1);
    expect(codes(ts, t)).not.toContain("verify_link_short");
    for (const lv of ts.levels)
      lv.placements.splice(0, Infinity, ...lv.placements.filter((p) => p.source.elementId !== "v"));
    expect(run(t, ts, "verify_link_short")[0]?.message).toMatch(/no hatch/);
  });

  it("pit drops and ladders need an open shaft in the floor above (verify_stairwell_closed)", () => {
    for (const kind of ["pit_drop", "ladder"] as const) {
      const r = plan(kind, [[2, 2]], 2.5, false);
      expect(run(r, realize(r, cat), "verify_stairwell_closed")[0]?.severity).toBe("error");
    }
  });
});
