/** Generator 3 terrain: outcrop outlines, default rock bands (and their opt-out), sub-cell piece offsets. */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import type { GeneratorVersion, Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { boxFill, components, squareCorners } from "../../../src/review/metrics";

function plan(
  generator: GeneratorVersion,
  terrain: TerrainOp[],
  extra: Partial<Level> = {},
  features: Level["features"] = [],
): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "t3",
    title: "T3",
    kind: "outdoor",
    theme: "outdoor",
    seed: 11,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 36, h: 28 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features,
        terrain,
        labels: [],
        ...extra,
      },
    ],
  };
}

describe("outcrops are not blocks (generator 3)", () => {
  const lump = (seed: number, generator: GeneratorVersion): Array<[number, number]> => {
    const p = plan(generator, [
      { id: "o", op: "outcrop", shape: { type: "rect", x: 10, y: 10, w: 5, h: 4 } },
    ]);
    p.seed = seed;
    const l = resolvePlan(p, bundledPalettes()).levels[0];
    const out: Array<[number, number]> = [];
    for (let i = 0; i < 36 * 28; i++)
      if ((l?.cells.height[i] ?? 0) > 0) out.push([i % 36, Math.floor(i / 36)]);
    return out;
  };
  it("corners are cut: fewer square corners and a looser box than at generator 2, same cells never added", () => {
    let sq2 = 0;
    let sq3 = 0;
    let fill2 = 0;
    let fill3 = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const a = lump(seed, 2);
      const b = lump(seed, 3);
      for (const c of components(a)) {
        sq2 += squareCorners(c, 2);
        fill2 += boxFill(c);
      }
      for (const c of components(b)) {
        sq3 += squareCorners(c, 2);
        fill3 += boxFill(c);
      }
      const inA = new Set(a.map(([x, y]) => `${x},${y}`));
      expect(
        b.every(([x, y]) => inA.has(`${x},${y}`)),
        `seed ${seed}: only removes cells`,
      ).toBe(true);
      expect(b.length).toBeGreaterThanOrEqual(8);
    }
    expect(sq3).toBeLessThan(sq2 * 0.5);
    expect(fill3).toBeLessThan(fill2);
  });
});

describe("default rock bands (generator 3)", () => {
  const rise: TerrainOp = {
    id: "hill",
    op: "platform",
    shape: { type: "rect", x: 8, y: 6, w: 18, h: 14 },
    tiers: 1,
    rise: 2.5,
    material: "grass",
    edge: "ragged",
  };
  const faces = (p: MapPlan): number =>
    resolvePlan(p, bundledPalettes()).levels[0]?.features.filter(
      (f) => f.type === "cliff_face" || f.type === "cliff_crest",
    ).length ?? 0;
  it("a 2-tile rise with no dress op gets rock; cliffBands:false and generator 2 get none", () => {
    expect(faces(plan(3, [rise]))).toBeGreaterThan(0);
    expect(faces(plan(3, [rise], { cliffBands: false }))).toBe(0);
    expect(faces(plan(2, [rise]))).toBe(0);
  });
});

describe("sub-cell offsets (generator 3)", () => {
  it("a feature offset moves the compiled piece by that many tiles", () => {
    const palettes = loadPalettes();
    const build = (offset?: [number, number]): { x: number; z: number } | undefined => {
      const r = resolvePlan(
        plan(3, [], {}, [{ id: "stone", type: "boulder", at: [10, 10] }]),
        bundledPalettes(),
      );
      const f = r.levels[0]?.features.find((q) => q.id === "stone");
      if (f && offset) f.offset = offset;
      const set = realize(r, palettes, {});
      const p = set.levels[0]?.placements.find((q) => q.source.elementId === "stone");
      return p ? { x: p.x, z: p.z } : undefined;
    };
    const a = build();
    const b = build([0.5, 0]);
    const c = build([0, -0.25]);
    expect(a).toBeDefined();
    expect(Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.z ?? 0) - (a?.z ?? 0))).toBeCloseTo(0.5, 5);
    expect(Math.hypot((c?.x ?? 0) - (a?.x ?? 0), (c?.z ?? 0) - (a?.z ?? 0))).toBeCloseTo(0.25, 5);
  });
});

describe("trails arrive (generator 3)", () => {
  const trail: TerrainOp = {
    id: "trail",
    op: "path",
    points: [
      [0, 20],
      [14, 20],
    ],
    width: 1,
    material: "dirt",
  };
  const p = (generator: GeneratorVersion): MapPlan =>
    plan(
      generator,
      [trail],
      {
        structures: [{ id: "hut", style: "modern_block", wings: [{ x: 22, y: 5, w: 6, h: 5 }], front: "S" }],
      },
      [{ id: "mark", type: "landmark", at: [30, 22] }],
    );
  const pathAt = (generator: GeneratorVersion, x: number, y: number): boolean => {
    const l = resolvePlan(p(generator), bundledPalettes()).levels[0];
    return ((l?.cells.flags[y * 36 + x] ?? 0) & 8) !== 0; // CELL_FLAG.PATH
  };
  it("ends at the cell outside the door and at the landmark; generator 2 stops short", () => {
    const l = resolvePlan(p(3), bundledPalettes()).levels[0];
    const door = l?.openings.find((o) => o.kind === "door" || o.kind === "double_door");
    expect(door).toBeDefined();
    const inside = new Set((l?.structures?.[0]?.cells ?? []).map(([x, y]) => `${x},${y}`));
    const [sx, sy] = door?.start ?? [0, 0];
    // the two cells either side of the door's edge: the one that is not the building is outside the door
    const pair: Array<[number, number]> =
      door?.orientation === "h"
        ? [
            [sx, sy - 1],
            [sx, sy],
          ]
        : [
            [sx - 1, sy],
            [sx, sy],
          ];
    const out = pair.find(([x, y]) => !inside.has(`${x},${y}`)) ?? [0, 0];
    expect(pathAt(3, out[0], out[1])).toBe(true);
    expect(pathAt(3, 30, 22)).toBe(true);
    expect(pathAt(2, out[0], out[1])).toBe(false);
  });
});

describe("review: square_outcrop", () => {
  const codes = (generator: GeneratorVersion): string[] => {
    const p = plan(generator, [
      { id: "o", op: "outcrop", shape: { type: "rect", x: 10, y: 10, w: 5, h: 4 } },
    ]);
    return reviewDesign(p, resolvePlan(p, bundledPalettes()), bundledPalettes()).map((n) => n.code);
  };
  it("fires on a block-shaped outcrop (generator 2), is silent once the outline is cut (generator 3)", () => {
    expect(codes(2)).toContain("square_outcrop");
    expect(codes(3)).not.toContain("square_outcrop");
  });
});
