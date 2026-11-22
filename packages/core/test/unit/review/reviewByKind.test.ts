/**
 * The review by room kind (generator 5, switch `reviewByKind`, review/interiors.ts): a room is judged by its kind's row
 * of the room-kind table (gen/roomTraits.ts roomTargets). Each case reviews one resolved map twice, as generator 5 and
 * as generator 4 (no switch), so the difference is the switch's. The resolved rooms are edited to hold exactly the
 * furniture the case is about.
 */
import { describe, expect, it } from "vitest";
import type { Area, FeatureType, MapPlan } from "../../../src/contracts/plan";
import type { ResolvedFeature, ResolvedPlan } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign, type DesignNoteCode } from "../../../src/review";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

const room = (id: string, name: string, x: number, y: number, w: number, h: number): Area => ({
  id,
  kind: "room",
  name,
  shape: { type: "rect", x, y, w, h },
});

const piece = (area: string, type: FeatureType, at: [number, number], n: number): ResolvedFeature => ({
  id: `${area}-${type}-${String(n)}`,
  type,
  at,
  size: [1, 1],
  rot: 0,
  rotFine: 0,
  baseHeight: 0.5,
  theme: "stone_dungeon",
  area,
  blocking: type !== "torch_wall" && type !== "candles",
});

/** Two rooms side by side, `a` (8 x 8) and `b` (6 x 6), with a door; `fill` sets each room's features. */
function judged(
  names: [string, string],
  fill: Record<string, ResolvedFeature[]>,
): { g5: DesignNoteCode[]; g4: DesignNoteCode[] } {
  const p: MapPlan = dungeonPlan({
    generator: 5,
    w: 18,
    h: 10,
    areas: [room("a", names[0], 1, 1, 8, 8), room("b", names[1], 9, 1, 6, 6)],
    openings: [{ id: "d", kind: "door", between: ["a", "b"] }],
  });
  const r: ResolvedPlan = resolvePlan(p, pal);
  for (const L of r.levels) L.features = [...(fill.a ?? []), ...(fill.b ?? [])];
  const of = (plan: MapPlan): DesignNoteCode[] =>
    reviewDesign(plan, r, pal, { limit: 999 }).map((n) => n.code);
  return { g5: of(p), g4: of({ ...p, generator: 4 }) };
}

/** `n` pieces of a type along row y of a room from x0. */
const many = (area: string, type: FeatureType, n: number, x0: number, y: number): ResolvedFeature[] =>
  Array.from({ length: n }, (_, i) => piece(area, type, [x0 + (i % 6), y + Math.floor(i / 6)], i));

/** A dressed bedroom in b: bed, chests, a torch (well over 3 props per 10 tiles). */
const dressedB = [
  piece("b", "bed", [9, 1], 0),
  ...many("b", "chest", 6, 9, 6),
  ...many("b", "crate", 6, 9, 5),
  piece("b", "torch_wall", [14, 3], 0),
];

describe("review by room kind (generator 5)", () => {
  it("room_bare: a hall carried by columns is not bare; the same hall without them is", () => {
    const hall = [
      piece("a", "torch_wall", [1, 4], 0),
      piece("a", "pillar", [3, 3], 1),
      piece("a", "pillar", [6, 6], 2),
    ];
    const carried = judged(["Pillared Hall", "Bedroom"], { a: hall, b: dressedB });
    expect(carried.g4).toContain("room_bare");
    expect(carried.g5).not.toContain("room_bare");
    const plain = judged(["Pillared Hall", "Bedroom"], { a: hall.slice(0, 1), b: dressedB });
    expect(plain.g5).toContain("room_bare");
  });

  it("furniture_adrift: a taproom's free-standing tables are its floor groups; a bedroom's are adrift", () => {
    const tables = [...many("a", "table", 5, 2, 3), piece("a", "torch_wall", [1, 4], 0)];
    const tap = judged(["Taproom", "Bedroom"], { a: tables, b: dressedB });
    expect(tap.g4).toContain("furniture_adrift");
    expect(tap.g5).not.toContain("furniture_adrift");
    expect(judged(["Bedroom", "Bedroom"], { a: tables, b: dressedB }).g5).toContain("furniture_adrift");
  });

  it("anchor_missing: a bedroom with no bed, only chests; with a bed it is fine", () => {
    const chests = [...many("a", "chest", 6, 1, 1), piece("a", "torch_wall", [1, 4], 0)];
    const none = judged(["Bedroom", "Bedroom"], { a: chests, b: dressedB });
    expect(none.g5).toContain("anchor_missing");
    expect(none.g4).not.toContain("anchor_missing");
    const bed = judged(["Bedroom", "Bedroom"], { a: [...chests, piece("a", "bed", [6, 6], 9)], b: dressedB });
    expect(bed.g5).not.toContain("anchor_missing");
  });
});
