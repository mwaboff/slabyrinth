/**
 * Room pieces keep clear of the posts and walls realize builds (generator 5, switch postsAtBuildingCorners). Measured on
 * the built pieces of several plans with furnished rooms under several seeds, for every piece the room furnisher placed
 * (element ids "...~room#n": gen/rooms4):
 * - its box meets no built post (role wall_post) at all;
 * - it reaches into no wall or opening piece further than verify pushes a prop back out (the build raises no
 *   `verify_prop_in_wall` for it; a shelf or torch hung on a wall touches it by design, and a crate a few hundredths in
 *   is moved out as `verify_prop_nudged`).
 * Without the switch, a building volume stood a post at each of its own corners, also where it met another volume of
 * the building in a straight wall or its corner met the other's wall: half a tile into the next volume's room, where the
 * furnisher (which reads the level's walls: no corner there) set a workbench, a table or a barrel against the wall.
 * Without `featureOutlinesClear`, a detail recipe's corner trim post (resolve/recipes/walls.ts cornerPosts) kept off a
 * wall rack's cell but stood in the rack's end where the piece is wider than the cell.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import type { Box3 } from "../../../src/contracts/compiler";
import { PROP_IN_WALL_HEIGHT, PROP_IN_WALL_MIN } from "../../../src/compile/verify/limits";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import type { StoredPlan } from "../../fixtures";
import { sweepPlan, sweepSeeds } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

const span = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);
const meets = (a: Box3, b: Box3): boolean =>
  span(a.min.x, a.max.x, b.min.x, b.max.x) > PROP_IN_WALL_MIN &&
  span(a.min.z, a.max.z, b.min.z, b.max.z) > PROP_IN_WALL_MIN &&
  span(a.min.y, a.max.y, b.min.y, b.max.y) > PROP_IN_WALL_HEIGHT;
/** A piece the room furnisher placed: a room's own, a cell's of a cell row, its aisle's, a dead end's set. */
const ROOM_PIECE = /~(room|cell\d+|aisle|deadend)#\d+$/;

/** Over the plans and seeds: the room pieces built, those meeting a built post, and those verify finds in a wall. */
function measure(
  plans: readonly StoredPlan[],
  seeds: readonly number[],
): { pieces: number; inPost: string[]; inWall: string[] } {
  let pieces = 0;
  const inPost: string[] = [];
  const inWall: string[] = [];
  for (const name of plans)
    for (const seed of seeds) {
      const plan = sweepPlan(name, seed);
      const set = realize(resolvePlan(plan, pal), pal, {});
      for (const L of set.levels) {
        const posts = L.placements
          .filter((p) => p.role === "wall_post")
          .flatMap((p) => {
            const box = set.placed.get(p)?.box;
            return box ? [{ id: p.source.elementId ?? "", box }] : [];
          });
        for (const p of L.placements) {
          const id = p.source.elementId ?? "";
          if (p.role !== "feature" || !ROOM_PIECE.test(id)) continue;
          const a = set.placed.get(p)?.box;
          if (!a) continue;
          pieces++;
          for (const q of posts)
            if (meets(a, q.box))
              inPost.push(
                `${name}@${String(seed)} ${id} in ${q.id} ${span(a.min.x, a.max.x, q.box.min.x, q.box.max.x).toFixed(2)} ${span(a.min.z, a.max.z, q.box.min.z, q.box.max.z).toFixed(2)} ${set.placed.get(p)?.name ?? ""}`,
              );
        }
      }
      const built = compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "t", plan });
      for (const d of built.diagnostics)
        if (d.code === "verify_prop_in_wall" && ROOM_PIECE.test(d.elementId ?? ""))
          inWall.push(`${name}@${String(seed)} ${d.elementId ?? ""}`);
    }
  return { pieces, inPost, inWall };
}

describe("postsAtBuildingCorners", () => {
  it("no room piece meets a built post or stands in a wall, over several plans and seeds", () => {
    const plans: StoredPlan[] = [
      "market-street-v3",
      "building-rooms-street-v1",
      "two-quarters-v1",
      "keep-dungeon-v8",
      "inn-interior-v1",
      // cell rows in buildings (a stable, an infirmary) and in a room of a town level (generator 5, cellRows)
      "cell-rows-town-v1",
    ];
    const on = measure(plans, sweepSeeds(5));
    expect(on.pieces).toBeGreaterThan(800);
    expect(on.inPost).toEqual([]);
    expect(on.inWall).toEqual([]);
  }, 300_000);

  // the market street's seeds (of the first 150 sweep seeds) whose room pieces stood in a wing's post
  it("the market street's wing posts no longer stand in its rooms; without the switch they do", () => {
    const failed = [295853050, 3006791469, 1901463376, 2197316426, 556784891];
    expect(failed.every((s) => sweepSeeds(150).includes(s))).toBe(true);
    // (the seeds were found before the later street switches redrew the buildings: built as then)
    P5.roofFormsFit = false;
    const on = measure(["market-street-v3"], failed);
    expect([...on.inPost, ...on.inWall]).toEqual([]);
    P5.postsAtBuildingCorners = false;
    const off = measure(["market-street-v3"], failed);
    expect(off.inPost.filter((s) => s.includes("~wing~post ")).length).toBeGreaterThanOrEqual(failed.length);
    expect(off.inWall.length).toBe(failed.length);
  }, 120_000);

  it("a corner trim post keeps clear of a wall rack wider than its cell (featureOutlinesClear)", () => {
    const seeds = sweepSeeds(5);
    expect(measure(["inn-interior-v1"], seeds).inPost).toEqual([]);
    // (with `shelvesWithinWalls` a rack no longer reaches past the wall's end where the corner post stands, so both
    // are off to show the post in the rack's end)
    P5.featureOutlinesClear = false;
    P5.shelvesWithinWalls = false;
    const off = measure(["inn-interior-v1"], seeds).inPost;
    expect(off.filter((s) => s.includes(" in cornerPosts@")).length).toBeGreaterThan(3);
  }, 120_000);
});
