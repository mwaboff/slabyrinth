/**
 * Room furniture's real outline against the wall pieces it stands by (generator 5). Before the room-kind furnisher, the
 * generator-4 room recipe ran at generator 5 and asked only the wall line, not the posts a wall pieces' joint holds (a
 * corner filler at a T, a castle wall's half piece): in multi-level-stairs' study a bookshelf stood 0.13 into a wall
 * and a leather chest 0.17 into a corner filler (sweep seeds 387276917, 3428989595), and a book was left 1.22 above a
 * refused shelf (2027808452). The furnisher asks every piece's outline against the posts too (RoomOpts.junctionPosts,
 * touchShift), so the build verifies with no room piece in a wall and none floating.
 */
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const SEEDS = [387276917, 3428989595, 2027808452] as const;
const PLACED = /^verify_prop_(in_wall|floating|no_floor|sunk)$/;

describe("room furniture by the walls (generator 5)", () => {
  it.each(SEEDS)("multi-level-stairs at seed %i: no room piece in a wall or floating", (seed) => {
    const plan = sweepPlan("multi-level-stairs", seed, 5);
    expect(plan.generator).toBe(5);
    const d = compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "t", plan }).diagnostics;
    const room = d.filter((x) => PLACED.test(x.code) && x.message.includes("~room"));
    expect(room.map((x) => x.message)).toEqual([]);
  });
});
