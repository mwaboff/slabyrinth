/**
 * The two generator-5 rounds together: the detail recipes (layered ground, the wall treatments) over rooms the
 * room-kind furnisher filled (gen/rooms4/furnish.ts). Ground cover indoors keeps off the furniture and off the cells
 * the furnisher kept clear (ResolvedLevel.keptClear: standing room before a group, the way in, the door landings); a
 * wall treatment's piece never stands in a room light's piece.
 */
import { describe, expect, it } from "vitest";
import { placedBox, planPointOf } from "../../../src/arrange";
import { realize } from "../../../src/compile";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { featureInfo } from "../../../src/gen/catalog";
import { bundledPalettes } from "../../../src/palette";
import { resolveView } from "../../../src/palette/view";
import { resolvePlan } from "../../../src/resolve";
import { LevelGrid } from "../../../src/resolve/levelGrid";
import { runRecipes } from "../../../src/resolve/recipes/engine";
import { layeredGround } from "../../../src/resolve/recipes/ground";
import { ArrangementRecords } from "../../../src/resolve/level/arrangements";
import { generatorProfile } from "../../../src/plan/generator";
import { loadPlan } from "../../fixtures";
import { forced } from "../../fixtures/treatments";

const pal = bundledPalettes();
/** Plans with furnished rooms (ground cover lies in the dungeon's rough rooms; the lineup has every room kind). */
const PLANS = ["keep-dungeon-v8", "interiors-lineup-v1", "inn-interior-v1", "multi-level-stairs"] as const;
const TOUCH = 0.02;

interface Box2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Plan footprint of every piece of an arrangement (cells). */
function pieceBoxes(view: ReturnType<typeof resolveView>, L: ResolvedLevel, recipe: string): Box2[] {
  return (L.arrangements ?? [])
    .filter((x) => x.recipe === recipe)
    .flatMap((x) =>
      x.pieces.map((p) => {
        const v = view.roles
          .resolve(view.roles.paletteTheme(p.palette), p.role)
          .resolution?.variants.find((q) => q.wanted === p.asset);
        const b = placedBox({
          piece: { palette: p.palette, role: p.role, variant: v as never, measures: {} as never },
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: p.yaw,
        });
        const a = planPointOf(x.at, x.turn, b.min.x, b.min.z);
        const c = planPointOf(x.at, x.turn, b.max.x, b.max.z);
        return {
          x0: Math.min(a[0], c[0]),
          x1: Math.max(a[0], c[0]),
          y0: Math.min(a[1], c[1]),
          y1: Math.max(a[1], c[1]),
        };
      }),
    );
}

const overlaps = (a: Box2, b: Box2): boolean =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > TOUCH && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > TOUCH;

describe("detail recipes over furnished rooms (generator 5)", () => {
  it("records what the furnisher kept clear, and generator 4 records nothing", () => {
    const r5 = resolvePlan({ ...loadPlan("interiors-lineup-v1"), generator: 5 }, pal);
    expect(r5.levels.some((L) => (L.keptClear?.length ?? 0) > 0)).toBe(true);
    const r4 = resolvePlan({ ...loadPlan("interiors-lineup-v1"), generator: 4 }, pal);
    expect(r4.levels.every((L) => L.keptClear === undefined)).toBe(true);
  });

  it("lays no ground cover over a kept-clear cell or under furniture, with cover forced on in every room", () => {
    let checked = 0;
    for (const name of PLANS) {
      const plan = { ...loadPlan(name), generator: 5 as const };
      const resolved = resolvePlan(plan, pal);
      for (const L0 of resolved.levels) {
        if (!L0.keptClear) continue;
        const bare: ResolvedLevel = { ...L0 };
        delete bare.arrangements;
        const run = runRecipes(bare, new ArrangementRecords(), {
          planSeed: plan.seed,
          profile: generatorProfile(5),
          palette: resolveView(plan, pal),
          budget: 1e6,
          families: forced({ ground: { layeredGround: "layered" } }),
          recipes: [layeredGround],
        });
        const L: ResolvedLevel = { ...bare, arrangements: [...run.attached] };
        const g = new LevelGrid(L, "dungeon");
        const kept = new Set(L0.keptClear);
        const furniture: Box2[] = L.features
          .filter((f) => f.blocking && f.wall === undefined)
          .map((f) => {
            const ox = f.offset?.[0] ?? 0;
            const oy = f.offset?.[1] ?? 0;
            return {
              x0: f.at[0] + ox,
              y0: f.at[1] + oy,
              x1: f.at[0] + f.size[0] + ox,
              y1: f.at[1] + f.size[1] + oy,
            };
          });
        for (const b of pieceBoxes(resolveView(plan, pal), L, "layeredGround")) {
          checked++;
          for (let y = Math.floor(b.y0 + TOUCH); y < b.y1 - TOUCH; y++)
            for (let x = Math.floor(b.x0 + TOUCH); x < b.x1 - TOUCH; x++)
              expect(kept.has(g.index(x, y)), `${name} ${L.id}: cover over kept-clear cell ${x},${y}`).toBe(
                false,
              );
          const under = furniture.find((f) => overlaps(f, b));
          expect(
            under,
            `${name} ${L.id}: cover ${JSON.stringify(b)} under furniture ${JSON.stringify(under)}`,
          ).toBeUndefined();
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  }, 120_000);

  it("stands no wall treatment piece in a room light's piece", () => {
    const WALL_RECIPES = /^(jambPosts|cornerPosts|bandCourses|plinths|pilasters)@/;
    let lights = 0;
    for (const name of ["interiors-lineup-v1", "ground-and-walls-v1"] as const) {
      const resolved = resolvePlan({ ...loadPlan(name), generator: 5 }, pal);
      const set = realize(resolved, pal, {});
      const lightIds = new Set(
        resolved.levels.flatMap((L) =>
          L.features.filter((f) => featureInfo(f.type).light === true).map((f) => f.id),
        ),
      );
      for (const lvl of set.levels) {
        const boxes = lvl.placements.flatMap((p) => {
          const box = set.placed.get(p)?.box;
          return box ? [{ id: String(p.source.elementId), box }] : [];
        });
        const lit = boxes.filter((b) => lightIds.has(b.id));
        const trims = boxes.filter((b) => WALL_RECIPES.test(b.id));
        lights += lit.length;
        for (const t of trims)
          for (const l of lit) {
            const ov = (k: "x" | "y" | "z"): number =>
              Math.min(t.box.max[k], l.box.max[k]) - Math.max(t.box.min[k], l.box.min[k]);
            expect(ov("x") > TOUCH && ov("y") > TOUCH && ov("z") > TOUCH, `${name}: ${t.id} in ${l.id}`).toBe(
              false,
            );
          }
      }
    }
    expect(lights).toBeGreaterThan(10);
  }, 120_000);
});
