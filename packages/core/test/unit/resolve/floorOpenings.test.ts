/**
 * Generator 4 floor openings: a collapse reads as a ragged hole, not a
 * ring of 2-tall wall stubs. Collapse: no wall, low debris on the rim, a mound of rubble below. Shaft: a low kerb.
 * Balcony: a railing. Stairs climb the whole rise with no gap. Generator 3 keeps its 2-tall ruined rim.
 */
import { describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import type { MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const palettes = loadPalettes();
const RUINED = "6ac43c67-e43d-455c-826d-e013745bdfbc";
const IRON_BARS = "894cf316-b8c5-4559-923d-7ea4c79280aa";
const LOW_WALL = "4e8c2ded-fd67-4c63-890e-8c655d445d1d";

const keep = (): MapPlan => loadPlan("keep-dungeon-v8");

function withOpening(patch: Partial<Extract<TerrainOp, { op: "floor_opening" }>>, generator: 3 | 4): MapPlan {
  const plan = keep();
  plan.generator = generator;
  const l1 = plan.levels.find((l) => l.id === "l1");
  const op = l1?.terrain.find((t) => t.op === "floor_opening");
  if (!op) throw new Error("fixture changed");
  Object.assign(op, patch);
  return plan;
}

function level(plan: MapPlan, id: string): ResolvedLevel {
  const L = resolvePlan(plan).levels.find((l) => l.id === id);
  if (!L) throw new Error(`no level ${id}`);
  return L;
}

function placementsOf(plan: MapPlan, id: string): Array<{ asset: string; source: { elementId?: string } }> {
  return realize(resolvePlan(plan), palettes, {}).levels.find((l) => l.levelId === id)?.placements ?? [];
}

/** Heights of wall edges that touch a hole cell. */
function rimWallHeights(plan: MapPlan): number[] {
  const L = level(plan, "l1");
  const fo = L.floorOpenings?.[0];
  if (!fo) throw new Error("no opening");
  const hole = new Set(fo.cells.map((c) => `${c[0]},${c[1]}`));
  const w = L.bounds.w;
  const at = (x: number, y: number): boolean => hole.has(`${x + L.bounds.x},${y + L.bounds.y}`);
  const out: number[] = [];
  for (let y = 0; y <= L.bounds.h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (L.hEdges.kind[i] === EDGE.WALL && (at(x, y - 1) || at(x, y)))
        out.push(L.hEdges.height[i] as number);
    }
  for (let y = 0; y < L.bounds.h; y++)
    for (let x = 0; x <= w; x++) {
      const i = y * (w + 1) + x;
      if (L.vEdges.kind[i] === EDGE.WALL && (at(x - 1, y) || at(x, y)))
        out.push(L.vEdges.height[i] as number);
    }
  return out;
}

describe("floor_opening, generator 4", () => {
  it("a collapse has no wall round it and drops low debris on its rim", () => {
    const plan = withOpening({}, 4);
    expect(rimWallHeights(plan)).toHaveLength(0);
    const L = level(plan, "l1");
    const debris = L.features.filter((f) => f.id.startsWith("hall_hole#rim"));
    expect(debris.length).toBeGreaterThanOrEqual(12);
    expect(debris.every((f) => f.type === "debris" && !f.blocking)).toBe(true);
    // none of it lies in the hole
    const hole = new Set((L.floorOpenings?.[0]?.cells ?? []).map((c) => `${c[0]},${c[1]}`));
    expect(debris.some((f) => hole.has(`${f.at[0]},${f.at[1]}`))).toBe(false);
    // and all of it is placed
    const placed = placementsOf(plan, "l1").filter((p) =>
      (p.source.elementId ?? "").startsWith("hall_hole#rim"),
    );
    expect(placed.length).toBe(debris.length);
  });

  it("the heap below mounds, in steps a person can walk; generator 3 stays flat", () => {
    const heightsIn = (plan: MapPlan): { hs: number[]; steps: number[] } => {
      const L1 = level(plan, "l1");
      const L2 = level(plan, "l2");
      const hole = (L1.floorOpenings?.[0]?.cells ?? []).map((c) => [c[0], c[1]] as const);
      const at = (x: number, y: number): number =>
        L2.cells.height[(y - L2.bounds.y) * L2.bounds.w + (x - L2.bounds.x)] as number;
      const inHole = new Set(hole.map((c) => `${c[0]},${c[1]}`));
      const steps: number[] = [];
      for (const [x, y] of hole)
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const)
          if (inHole.has(`${x + dx},${y + dy}`)) steps.push(Math.abs(at(x, y) - at(x + dx, y + dy)));
      return { hs: hole.map(([x, y]) => at(x, y)), steps };
    };
    const g4 = heightsIn(withOpening({}, 4));
    expect(Math.max(...g4.hs) - Math.min(...g4.hs)).toBeGreaterThanOrEqual(4); // a tile from skirt to crown
    expect(Math.max(...g4.steps)).toBeLessThanOrEqual(2); // never more than half a tile between neighbours
    const g3 = heightsIn(withOpening({}, 3));
    expect(Math.max(...g3.hs) - Math.min(...g3.hs)).toBe(0);
  });

  it("a shaft gets a low kerb and a balcony a railing, never the 2-tall wall", () => {
    for (const kind of ["shaft", "balcony"] as const) {
      const plan = withOpening({ kind }, 4);
      const heights = rimWallHeights(plan);
      expect(heights.length).toBeGreaterThan(8);
      expect(heights.every((h) => h <= 1)).toBe(true);
      const pieces = placementsOf(plan, "l1");
      expect(pieces.some((p) => p.asset === RUINED || p.asset === IRON_BARS)).toBe(false);
      const bundle = compileResolved(resolvePlan(plan), palettes, slabCodec, { plan });
      expect(bundle.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
      if (kind === "shaft") expect(pieces.some((p) => p.asset === LOW_WALL)).toBe(true);
    }
  });

  it("generator 3 keeps the 2-tall ruined rim and no rim debris", () => {
    const plan = withOpening({}, 3);
    expect(rimWallHeights(plan).length).toBeGreaterThan(5);
    expect(placementsOf(plan, "l1").some((p) => p.asset === RUINED)).toBe(true);
    expect(level(plan, "l1").features.filter((f) => f.id.startsWith("hall_hole#rim"))).toHaveLength(0);
  });

  it("review: a tall rim round the opening hides it, a low one does not", () => {
    const tall = withOpening({ kind: "shaft", rim: "stone" }, 4);
    const notes = reviewDesign(tall, resolvePlan(tall), { palettes, diagnostics: [] });
    expect(notes.some((n) => n.code === "opening_hidden")).toBe(true);
    const low = withOpening({ kind: "shaft" }, 4);
    const quiet = reviewDesign(low, resolvePlan(low), { palettes, diagnostics: [] });
    expect(quiet.some((n) => n.code === "opening_hidden")).toBe(false);
  });

  it("the stairs climb the whole rise: top step at the upper floor, one tile per step, verify passes", () => {
    const plan = keep();
    const r = resolvePlan(plan);
    const set = realize(r, palettes, {});
    const stairs = r.links.filter((l) => l.kind === "stairs");
    expect(stairs.length).toBeGreaterThan(0);
    for (const lk of stairs) {
      const lower = r.levels.find((l) => l.id === lk.fromLevel);
      const upper = r.levels.find((l) => l.id === lk.toLevel);
      if (!lower || !upper) throw new Error("level missing");
      expect(lk.lowerCells.length).toBe(Math.ceil(lk.rise));
      const placed = set.levels.find((l) => l.levelId === lk.fromLevel)?.placements ?? [];
      const tops = lk.lowerCells.map((c) =>
        Math.max(
          ...placed
            .filter(
              (p) =>
                p.source.elementId === lk.id &&
                p.source.cell?.[0] === c[0] &&
                p.source.cell[1] === c[1] &&
                p.role === "link",
            )
            .map((p) => p.y + 1),
        ),
      );
      expect(tops).toHaveLength(4);
      expect(Math.max(...tops)).toBeCloseTo(upper.elevation + 0.5, 5);
      expect(Math.min(...tops)).toBeCloseTo(lower.elevation + 0.5 + 1, 5);
    }
    const bundle = compileResolved(r, palettes, slabCodec, { plan });
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
