/**
 * Generator 4 shared solid mass and cave plumbing: the mass mechanism the interior shell and the
 * cave rock mass share (gen/solidMass.ts), link cells from `linkGeometry`, one review build, wall heights beside raised
 * floors, and the cave outline's local connectivity test. Rules, not hashes.
 */
import { describe, expect, it, vi } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { CELL, EDGE } from "../../../src/contracts/resolved";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import {
  OWNER,
  dropLumps,
  fillNotches,
  inBlock2x2,
  massDepth,
  massFoot,
  orthNeighbours,
  ownSolid,
  trimTeeth,
} from "../../../src/gen/solidMass";
import { linkCellsOnLevel } from "../../../src/plan/links";
import { raggedCaveOutline, windowKeepsJoined } from "../../../src/resolve/caveOutline";
import { resolvePlan } from "../../../src/resolve/index";
import { areaReferenceHeights, spanCellOf, wallRise } from "../../../src/resolve/wallspan";
import { reviewDesign } from "../../../src/review";
import { reviewBuild } from "../../../src/review/reviewBuild";
import "../../../src/resolve/autoregister";
import * as realizeModule from "../../../src/compile/realize";
import { loadPlan } from "../../fixtures";
import { dungeonPlan } from "../../fixtures/planBuilder";

const fixtureKeep = loadPlan("keep-dungeon-v8");

vi.mock("../../../src/compile/realize", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/compile/realize")>();
  return { ...orig, realize: vi.fn(orig.realize) };
});

const palettes = loadPalettes();
const G = (w: number, h: number): { w: number; h: number } => ({ w, h });

describe("shared mass: depth, foot, ownership", () => {
  // a 9x5 slab of rock with open floor along y = 0 (row 0 is open)
  const g = G(9, 5);
  const solid = (i: number): boolean => i >= 9;

  it("depth counts steps behind the wall; the foot never sits above a shallower neighbour", () => {
    const seeds = Array.from({ length: 9 }, (_, x) => 9 + x);
    const { depth, nearest } = massDepth(g, solid, seeds);
    expect(Array.from(depth.slice(9, 18))).toEqual(Array(9).fill(1));
    expect(depth[4 * 9 + 4]).toBe(4);
    expect(nearest[4 * 9 + 4]).toBe(4);
    // floor beside the wall steps down at x = 5: the rock behind it follows the lowest neighbour
    const own = (i: number): number => (i % 9 < 5 ? 1 : 0.5);
    const foot = massFoot(g, depth, own);
    expect(foot[9 + 6]).toBe(0.5);
    expect(foot[2 * 9 + 5]).toBe(0.5);
    expect(foot[2 * 9 + 4]).toBe(1);
    // a deeper cell is never above any shallower neighbour
    for (let i = 9; i < 45; i++)
      for (const j of orthNeighbours(g, i))
        if (j >= 9 && (depth[j] as number) < (depth[i] as number))
          expect(foot[i] as number).toBeLessThanOrEqual(foot[j] as number);
  });

  it("each solid cell has one owner, the nearest wall's, with no gutter between rock and built", () => {
    // rock wall along the left edge, built wall along the right edge of a 12x3 slab
    const s = G(12, 3);
    const rock = [0, 12, 24];
    const built = [11, 23, 35];
    const owner = ownSolid(s, () => true, rock, built);
    for (let i = 0; i < 36; i++) expect(owner[i]).not.toBe(OWNER.none);
    // no cell is both; they meet where the distances meet, with nothing in between
    const row = Array.from({ length: 12 }, (_, x) => owner[x]);
    expect(row).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    // with no rock seeds nothing is taken from the built side, and the other way round
    expect(Array.from(ownSolid(s, () => true, [], built)).every((o) => o === OWNER.built)).toBe(true);
    expect(Array.from(ownSolid(s, () => true, rock, [])).every((o) => o === OWNER.rock)).toBe(true);
  });

  it("cleanup: teeth, notches, lumps and nubs", () => {
    const s = G(8, 6);
    const idx = (x: number, y: number): number => y * 8 + x;
    const set = new Map<number, number>();
    for (let x = 0; x < 8; x++) set.set(idx(x, 2), 1);
    set.set(idx(3, 1), 2); // a tooth on the wall line
    set.delete(idx(5, 2)); // a notch in the wall line
    trimTeeth(s, set, (_i, r) => r > 1);
    expect(set.has(idx(3, 1))).toBe(false);
    fillNotches(
      s,
      set,
      () => true,
      () => 2,
    );
    expect(set.get(idx(5, 2))).toBe(2);
    set.set(idx(7, 5), 2); // an isolated lump
    dropLumps(s, set, (_i, r) => r === 1, 3);
    expect(set.has(idx(7, 5))).toBe(false);
    expect(set.has(idx(0, 2))).toBe(true);
    expect(inBlock2x2(s, idx(1, 1), (j) => j >= 0 && Math.floor(j / 8) <= 2)).toBe(true);
    expect(inBlock2x2(s, idx(1, 1), (j) => j === idx(1, 1))).toBe(false);
  });
});

describe("link cells", () => {
  const plan = {
    levels: [
      { id: "a", elevation: 0 },
      { id: "b", elevation: 12 },
    ],
    links: [
      {
        id: "s",
        kind: "stairs",
        dir: "E",
        from: { level: "a", at: [10, 5] },
        to: { level: "b", at: [22, 5] },
      },
    ],
  } as unknown as Pick<MapPlan, "levels" | "links">;

  it("covers the whole run on the lower level, whatever its length, and the well and landing above", () => {
    const lower = linkCellsOnLevel(plan, "a");
    expect(lower.length).toBe(12);
    expect(lower[0]).toEqual([10, 5]);
    expect(lower[11]).toEqual([21, 5]);
    const upper = linkCellsOnLevel(plan, "b");
    // the stairwell above the run, and the landing past it
    expect(upper).toContainEqual([10, 5]);
    expect(upper).toContainEqual([22, 5]);
  });

  it("a ragged cave outline keeps every link cell of both ends open (a run longer than eight cells, upper end too)", () => {
    const base = (id: string, elevation: number): unknown => ({
      id,
      name: id,
      elevation,
      bounds: { x: 0, y: 0, w: 44, h: 24 },
      base: { type: "solid" },
      areas: [
        { id: `${id}-hall`, kind: "cave", name: "Hall", shape: { type: "rect", x: 4, y: 4, w: 36, h: 14 } },
      ],
      openings: [],
      walls: [],
      labels: [],
      features: [],
      terrain: [],
    });
    const p = {
      schema: "slabyrinth/plan@1",
      generator: 4,
      id: "link-keep",
      title: "Link keep",
      kind: "cave",
      seed: 17,
      theme: "cave",
      summary: "A long stair between two caves.",
      levels: [base("a", 0), base("b", 12)],
      links: [
        {
          id: "s",
          kind: "stairs",
          dir: "E",
          from: { level: "a", at: [8, 10] },
          to: { level: "b", at: [20, 10] },
        },
      ],
    } as unknown as MapPlan;
    const r = resolvePlan(p, bundledPalettes());
    for (const L of r.levels) {
      const cells = linkCellsOnLevel(p, L.id);
      expect(cells.length).toBeGreaterThan(0);
      for (const [x, y] of cells)
        expect(L.cells.state[(y - L.bounds.y) * L.bounds.w + (x - L.bounds.x)], `${L.id} ${x},${y}`).toBe(
          CELL.OPEN,
        );
    }
  });
});

describe("a level of rooms and a cave (generator 4)", () => {
  const plan = (generator: 3 | 4): MapPlan =>
    dungeonPlan({
      generator,
      id: "mixed-mass",
      seed: 31,
      levelId: "l1",
      w: 56,
      h: 26,
      areas: [
        { id: "hall", kind: "room", name: "Hall", shape: { type: "rect", x: 5, y: 6, w: 12, h: 12 } },
        {
          id: "grotto",
          kind: "cave",
          name: "Grotto",
          theme: "cave",
          shape: { type: "rect", x: 32, y: 5, w: 18, h: 14 },
        },
      ],
    });

  it("never dresses a solid cell twice and leaves no gutter between cap and rock", () => {
    const set = realizeModule.realize(resolvePlan(plan(4), bundledPalettes()), palettes, {});
    const level = set.levels[0];
    const shell = new Set<string>();
    const rock = new Set<string>();
    for (const q of level?.placements ?? []) {
      const id = q.source.elementId;
      if (!q.source.cell) continue;
      if (id === "shell") shell.add(`${q.source.cell[0]},${q.source.cell[1]}`);
      if (id === "cave_mass" || id === "cave_cap") rock.add(`${q.source.cell[0]},${q.source.cell[1]}`);
    }
    // (a piece is keyed by the cell it starts in; a piece may reach over a neighbour, so only starting cells are compared)
    expect(shell.size).toBeGreaterThan(0);
    expect(rock.size).toBeGreaterThan(0);
    for (const k of shell) expect(rock.has(k), `cell ${k} is dressed by both`).toBe(false);
  });
});

describe("cave outline: local connectivity test", () => {
  it("when the window says a cell can go, closing it never changes the number of floor pieces", () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const N = 7;
    const pieces = (open: Uint8Array): number => {
      const seen = new Uint8Array(N * N);
      let n = 0;
      for (let s = 0; s < N * N; s++) {
        if (seen[s] || !open[s]) continue;
        n++;
        const st = [s];
        seen[s] = 1;
        while (st.length > 0) {
          const c = st.pop() as number;
          const x = c % N;
          const y = (c - x) / N;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            const j = ny * N + nx;
            if (open[j] && !seen[j]) {
              seen[j] = 1;
              st.push(j);
            }
          }
        }
      }
      return n;
    };
    let conclusive = 0;
    for (let t = 0; t < 4000; t++) {
      const open = new Uint8Array(N * N);
      for (let i = 0; i < N * N; i++) open[i] = rnd() < 0.55 ? 1 : 0;
      const c = 3 * N + 3;
      open[c] = 1;
      const joined = windowKeepsJoined((dx, dy) => open[(3 + dy) * N + 3 + dx] === 1);
      if (!joined) continue;
      conclusive++;
      const before = pieces(open);
      open[c] = 0;
      expect(pieces(open)).toBe(before);
    }
    expect(conclusive).toBeGreaterThan(500);
  });

  it("outlines a 160x160 cave with long walls in work linear in its cells, not a flood per cell", () => {
    const W = 160;
    const open = new Uint8Array(W * W);
    const owner = new Int32Array(W * W);
    const area = (k: number, x0: number, y0: number, w: number, h: number): number[] => {
      const out: number[] = [];
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) {
          open[y * W + x] = 1;
          owner[y * W + x] = k;
          out.push(y * W + x);
        }
      return out;
    };
    const a = area(1, 10, 10, 60, 60);
    const b = area(2, 90, 10, 60, 60);
    const c = area(3, 10, 90, 140, 60);
    area(4, 70, 30, 20, 4);
    area(5, 30, 70, 4, 20);
    // work is counted as reads of the grid, which is deterministic (a wall-clock limit is not)
    let reads = 0;
    for (const [k, cells] of [
      [1, a],
      [2, b],
      [3, c],
    ] as const) {
      const r = raggedCaveOutline(
        {
          w: W,
          h: W,
          owner: (i) => (reads++, owner[i] as number),
          open: (i) => (reads++, open[i] === 1),
          rock: (i) => (reads++, open[i] === 0),
          keep: () => (reads++, false),
        },
        k,
        cells,
        99 + k,
      );
      expect(r.open.length + r.close.length).toBeGreaterThan(0);
    }
    const cells = a.length + b.length + c.length;
    // about 80 reads per cell today; a flood fill per wall cell (what the local window test replaced) needs tens of
    // millions here, so the budget leaves room for change but not for that
    expect(reads).toBeLessThan(200 * cells);
  });
});

describe("one build per review run", () => {
  const house = {
    id: "h0",
    style: "cottage",
    seed: 20,
    wings: [{ x: 3, y: 4, w: 7, h: 6 }],
    chimneys: [{ side: "E", position: 0.5 }],
    front: "S",
  };
  const plan = (generator: 3 | 4): MapPlan =>
    ({
      schema: "slabyrinth/plan@1",
      generator,
      id: "review-build",
      title: "review build",
      kind: "mixed",
      seed: 4,
      theme: "wood_town",
      links: [],
      levels: [
        {
          id: "g",
          name: "g",
          elevation: 0,
          bounds: { x: 0, y: 0, w: 30, h: 16 },
          base: { type: "ground", material: "grass" },
          areas: [{ id: "lot", kind: "zone", shape: { type: "rect", x: 0, y: 0, w: 30, h: 16 } }],
          openings: [],
          walls: [],
          features: [],
          terrain: [],
          labels: [],
          structures: [house],
        },
        {
          id: "c",
          name: "c",
          elevation: -8,
          theme: "cave",
          bounds: { x: 0, y: 0, w: 40, h: 30 },
          base: { type: "solid" },
          areas: [
            { id: "hall", kind: "cave", name: "Hall", shape: { type: "rect", x: 6, y: 6, w: 20, h: 14 } },
            { id: "side", kind: "cave", name: "Side", shape: { type: "rect", x: 26, y: 10, w: 8, h: 6 } },
          ],
          openings: [],
          walls: [],
          labels: [],
          features: [],
          terrain: [],
        },
      ],
    }) as unknown as MapPlan;

  const realized = (): number => vi.mocked(realizeModule.realize).mock.calls.length;

  it("a generator 4 review whose cave and roof notes both need the pieces builds them once", () => {
    const p = plan(4);
    const r = resolvePlan(p, bundledPalettes());
    const before = realized();
    reviewDesign(p, r, palettes, { limit: 99 });
    expect(realized() - before).toBe(1);
  });

  it("a review that is given the build, or has nothing to measure, builds nothing", () => {
    const p = plan(4);
    const r = resolvePlan(p, bundledPalettes());
    const set = realizeModule.realize(r, palettes, {});
    const before = realized();
    reviewDesign(p, r, palettes, { limit: 99, placements: set });
    expect(realized() - before).toBe(0);
    // generator 3 keeps its released behaviour: no build, no mass or roof notes
    const p3 = plan(3);
    const r3 = resolvePlan(p3, bundledPalettes());
    const b3 = realized();
    reviewDesign(p3, r3, palettes, { limit: 99 });
    expect(realized() - b3).toBe(0);
  });

  it("the build object builds on the first ask only", () => {
    const r = resolvePlan(plan(4), bundledPalettes());
    const b = reviewBuild(r, palettes);
    expect(b.given).toBe(false);
    expect(b.built).toBe(0);
    const s1 = b.get();
    const s2 = b.get();
    expect(s2).toBe(s1);
    expect(b.built).toBe(1);
  });
});

describe("wall heights beside raised floors", () => {
  it("no wall of a built interior reaches more than the wall height above its lower floor", () => {
    const p = { ...fixtureKeep, generator: 4 } as MapPlan;
    const r = resolvePlan(p, bundledPalettes());
    let checked = 0;
    for (const L of r.levels) {
      if (L.cells.state.every((s) => s !== CELL.SOLID)) continue;
      const ref = areaReferenceHeights(L);
      const cellAt = spanCellOf(L);
      const { w, h } = L.bounds;
      for (const orient of ["h", "v"] as const) {
        const grid = orient === "h" ? L.hEdges : L.vEdges;
        const lines = orient === "h" ? h + 1 : w + 1;
        const along = orient === "h" ? w : h;
        for (let line = 0; line < lines; line++)
          for (let pos = 0; pos < along; pos++) {
            const idx = orient === "h" ? line * w + pos : pos * (w + 1) + line;
            if (grid.kind[idx] !== EDGE.WALL) continue;
            const h0 = (grid.height[idx] ?? 0) > 0 ? (grid.height[idx] as number) : 2;
            const a = orient === "h" ? cellAt(pos, line - 1) : cellAt(line - 1, pos);
            const b = orient === "h" ? cellAt(pos, line) : cellAt(line, pos);
            const rise = wallRise(L.elevation, a, b, (grid.host[idx] ?? 1) === 0, h0, ref);
            if (rise > 0 && rise <= 0.5 + 1e-6) {
              checked++;
              // the settled edge: its span from the lower floor is its own height, 2.5 at most
              expect(h0 + rise).toBeLessThanOrEqual(2.5 + 1e-6);
            }
          }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
