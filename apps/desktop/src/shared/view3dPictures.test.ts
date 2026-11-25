/**
 * The measured findings under the model's 3D picture: only those whose pieces a view draws (or, for a fault with no
 * piece of its own, whose box a drawn piece touches), in plain words with level, element and square, faults first;
 * the rest counted as elsewhere. Each is marked as a change the plan can make or as the app's own placement, from
 * what the plan positions; and the pieceless test stays local on a very large scene.
 */
import type { Finding, Scene } from "@slabyrinth/scene3d";
import { describe, expect, it } from "vitest";
import {
  APP_PLACED_WORDS,
  MAX_FINDING_LINES,
  findingsText,
  planFix,
  type PlannedKind,
} from "./view3dPictures";

const box = (x: number, y: number, z: number) => ({
  min: { x, y, z },
  max: { x: x + 1, y: y + 1, z: z + 1 },
});

const scene = {
  levels: [{ id: "l1", name: "Cellar", index: 0, bounds: box(0, 0, 0) }],
  instances: [{ aabb: box(0, 0, 0) }, { aabb: box(5, 0, 5) }, { aabb: box(20, 0, 20) }],
} as unknown as Scene;

function finding(
  o: Partial<Omit<Finding, "pieces">> & { pieces?: number[]; owner?: string | null; at?: [number, number] },
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
    pieces: (o.pieces ?? []).map((index) => ({
      index,
      name: "Wall",
      uuid: "u",
      elementId: o.owner === undefined ? "hall" : o.owner,
    })),
    measure: {},
    message: o.message ?? "a 0.4-tile gap in hall's wall",
  };
}

/** A plan with an area "hall", a feature "lamp", an opening "d1", a link "st" and a dress op "dress1". */
const KINDS: Record<string, NonNullable<ReturnType<PlannedKind>>> = {
  hall: "area",
  lamp: "feature",
  d1: "opening",
  st: "link",
  dress1: "terrain",
};
const kinds: PlannedKind = (id) => KINDS[id] ?? null;

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
      "- view 1, 2, level Cellar (l1), hall, square 0,0: a 0.4-tile gap in hall's wall.",
      "- view 2, level Cellar (l1): a hole in the deck.",
      "- view 2, level Cellar (l1), hall, square 5,5: a lamp half inside a wall (worth a look; often fine).",
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

  it("marks a finding the plan can fix (by what the plan positions) and the app's own placement", () => {
    // the plan positions features, openings, links and wall runs: a fault on their pieces is an edit away
    expect(planFix(finding({ code: "clash", pieces: [0], owner: "lamp" }), kinds)).toBe(
      "move it or give it room",
    );
    expect(planFix(finding({ code: "floating", pieces: [0], owner: "lamp" }), kinds)).toBe(
      "move it or pick another support for it",
    );
    expect(planFix(finding({ code: "way_blocked", where: { elementId: "d1" } as never }), kinds)).toMatch(
      /change the opening/,
    );
    expect(planFix(finding({ code: "way_blocked", where: { elementId: "st" } as never }), kinds)).toMatch(
      /stairs/,
    );
    // what the generator lays: an area's shell, dressing from a dress op, a generated part ("inn~door0"), no owner
    expect(planFix(finding({ pieces: [0], owner: "hall" }), kinds)).toBeNull();
    expect(planFix(finding({ code: "floating", pieces: [0], owner: "dress1" }), kinds)).toBeNull();
    expect(planFix(finding({ pieces: [0], owner: "inn~door0" }), kinds)).toBeNull();
    expect(planFix(finding({ code: "deck_hole" }), kinds)).toBeNull();
    const text = findingsText(
      scene,
      [finding({ code: "clash", pieces: [0], owner: "lamp" }), finding({ pieces: [1], owner: "dress1" })],
      [new Set([0, 1])],
      kinds,
    );
    expect(text).toContain("Plan fix: move it or give it room.");
    expect(text).toContain(APP_PLACED_WORDS);
  });

  it("a pieceless fault is tested only against the drawn pieces around it, on a very large scene", () => {
    // 200,000 drawn pieces on a 1,000 × 200 field, 400 holes with no piece of their own
    const instances = Array.from({ length: 200_000 }, (_, i) => ({
      aabb: box(i % 1000, 0, Math.floor(i / 1000)),
    }));
    const big = { levels: scene.levels, instances } as unknown as Scene;
    const holes = Array.from({ length: 400 }, (_, k) =>
      finding({
        code: "deck_hole",
        message: "a hole",
        where: { box: box((k * 37) % 1000, 0, (k * 13) % 200) } as never,
      }),
    );
    const stats = { boxTests: 0 };
    const drawn = new Set(instances.map((_, i) => i));
    const text = findingsText(big, holes, [drawn], undefined, stats);
    expect(text).toMatch(/^Measured on the pieces in view/);
    // each hole looks at its own few squares (the first touching piece ends it), never at the 200,000
    expect(stats.boxTests).toBeLessThan(400 * 50);
  });
});
