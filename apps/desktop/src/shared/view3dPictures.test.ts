/**
 * The measured findings under the model's 3D picture: only those whose pieces a view draws (or, for a fault with no
 * piece of its own, whose box a drawn piece touches), in plain words with level, element and square, faults first;
 * the rest counted as elsewhere.
 */
import type { Finding, Scene } from "@slabyrinth/scene3d";
import { describe, expect, it } from "vitest";
import { MAX_FINDING_LINES, findingsText } from "./view3dPictures";

const box = (x: number, y: number, z: number) => ({
  min: { x, y, z },
  max: { x: x + 1, y: y + 1, z: z + 1 },
});

const scene = {
  levels: [{ id: "l1", name: "Cellar", index: 0, bounds: box(0, 0, 0) }],
  instances: [{ aabb: box(0, 0, 0) }, { aabb: box(5, 0, 5) }, { aabb: box(20, 0, 20) }],
} as unknown as Scene;

function finding(
  o: Partial<Omit<Finding, "pieces">> & { pieces?: number[]; at?: [number, number] },
): Finding {
  return {
    code: o.code ?? "shell_gap",
    severity: o.severity ?? "fault",
    where: {
      levelId: "l1",
      levelIndex: 0,
      box: o.where?.box ?? box(0, 0, 0),
      cells: o.at ? [o.at] : [],
      elementId: o.where?.elementId ?? null,
    },
    pieces: (o.pieces ?? []).map((index) => ({ index, name: "Wall", uuid: "u", elementId: "hall" })),
    measure: {},
    message: o.message ?? "a 0.4-tile gap in hall's wall",
  };
}

describe("findings under the model's 3D picture", () => {
  it("lists what each view draws, faults first, with places; counts the rest", () => {
    const text = findingsText(
      scene,
      [
        finding({ pieces: [2], message: "far away", at: [20, 20] }),
        finding({ severity: "warn", pieces: [1], message: "a lamp half inside a wall", at: [5, 5] }),
        finding({ pieces: [0], at: [0, 0] }),
        // a hole has no piece of its own: in view when a drawn piece touches its box
        finding({ code: "deck_hole", message: "a hole in the deck", where: { box: box(5, 0, 5) } as never }),
      ],
      [new Set([0]), new Set([0, 1])],
    );
    expect(text.split("\n")).toEqual([
      "Measured on the pieces in view (faults first):",
      "- view 1, 2, level Cellar (l1), hall, square 0,0: a 0.4-tile gap in hall's wall",
      "- view 2, level Cellar (l1): a hole in the deck",
      "- view 2, level Cellar (l1), hall, square 5,5: a lamp half inside a wall (worth a look; often fine)",
      '1 more measured elsewhere on the map (ask for "flagged" or a view of that place).',
    ]);
  });

  it("says so when nothing was measured in view, says nothing when the checks could not run, and caps the list", () => {
    expect(findingsText(scene, [], [new Set([0])])).toMatch(/^Measured on the pieces in view: no gaps/);
    expect(findingsText(scene, null, [new Set([0])])).toBe("");
    const many = Array.from({ length: MAX_FINDING_LINES + 3 }, () => finding({ pieces: [0] }));
    const lines = findingsText(scene, many, [new Set([0])]).split("\n");
    expect(lines).toHaveLength(MAX_FINDING_LINES + 2);
    expect(lines.at(-1)).toBe("- and 3 more in view");
  });
});
