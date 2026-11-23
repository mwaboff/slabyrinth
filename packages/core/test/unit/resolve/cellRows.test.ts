/**
 * Cell rows (generator 5, switch cellRows; technique int-cell-row): a long room of a kind with a cell row in the
 * room-kind table is lined with like cells, partitions inside the one room, a shared front with a doorway in each; every
 * cell is reached, holds its kit or (one in four at most) stands empty; the fronts and the plain option vary by seed.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { CELL, EDGE, type ResolvedPlan } from "../../../src/contracts/resolved";
import { CELL_ROWS } from "../../../src/gen/roomTraits";
import { bundledPalettes } from "../../../src/palette";
import { WalkGraph, resolvePlan } from "../../../src/resolve";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();
const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);

/** A room 16 x 9 entered from a passage along its east end. */
const block = (name: string, generator: 4 | 5, seed: number): MapPlan =>
  dungeonPlan({
    generator,
    seed,
    w: 22,
    h: 12,
    areas: [
      { id: "room", kind: "room", name, shape: { type: "rect", x: 1, y: 1, w: 16, h: 9 } },
      { id: "pass", kind: "corridor", name: "Passage", shape: { type: "rect", x: 17, y: 1, w: 2, h: 9 } },
    ],
    openings: [{ id: "door", kind: "door", between: ["room", "pass"] }],
  });

/** Walls standing between two cells of the room (its partitions and fronts). */
function innerWalls(r: ResolvedPlan): number {
  const L = r.levels[0];
  if (!L) return 0;
  const ai = L.areas.findIndex((a) => a.id === "room") + 1;
  const W = L.bounds.w;
  let n = 0;
  for (let i = 0; i < L.cells.area.length; i++) {
    if (L.cells.area[i] !== ai) continue;
    const east = i + 1;
    const south = i + W;
    const v = (i % W) + 1 + Math.floor(i / W) * (W + 1);
    const h = i + W;
    if ((i % W) + 1 < W && L.cells.area[east] === ai && L.vEdges.kind[v] === EDGE.WALL) n++;
    if (south < L.cells.area.length && L.cells.area[south] === ai && L.hEdges.kind[h] === EDGE.WALL) n++;
  }
  return n;
}

describe("cell rows (cellRows)", () => {
  it("every kind's row keeps an aisle and a cell at least two wide", () => {
    for (const spec of Object.values(CELL_ROWS)) {
      expect(spec.width[0]).toBeGreaterThanOrEqual(2);
      expect(spec.minAcross - spec.depth[1]).toBeGreaterThanOrEqual(spec.aisle);
    }
  });

  it("a cell block is lined with cells: reached, each with its kit or empty (one in four at most)", () => {
    const fronts = new Set<string>();
    let plain = 0;
    for (const seed of SEEDS) {
      const r = resolvePlan(block("Cell block", 5, seed), pal);
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      const L = r.levels[0];
      if (!L) throw new Error("no level");
      const doors = L.openings.filter((o) => o.id.startsWith("room~cell"));
      if (doors.length === 0) {
        plain++;
        expect(innerWalls(r)).toBe(0);
        continue;
      }
      expect(innerWalls(r)).toBeGreaterThan(doors.length);
      // the front: iron bars, or the theme's wall
      fronts.add(L.wallStyles.includes("iron_bars") ? "bars" : "wall");
      // every floor cell of the room is walked to from the passage
      const g = new WalkGraph(r);
      const d0 = g.byId.get(L.id);
      if (!d0) throw new Error("no walk level");
      const start = g.idx(d0, 17, 4);
      const reached = g.flood([[d0.li, start]], { secret: false, ignoreFeatures: true })[d0.li];
      const ai = L.areas.findIndex((a) => a.id === "room") + 1;
      L.cells.area.forEach((a, i) => {
        if (a === ai && L.cells.state[i] === CELL.OPEN)
          expect(reached?.[i], `seed ${seed} cell ${i}`).toBe(1);
      });
      const kitted = doors.filter((d) => {
        const k = d.id.slice("room~cell".length);
        return L.features.some((f) => f.generatedBy === `room~cell${k}` && f.type === "bed");
      }).length;
      expect(doors.length - kitted, `seed ${seed}`).toBeLessThanOrEqual(Math.floor(doors.length / 4) + 1);
    }
    expect(plain).toBeGreaterThan(0);
    expect(plain).toBeLessThan(SEEDS.length / 2);
    expect(fronts.size).toBeGreaterThanOrEqual(2);
  });

  it("without the switch (generator 4) the room is one open room", () => {
    const r = resolvePlan(block("Cell block", 4, 1), pal);
    expect(innerWalls(r)).toBe(0);
  });

  it("a stable's stalls and a ward's bays are laid too; a kitchen never", () => {
    // (the first seed that lays a row settles it: a stable or ward is laid at a chance of 0.6 or more a room)
    const laid = (name: string, seeds: readonly number[]): boolean =>
      seeds.some((seed) => innerWalls(resolvePlan(block(name, 5, seed), pal)) > 0);
    expect(laid("Stable", SEEDS)).toBe(true);
    expect(laid("Infirmary ward", SEEDS)).toBe(true);
    expect(laid("Kitchen", SEEDS.slice(0, 6))).toBe(false);
  });
});
