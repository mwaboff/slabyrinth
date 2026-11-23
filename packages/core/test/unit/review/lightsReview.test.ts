/**
 * Lights in the review after the lighting regimes (generator 5, review/lights.ts): a piece that gives no light (a stone
 * lantern) is no light; a room drawn dim or dark is not unlit by mistake; a kind that lays out floor groups is not
 * judged for furniture off the walls.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedFeature, ResolvedPlan } from "../../../src/contracts/resolved";
import { ROOM_KINDS, roomTargets, roomTraits } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { elementCharacter } from "../../../src/resolve/character";
import { lightGiver, sceneMeantDim } from "../../../src/review/lights";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

const lamp = (theme: string, type: ResolvedFeature["type"]): ResolvedFeature => ({
  id: "l",
  type,
  at: [2, 2],
  size: [1, 1],
  rot: 0,
  rotFine: 0,
  baseHeight: 0.5,
  theme,
  blocking: false,
});

const plan = (generator: 4 | 5) =>
  dungeonPlan({
    generator,
    w: 18,
    h: 10,
    areas: [
      { id: "a", kind: "room", name: "Bedroom", shape: { type: "rect", x: 1, y: 1, w: 6, h: 6 } },
      { id: "b", kind: "room", name: "Study", shape: { type: "rect", x: 7, y: 1, w: 6, h: 6 } },
    ],
    openings: [{ id: "d", kind: "door", between: ["a", "b"] }],
  });

describe("lights in the review (generator 5)", () => {
  it("a stone lantern is no light; a street lantern is", () => {
    const r5 = resolvePlan(plan(5), pal);
    expect(lightGiver(r5, pal)(lamp("outdoor", "accent_light"))).toBe(false);
    expect(lightGiver(r5, pal)(lamp("stone_dungeon", "torch_wall"))).toBe(true);
    // a released generator counts every light feature
    expect(lightGiver(resolvePlan(plan(4), pal), pal)(lamp("outdoor", "accent_light"))).toBe(true);
  });

  it("a room drawn dim with no light is not unlit; a room drawn moderate is", () => {
    const r: ResolvedPlan = resolvePlan(plan(5), pal);
    // room a with every light taken out
    const unlit = (level: number): boolean => {
      for (const L of r.levels) {
        L.features = L.features.filter(
          (f) => f.area !== "a" || (f.type !== "torch_wall" && f.type !== "candles"),
        );
        L.features = L.features.filter(
          (f) => !(f.area === "a" && ["candelabra", "brazier", "lantern"].includes(f.type)),
        );
        for (const a of L.areas) if (a.id === "a") a.lightLevel = level;
      }
      return reviewDesign(plan(5), r, pal, { limit: 999 }).some(
        (n) => n.code === "room_unlit" && (n.elementIds ?? []).includes("a"),
      );
    };
    expect(unlit(2)).toBe(true);
    expect(unlit(1)).toBe(false);
  });

  it("a dungeon scene its mood makes bright is not meant dim; the review reads the scene's character", () => {
    const scene = (notes: string) => {
      const p = dungeonPlan({
        generator: 5,
        w: 18,
        h: 10,
        title: "The lower halls",
        summary: "Two rooms.",
        kind: "building",
        level: { name: "Halls", notes },
        areas: [{ id: "a", kind: "room", name: "Bedroom", shape: { type: "rect", x: 1, y: 1, w: 6, h: 6 } }],
      });
      const L = resolvePlan(p, pal).levels[0];
      if (!L) throw new Error("no level");
      return { p, L };
    };
    // (the words name no light; the mood "clinical" floods it, where the theme alone would leave a dungeon dim)
    const bright = scene("Kept clinical and white.");
    expect(elementCharacter(bright.L, bright.L.id)?.light).toBe("flooded");
    expect(sceneMeantDim(bright.p, bright.L)).toBe(false);
    const plain = scene("Old halls.");
    expect(sceneMeantDim(plain.p, plain.L)).toBe(true);
  });

  it("a kind whose floor column lays out groups stands its furniture free on purpose", () => {
    // (a hall plan alone does not: only a room big enough to be a hall is laid out by it, generator 5 grandHalls)
    for (const k of ROOM_KINDS)
      if (roomTraits(k).floor.some((p) => p.mode !== "hall")) expect(roomTargets(k).floorGroups).toBe(true);
  });
});
