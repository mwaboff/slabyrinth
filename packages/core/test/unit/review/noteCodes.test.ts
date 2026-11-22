/**
 * Design-review notes that had no direct test: each fires on a small level built for it and stays silent on the same
 * level without the fault. Plans are written inline (never copied from a user's saved map); where the fault is a state
 * the resolver does not produce from a short plan (a hole over nothing, a broken rift), the resolved level is edited.
 */
import { describe, expect, it } from "vitest";
import type { GeneratorVersion, Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { CELL_FLAG, type ResolvedLevel, type ResolvedPlan } from "../../../src/contracts/resolved";
import { isBandRock } from "../../../src/gen/catalog";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign, type DesignNoteCode } from "../../../src/review";

const ground = (id: string, elevation: number, level: Partial<Level> = {}): Level => ({
  id,
  name: id,
  elevation,
  bounds: { x: 0, y: 0, w: 40, h: 30 },
  base: { type: "ground", material: "grass" },
  areas: [],
  openings: [],
  walls: [],
  features: [],
  terrain: [],
  labels: [],
  ...level,
});

const plan = (generator: GeneratorVersion, levels: Level[], theme = "outdoor", seed = 7): MapPlan => ({
  schema: "slabyrinth/plan@1",
  generator,
  id: "notes",
  title: "Notes",
  kind: "outdoor",
  theme,
  seed,
  links: [],
  levels,
});

/** Every note's code (no cap), after an optional edit of the resolved plan. */
function noteCodes(p: MapPlan, edit?: (r: ResolvedPlan) => void): DesignNoteCode[] {
  const r = resolvePlan(p, bundledPalettes());
  edit?.(r);
  return reviewDesign(p, r, bundledPalettes(), { limit: 999 }).map((n) => n.code);
}

const first = (r: ResolvedPlan): ResolvedLevel => {
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  return L;
};

describe("review notes, one fixture each", () => {
  it("opening_over_nothing: a floor opening with no floor under most of it; one over a room is fine", () => {
    const hole = (floorBelow: number) => (r: ResolvedPlan) => {
      first(r).floorOpenings = [
        {
          id: "hole",
          kind: "collapse",
          cells: [
            [10, 10],
            [11, 10],
            [10, 11],
            [11, 11],
          ],
          floorBelow,
          hiddenEdge: 0,
          edgeCells: 8,
        },
      ];
    };
    const p = plan(4, [ground("g", 0)]);
    expect(noteCodes(p, hole(0))).toContain("opening_over_nothing");
    expect(noteCodes(p, hole(4))).not.toContain("opening_over_nothing");
  });

  it("levels_close: a level 2.5 tiles over another leaves no air over the walls; 4 tiles is fine", () => {
    const stacked = (up: number): MapPlan => plan(3, [ground("low", 0), ground("up", up)]);
    expect(noteCodes(stacked(2.5))).toContain("levels_close");
    expect(noteCodes(stacked(4))).not.toContain("levels_close");
  });

  it("patch_without_cause: a dirt patch in the middle of a bare meadow; one beside a tree is fine", () => {
    const patch: TerrainOp = {
      id: "patch",
      op: "paint",
      shape: { type: "rect", x: 18, y: 12, w: 5, h: 4 },
      material: "dirt",
    };
    expect(noteCodes(plan(2, [ground("g", 0, { terrain: [patch] })]))).toContain("patch_without_cause");
    const tree = { id: "oak", type: "tree" as const, at: [17, 13] as [number, number] };
    expect(noteCodes(plan(2, [ground("g", 0, { terrain: [patch], features: [tree] })]))).not.toContain(
      "patch_without_cause",
    );
  });

  it("focus_unreached: a trail far from the great statue once its spur is gone; with the spur it is fine", () => {
    const trail: TerrainOp = {
      id: "trail",
      op: "path",
      points: [
        [0, 3],
        [39, 3],
      ],
      width: 2,
      material: "dirt",
      style: "straight",
    };
    const statue = { id: "focus", type: "statue_large" as const, at: [20, 22] as [number, number] };
    const p = plan(2, [ground("g", 0, { terrain: [trail], features: [statue] })]);
    // the resolver leads a spur from the trail to the focal piece; only the trail along rows 3-4 is left
    const noSpur = (r: ResolvedPlan): void => {
      const L = first(r);
      for (let i = 5 * L.bounds.w; i < L.cells.flags.length; i++)
        L.cells.flags[i] = (L.cells.flags[i] ?? 0) & ~CELL_FLAG.PATH;
    };
    expect(noteCodes(p)).not.toContain("focus_unreached");
    expect(noteCodes(p, noSpur)).toContain("focus_unreached");
  });

  it("board_edge_bare: ground raised to the board's edge with its rock band taken away; with the band it is fine", () => {
    const raised = plan(3, [
      ground("g", 0, {
        terrain: [
          {
            id: "rise",
            op: "platform",
            shape: { type: "rect", x: 0, y: 0, w: 40, h: 30 },
            tiers: 1,
            rise: 2,
            material: "grass",
            edge: "clean",
          },
        ],
      }),
    ]);
    expect(noteCodes(raised)).not.toContain("board_edge_bare");
    const unbanded = (r: ResolvedPlan): void => {
      const L = first(r);
      L.features = L.features.filter((f) => !isBandRock(f.type));
    };
    expect(noteCodes(raised, unbanded)).toContain("board_edge_bare");
  });

  it("rift_broken: a rift laid as two pits with ground between them; the whole rift is fine", () => {
    const rift = plan(
      3,
      [
        ground("l1", 0, {
          bounds: { x: 0, y: 0, w: 46, h: 34 },
          base: { type: "ground", material: "rock" },
          terrain: [
            {
              id: "rift",
              op: "chasm",
              points: [
                [20, 0],
                [21, 34],
              ],
              width: 4,
              depth: 3,
              floor: "lava",
            },
          ],
        }),
      ],
      "cave",
      // a seed whose course stays one body (some seeds pinch it to a diagonal step, which this note reports)
      1,
    );
    expect(noteCodes(rift)).not.toContain("rift_broken");
    // fill a band of rows across the course with plain rock floor: the lava is now two pits
    const fill = (r: ResolvedPlan): void => {
      const L = first(r);
      const rock = L.materials.indexOf("rock") + 1;
      if (rock === 0) throw new Error("fixture: no rock material");
      const W = L.bounds.w;
      for (let y = 6; y <= 8; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          L.cells.flags[i] =
            (L.cells.flags[i] ?? 0) & ~(CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR | CELL_FLAG.BRIDGE);
          L.cells.material[i] = rock;
        }
    };
    expect(noteCodes(rift, fill)).toContain("rift_broken");
  });
});
