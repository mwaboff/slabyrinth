/**
 * verify_area_unreachable: one pathfinder (the resolver's WalkGraph) with or without the plan, and each area cut off by
 * the build is named with the blocker on its own way (generator switch `reachBlamesPathBlocker`).
 */
import { describe, expect, it } from "vitest";
import type { Placement, PlacementSet } from "../../../src/contracts/compiler";
import type { GeneratorVersion, MapPlan } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { clonePlaced, setPlacedBox } from "./placedSet";

const pal = bundledPalettes();

/** A front room with a door east into the back room and a door south into the cellar. */
function threeRooms(generator: GeneratorVersion): MapPlan {
  const rect = (x: number, y: number, w: number, h: number) => ({ type: "rect", x, y, w, h });
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Three Rooms",
    kind: "building",
    seed: 3,
    theme: "stone_dungeon",
    levels: [
      {
        id: "l1",
        name: "Ground",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 14, h: 12 },
        base: { type: "solid" },
        areas: [
          { id: "front", kind: "room", name: "Front Room", key: "1", shape: rect(1, 1, 6, 5) },
          { id: "back", kind: "room", name: "Back Room", key: "2", shape: rect(7, 1, 5, 5) },
          { id: "cellar", kind: "room", name: "Cellar", key: "3", shape: rect(1, 6, 6, 4) },
        ],
        openings: [
          { id: "to_back", kind: "door", between: ["front", "back"] },
          { id: "to_cellar", kind: "door", between: ["front", "cellar"] },
        ],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  } as MapPlan;
}

/** The build with a crate filling the far-side cell of each door (the cell the opening starts at). */
function blockedBuild(generator: GeneratorVersion) {
  const plan = threeRooms(generator);
  const r = resolvePlan(plan, pal);
  const set = realize(r, pal);
  const L = r.levels[0];
  const placements = set.levels[0]?.placements;
  const floor = placements?.find((p) => p.role === "floor");
  if (!L || !placements || !floor) throw new Error("fixture");
  const hg = L.bounds.y + L.bounds.h;
  const block = (s: PlacementSet, x: number, y: number, id: string): Placement => {
    const q = clonePlaced(s, floor, x - floor.x, 0.5, hg - 1 - y - floor.z, {
      source: { cell: [x, y], elementId: id },
    });
    setPlacedBox(s, q, { min: { x, y: 0.5, z: hg - 1 - y }, max: { x: x + 1, y: 1.5, z: hg - y } });
    return q;
  };
  for (const [opening, crate] of [
    ["to_back", "crate_back"],
    ["to_cellar", "crate_cellar"],
  ] as const) {
    const op = L.openings.find((o) => o.id === opening);
    if (!op) throw new Error(`fixture: ${opening}`);
    placements.push(block(set, op.start[0], op.start[1], crate));
  }
  return { plan, r, set };
}

const unreachable = (diags: ReturnType<typeof verifyBuild>["diagnostics"]) =>
  diags
    .filter((d) => d.code === "verify_area_unreachable")
    .map((d) => ({ area: d.elementId, blockers: d.elementIds?.filter((e) => e !== d.elementId) }));

describe("verify_area_unreachable", () => {
  it("generator 4: each cut-off area names the blocker on its own way", () => {
    const { plan, r, set } = blockedBuild(4);
    const found = unreachable(verifyBuild(r, set, pal, { plan }).diagnostics);
    expect(found).toEqual([
      { area: "back", blockers: ["crate_back"] },
      { area: "cellar", blockers: ["crate_cellar"] },
    ]);
  });

  it("released generators name the first blocker found for every area (frozen)", () => {
    const { plan, r, set } = blockedBuild(3);
    const found = unreachable(verifyBuild(r, set, pal, { plan }).diagnostics);
    expect(found.map((f) => f.area)).toEqual(["back", "cellar"]);
    expect(new Set(found.map((f) => f.blockers?.join()))).toHaveProperty("size", 1);
  });

  it("without the plan the same walk runs from the same entry level and says the same", () => {
    for (const generator of [3, 4] as const) {
      const { plan, r, set } = blockedBuild(generator);
      const withPlan = verifyBuild(r, set, pal, { plan }).diagnostics.filter(
        (d) => d.code === "verify_area_unreachable",
      );
      const { r: r2, set: set2 } = blockedBuild(generator);
      const without = verifyBuild(r2, set2, pal).diagnostics.filter(
        (d) => d.code === "verify_area_unreachable",
      );
      expect(without).toEqual(withPlan);
    }
  });
});
