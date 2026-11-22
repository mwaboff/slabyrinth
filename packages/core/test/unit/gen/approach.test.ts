/**
 * Terrain round 4 (2026-11-19): generated dressing keeps every route open. On the hillside proof a dense-forest
 * pine stood on the only cell-wide way across the plateau between the head of the tower walkway and the top of
 * the stairs, so the tower and its walkway could not be reached. The composer's reachability guard ignored height
 * (it walked down the plateau's lower rim and back up) and started from an arbitrary cell; it now walks the way a
 * player does (no step over half a tile unless it is a flight of steps) and floods from the approach to a walkway,
 * bridge or flight of steps, which also keeps two cells clear in front of them.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan, Side } from "../../../src/contracts/plan";
import {
  COMPOSED_PRESETS,
  FEATURE_INFO,
  dressArea,
  type ComposedPreset,
  type PlacementGrid,
} from "../../../src/gen/index";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures";
import { BUNDLED_RULES } from "../../fixtures/rules";
import { validatePlan } from "../../../src/plan";

// A plateau (3 tiles up) with a low rim (2 up) along its north and south edges, split by a rock barrier at
// x = 8 that leaves one cell-wide gap at (8, 1). Stairs arrive at its west end, a walkway at its east end.
const W = 16;
const H = 8;
const STAIRS: [number, number] = [0, 3];
const WALKWAY: [number, number] = [15, 3];
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
const isLink = (x: number, y: number): boolean =>
  (x === STAIRS[0] && y === STAIRS[1]) || (x === WALKWAY[0] && y === WALKWAY[1]);
const height = (x: number, y: number): number => (y === 0 || y === H - 1 ? 2 : 3);
const barrier = (x: number, y: number): boolean => x === 8 && y >= 2 && y <= H - 2;

function plateau(): PlacementGrid {
  return {
    inBounds: inB,
    isFloor: (x, y) => inB(x, y) && !isLink(x, y),
    flags: (x, y) =>
      x === STAIRS[0] && y === STAIRS[1] ? 128 : x === WALKWAY[0] && y === WALKWAY[1] ? 64 : 0,
    area: (x, y) => (inB(x, y) ? (isLink(x, y) ? 2 : 1) : 0),
    occupied: barrier,
    edge: (x, y, s: Side) => {
      const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
      const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
      return inB(nx, ny) && height(nx, ny) !== height(x, y) ? 3 : 0;
    },
    height,
  };
}

function walkable(blocked: Set<string>): boolean {
  const start = `${String(STAIRS[0] + 1)},${String(STAIRS[1])}`;
  const goal = `${String(WALKWAY[0] - 1)},${String(WALKWAY[1])}`;
  if (blocked.has(start) || blocked.has(goal)) return false;
  const seen = new Set([start]);
  const q: Array<[number, number]> = [[STAIRS[0] + 1, STAIRS[1]]];
  while (q.length) {
    const [x, y] = q.pop() as [number, number];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const k = `${String(nx)},${String(ny)}`;
      if (!inB(nx, ny) || isLink(nx, ny) || barrier(nx, ny) || seen.has(k) || blocked.has(k)) continue;
      if (Math.abs(height(nx, ny) - height(x, y)) > 0.5) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen.has(goal);
}

describe("dressing keeps routes open", () => {
  // the barrier's cells belong to the area (as a resolver's area cells do); they are already occupied
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isLink(x, y)) cells.push([x, y]);

  for (const preset of ["dense_forest", "forest", "natural_clusters", "woodland"] as ComposedPreset[])
    it(`${preset}: never cuts the only cell-wide way between the stairs and the walkway`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const ps = dressArea(plateau(), {
          preset,
          areaIndex: 1,
          areaCells: cells,
          density: 1,
          seed,
          remaining: 6000,
        }).placements;
        const blocked = new Set<string>();
        for (const p of ps) {
          const info = FEATURE_INFO[p.type];
          if (!info.blocking || info.wallMounted) continue;
          for (let y = p.at[1]; y < p.at[1] + p.size[1]; y++)
            for (let x = p.at[0]; x < p.at[0] + p.size[0]; x++) blocked.add(`${String(x)},${String(y)}`);
        }
        expect(walkable(blocked), `seed ${String(seed)}`).toBe(true);
        // the approach cells in front of the stairs and the walkway stay clear of blocking pieces
        expect(blocked.has(`${String(STAIRS[0] + 1)},${String(STAIRS[1])}`)).toBe(false);
        expect(blocked.has(`${String(WALKWAY[0] - 1)},${String(WALKWAY[1])}`)).toBe(false);
      }
    });

  it("the hillside proof: the tower walkway and the tower are reachable under dense forest", () => {
    const plan = loadPlan("hillside-v5");
    for (const L of plan.levels)
      for (const t of L.terrain)
        if (t.op === "dress" && t.id === "plateau_dress") {
          t.preset = "dense_forest";
          t.density = 1;
        }
    const issues = validatePlan(plan, BUNDLED_RULES).issues.filter(
      (i) => i.code === "unreachable" || i.code === "area_sealed" || i.code === "opening_blocked",
    );
    expect(issues.map((i) => i.message)).toEqual([]);
  });
});

describe("dressing stays off building ground (ResolvedLevel.reserved)", () => {
  const shackPlan = (preset: string): MapPlan =>
    ({
      schema: "slabyrinth/plan@1",
      generator: 2,
      id: "reserved",
      title: "reserved",
      kind: "outdoor",
      seed: 11,
      theme: "forest",
      links: [],
      levels: [
        {
          id: "g",
          name: "g",
          elevation: 0,
          bounds: { x: 0, y: 0, w: 24, h: 20 },
          base: { type: "ground", material: "grass" },
          areas: [{ id: "woods", kind: "zone", shape: { type: "rect", x: 0, y: 0, w: 24, h: 20 } }],
          openings: [],
          walls: [],
          features: [],
          terrain: [{ id: "d", op: "dress", area: "woods", preset, density: 1 }],
          labels: [],
          structures: [
            {
              id: "shack",
              name: "Shack",
              wings: [{ x: 8, y: 6, w: 6, h: 4 }],
              openings: [{ kind: "door", side: "S", position: 0.5 }],
              chimneys: [{ side: "W" }],
              attachments: [{ type: "porch", side: "S", width: 4, depth: 2 }],
            },
          ],
        },
      ],
    }) as unknown as MapPlan;

  for (const preset of COMPOSED_PRESETS)
    it(`${preset}: no generated piece on a reserved cell`, () => {
      const L = resolvePlan(shackPlan(preset), bundledPalettes()).levels[0];
      if (!L) throw new Error("no level");
      const reserved = new Set(L.reserved ?? []);
      expect(reserved.size).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const f of L.features) {
        if (f.generatedBy !== "d") continue;
        for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
          for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++)
            if (reserved.has((y - L.bounds.y) * L.bounds.w + (x - L.bounds.x)))
              bad.push(`${f.type} ${String(x)},${String(y)}`);
      }
      expect(bad).toEqual([]);
    });
});
