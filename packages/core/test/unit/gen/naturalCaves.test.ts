/**
 * Generator 4 natural caves: the rock mass is solid from its foot up (no lace
 * of columns over the water plane), the cave floor steps in half-tile shelves, and chambers and corridors drawn as
 * rectangles get ragged outlines. Generator 3 output stays as it was (test/golden/generator3 pins it); these tests
 * compare the same plans at generators 3 and 4.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { CELL, CELL_FLAG, type ResolvedLevel } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { loadPalettes } from "../../../src/palette";
import {
  caveHollowNotesOf,
  caveMassReviewNotes,
  massInputOf,
  massMeasures,
  massPiecesOf,
} from "../../../src/review/caveMass";
import { caveNaturalChecks, caveNaturalMeasures } from "../../../src/review/caveWall";
import { reviewDesign } from "../../../src/review";
import { reviewBuild } from "../../../src/review/reviewBuild";
import { checkPlayability, resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { loadPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";

const fixture = loadPlan("sea-grotto");
const palettes = loadPalettes();

const D4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function level(r: ReturnType<typeof resolvePlan>): ResolvedLevel {
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  return L;
}

/** Open cells (local index) and 4-connected pieces of open floor. */
function openPieces(L: ResolvedLevel): number {
  const { w, h } = L.bounds;
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || L.cells.state[s] !== CELL.OPEN) continue;
    n++;
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const x = c % w;
      const y = Math.floor(c / w);
      for (const [dx, dy] of D4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && L.cells.state[j] === CELL.OPEN) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return n;
}

/** Open cells in no 2×2 block of open cells (a passage one cell wide). */
function narrowCells(L: ResolvedLevel): number {
  const { w, h } = L.bounds;
  const open = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && L.cells.state[y * w + x] === CELL.OPEN;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!open(x, y)) continue;
      const block = (
        [
          [0, 0],
          [-1, 0],
          [0, -1],
          [-1, -1],
        ] as const
      ).some(
        ([ox, oy]) =>
          open(x + ox, y + oy) &&
          open(x + ox + 1, y + oy) &&
          open(x + ox, y + oy + 1) &&
          open(x + ox + 1, y + oy + 1),
      );
      if (!block) n++;
    }
  return n;
}

describe("generator 4 sea grotto: solid rock, shelved floor, ragged outline", () => {
  const build = (generator: 3 | 4) => {
    const plan = { ...fixture, generator } as MapPlan;
    const r = resolvePlan(plan);
    const set = realize(r, palettes, {});
    const verify = verifyBuild(r, set, palettes, { plan }).diagnostics;
    return { plan, r, set, verify };
  };
  const g3 = build(3);
  const g4 = build(4);
  const measures = (b: typeof g3) => {
    const L = level(b.r);
    return massMeasures(massInputOf(L, massPiecesOf(b.set, b.r, palettes, L.id)));
  };
  const m3 = measures(g3);
  const m4 = measures(g4);

  it("fills the rock from its foot: no cap over empty rock, no see-through gap", () => {
    expect(m3.hollow).toBeGreaterThan(0.15);
    expect(m4.hollow).toBeLessThan(0.04);
    expect(g4.set.levels.flatMap((l) => l.placements).some((p) => p.source.elementId === "cave_cap")).toBe(
      false,
    );
    expect(m4.uncovered).toBeLessThan(0.08);
    expect(m4.separated).toBeLessThan(0.25);
    expect(m4.longestRun).toBeLessThanOrEqual(3);
    expect(m4.families).toEqual(["cavern"]);
  });

  it("keeps the rock-mass piece count near generator 3's (mass and cap)", () => {
    const mass = (b: typeof g3): number =>
      b.set.levels
        .flatMap((l) => l.placements)
        .filter((p) => p.source.elementId === "cave_mass" || p.source.elementId === "cave_cap").length;
    expect(mass(g4)).toBeLessThanOrEqual(mass(g3) * 1.15);
  });

  it("verify stays clean and every floor stays reachable", () => {
    const bad = g4.verify.filter((d) => d.severity !== "info");
    expect(bad.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const issues = checkPlayability(g4.plan, g4.r).filter((i) => i.severity !== "info");
    expect(issues.map((i) => `${i.code} ${i.message}`)).toEqual([]);
  });

  it("shelves the flat floor in half-tile steps, low by the water, never under features", () => {
    const n3 = caveNaturalMeasures(level(g3.r));
    const n4 = caveNaturalMeasures(level(g4.r));
    expect(n3.flatShare).toBeGreaterThan(0.85);
    expect(n4.flatShare).toBeLessThan(0.75);
    const L = level(g4.r);
    const { w, h } = L.bounds;
    const dry = (i: number): boolean =>
      L.cells.state[i] === CELL.OPEN &&
      ((L.cells.flags[i] as number) & (CELL_FLAG.WATER | CELL_FLAG.NO_FLOOR)) === 0;
    const heights = new Set<number>();
    for (let i = 0; i < w * h; i++) if (dry(i)) heights.add(L.cells.height[i] as number);
    // at least two shelves above the main floor
    expect([...heights].filter((q) => q >= 2).length).toBeGreaterThanOrEqual(2);
    // where generator 3 had one floor, generator 4's neighbours differ by half a tile at most (walkable)
    const L3 = level(g3.r);
    for (let y = 0; y < h; y++)
      for (let x = 0; x + 1 < w; x++)
        for (const [a, b] of [
          [y * w + x, y * w + x + 1],
          ...(y + 1 < h ? [[y * w + x, (y + 1) * w + x]] : []),
        ] as Array<[number, number]>) {
          if (!dry(a) || !dry(b) || L3.cells.height[a] !== L3.cells.height[b]) continue;
          if (L3.cells.state[a] !== CELL.OPEN || L3.cells.state[b] !== CELL.OPEN) continue;
          expect(Math.abs((L.cells.height[a] as number) - (L.cells.height[b] as number))).toBeLessThanOrEqual(
            2,
          );
        }
    // the explicit lantern and water cells keep their generator-3 height
    for (const f of fixture.levels[0]?.features ?? []) {
      const i = f.at[1] * w + f.at[0];
      expect(L.cells.height[i]).toBe(L3.cells.height[i]);
    }
    for (let i = 0; i < w * h; i++)
      if (((L3.cells.flags[i] as number) & CELL_FLAG.WATER) !== 0 && L.cells.state[i] === CELL.OPEN)
        expect(L.cells.height[i]).toBe(L3.cells.height[i]);
  });

  it("rags the outline, keeps passages two wide and the floor in one piece", () => {
    const n3 = caveNaturalMeasures(level(g3.r));
    const n4 = caveNaturalMeasures(level(g4.r));
    expect(n3.straightShare).toBeGreaterThan(0.3);
    expect(n4.straightShare).toBeLessThan(0.2);
    expect(n4.longest).toBeLessThan(n3.longest);
    expect(openPieces(level(g4.r))).toBe(openPieces(level(g3.r)));
    expect(narrowCells(level(g4.r))).toBeLessThanOrEqual(narrowCells(level(g3.r)));
  });

  it("the notes: generator 4 sees the generator-3 grotto's flat floor, straight walls and hollow rock, and not its own", () => {
    const plan4 = { ...fixture, generator: 4 } as MapPlan;
    const codes3 = caveNaturalChecks(plan4, level(g3.r)).map((n) => n.code);
    expect(codes3).toEqual(["cave_floor_flat", "cave_outline_straight"]);
    expect(caveNaturalChecks(plan4, level(g4.r))).toEqual([]);
    expect(caveNaturalChecks(g3.plan, level(g3.r))).toEqual([]);
    expect(caveHollowNotesOf("l1", m3).map((n) => n.code)).toEqual(["cave_mass_hollow"]);
    expect(caveHollowNotesOf("l1", m4)).toEqual([]);
  });

  it("the mass notes run without a build at generator 4 (the in-app review) and stay off at generator 3", () => {
    const built = caveMassReviewNotes(g4.plan, g4.r, reviewBuild(g4.r, palettes, g4.set), palettes);
    const unbuilt = caveMassReviewNotes(g4.plan, g4.r, reviewBuild(g4.r, palettes), palettes);
    expect(unbuilt).toEqual(built);
    expect(caveMassReviewNotes(g3.plan, g3.r, reviewBuild(g3.r, palettes), palettes)).toEqual([]);
    // the whole review with no build given: the generator-4 grotto is neither hollow, flat nor straight-sided
    const codes = reviewDesign(g4.plan, g4.r, { palettes, limit: 99 }).map((n) => n.code);
    expect(codes).not.toContain("cave_mass_hollow");
    expect(codes).not.toContain("cave_floor_flat");
    expect(codes).not.toContain("cave_outline_straight");
  });
});

describe("generator 4: rectangular cave chambers and a corridor", () => {
  // two rectangular chambers joined by a straight corridor, with a side chamber and a nook
  const plan = (generator: 3 | 4): MapPlan =>
    dungeonPlan({
      generator,
      id: "6b0e2f4c-1d3a-4c5b-9e8f-7a6b5c4d3e2f",
      kind: "cave",
      seed: 991,
      theme: "cave",
      levelId: "l1",
      w: 44,
      h: 34,
      areas: [
        { id: "hall", kind: "cave", name: "Hall", shape: { type: "rect", x: 5, y: 6, w: 14, h: 12 } },
        {
          id: "corridor",
          kind: "cave",
          name: "Corridor",
          shape: { type: "rect", x: 19, y: 10, w: 10, h: 3 },
        },
        { id: "side", kind: "cave", name: "Side chamber", shape: { type: "rect", x: 29, y: 6, w: 9, h: 10 } },
        { id: "nook", kind: "cave", name: "Nook", shape: { type: "rect", x: 10, y: 18, w: 4, h: 9 } },
      ],
      level: { features: [{ id: "statue", type: "statue", at: [11, 11] }] },
    });
  const r3 = resolvePlan(plan(3));
  const r4 = resolvePlan(plan(4));

  it("gives the boxes ragged outlines with every connection and passage width kept", () => {
    const n3 = caveNaturalMeasures(level(r3));
    const n4 = caveNaturalMeasures(level(r4));
    expect(n3.longest).toBeGreaterThanOrEqual(12);
    expect(n4.longest).toBeLessThanOrEqual(8);
    expect(n4.straightShare).toBeLessThan(n3.straightShare / 2);
    expect(openPieces(level(r4))).toBe(1);
    expect(narrowCells(level(r4))).toBe(0);
    // the rock between the chambers and the level edge stays at least two cells
    const L = level(r4);
    const { w, h } = L.bounds;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (L.cells.state[y * w + x] === CELL.OPEN) {
          expect(x).toBeGreaterThanOrEqual(2);
          expect(y).toBeGreaterThanOrEqual(2);
          expect(x).toBeLessThan(w - 2);
          expect(y).toBeLessThan(h - 2);
        }
  });

  it("shelves a floor with no water from the heart of the largest chamber, walkable everywhere", () => {
    const n4 = caveNaturalMeasures(level(r4));
    expect(caveNaturalMeasures(level(r3)).flatShare).toBe(1);
    expect(n4.flatShare).toBeLessThan(0.8);
    const L = level(r4);
    const { w, h } = L.bounds;
    for (let i = 0; i < w * h; i++) {
      if (L.cells.state[i] !== CELL.OPEN) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      for (const [dx, dy] of D4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || L.cells.state[ny * w + nx] !== CELL.OPEN) continue;
        expect(
          Math.abs((L.cells.height[i] as number) - (L.cells.height[ny * w + nx] as number)),
        ).toBeLessThanOrEqual(2);
      }
    }
    // the statue stands on the main floor
    expect(L.cells.height[11 * w + 11]).toBe(0);
    expect(checkPlayability(plan(4), r4).filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("generator 3 keeps the boxes", () => {
    expect(caveNaturalMeasures(level(r3)).straightShare).toBeGreaterThan(0.5);
  });
});
