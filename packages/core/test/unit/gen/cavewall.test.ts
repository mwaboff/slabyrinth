/**
 * Generator 3 cave walls (gen/cavewall.ts): the whole solid band closed with overlapping rock of one family, towers
 * rising away from the floor, a flat cap over the far part, columns only as fill, foot stones in front. Planning is
 * tested on synthetic rock; the whole build on a sea cave (fixtures/sea-grotto.json) against the same plan at
 * generator 2; the four design-review measures (review/caveMass.ts) on a hand-made copy of the first generator-3 try
 * (a palisade of posts with a thin ring of separate lumps outside, three tones) and on what the planner builds.
 */
import { describe, expect, it } from "vitest";
import { CELL } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { planCaveWall, type WallFace, type WallShape, type CaveWallPlan } from "../../../src/gen/cavewall";
import { loadPalettes } from "../../../src/palette";
import {
  caveMassNotesOf,
  massInputOf,
  massMeasures,
  massPiecesOf,
  type MassInput,
  type MassPiece,
  type MassRole,
} from "../../../src/review/caveMass";
import { caveWallChecks, caveWallThickness } from "../../../src/review/caveWall";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";
import { loadPlan } from "../../fixtures";

const D4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const W = 52;
const H = 42;
const OPEN = { x0: 12, y0: 12, x1: 40, y1: 30 };
const SHAPES: WallShape[] = [
  { id: 0, family: "A", w: 2, d: 2, h: 2 },
  { id: 1, family: "A", w: 2, d: 2, h: 2 },
  { id: 2, family: "A", w: 2, d: 2, h: 2.5, weight: 0.8 },
  { id: 3, family: "A", w: 2, d: 1, h: 2, weight: 0.8 },
  { id: 4, family: "A", w: 1, d: 2, h: 1, weight: 0.5 },
  { id: 5, family: "A", w: 1, d: 1, h: 2, weight: 0.3 },
  { id: 6, family: "cap", w: 2, d: 2, h: 0.5 },
  { id: 7, family: "cap", w: 1, d: 2, h: 0.5, weight: 0.6 },
  { id: 8, family: "cap", w: 1, d: 1, h: 0.5, weight: 0.6 },
  { id: 9, family: "toe", w: 1, d: 2, h: 1 },
];

function scene(
  isOpen: (x: number, y: number) => boolean = (x, y) =>
    x >= OPEN.x0 && x < OPEN.x1 && y >= OPEN.y0 && y < OPEN.y1,
) {
  const inLevel = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const rock = (x: number, y: number): boolean => inLevel(x, y) && !isOpen(x, y);
  const faces: WallFace[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (rock(x, y) && D4.some(([dx, dy]) => isOpen(x + dx, y + dy)))
        faces.push({ x, y, base: -3.5, top: 2.5 });
  const input = (seed: number) => ({
    seed,
    faces,
    bounds: { x: 0, y: 0, w: W, h: H },
    rock,
    open: isOpen,
    toeOk: isOpen,
    floorTop: () => 0.5,
    shapes: SHAPES,
    ceiling: Infinity,
  });
  const state = (x: number, y: number): number =>
    !inLevel(x, y) ? -1 : isOpen(x, y) ? CELL.OPEN : CELL.SOLID;
  return { faces, rock, open: isOpen, input, state };
}

const corners = (
  cx: number,
  cy: number,
  rot: number,
  w: number,
  d: number,
): Array<readonly [number, number]> => {
  const a = (rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return (
    [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ] as const
  ).map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c] as const);
};

/** Planner output as measure pieces (one tone family; the columns left as fill stand where the plan says). */
function asPieces(plan: CaveWallPlan): MassPiece[] {
  const out: MassPiece[] = [];
  for (const p of plan.pieces) {
    const s = SHAPES[p.shape] as WallShape;
    const role: MassRole = p.family === "toe" ? "toe" : p.family === "cap" ? "cap" : "mass";
    out.push({
      poly: corners(p.cx, p.cy, p.rot, s.w, s.d),
      base: p.base,
      top: p.base + s.h,
      asset: `shape${s.id}`,
      rot: p.rot % (s.w === s.d ? 90 : 180),
      family: "cavern",
      role,
    });
  }
  for (const k of plan.columns) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    out.push({
      poly: corners(x + 0.5, y + 0.5, 0, 1, 1),
      base: -3.5,
      top: 2.5,
      asset: "post",
      rot: 0,
      family: "cavern",
      role: "column",
    });
  }
  return out;
}

const input = (sc: ReturnType<typeof scene>, pieces: MassPiece[]): MassInput => ({
  w: W,
  h: H,
  x0: 0,
  y0: 0,
  state: sc.state,
  pieces,
});

/**
 * The first generator-3 try, as measured on the owner's proof: a post on every face cell (one asset, one turn), a thin
 * ring of separate lumps of three tones standing a few cells out, and nothing behind them.
 */
function firstTry(sc: ReturnType<typeof scene>): MassPiece[] {
  const out: MassPiece[] = [];
  for (const f of sc.faces)
    out.push({
      poly: corners(f.x + 0.5, f.y + 0.5, 0, 1, 1),
      base: -3.5,
      top: 2.5,
      asset: "post",
      rot: 0,
      family: "cavern",
      role: "column",
    });
  const fams = ["flowstone", "stalagmite", "grey_rock"];
  let i = 0;
  for (const f of sc.faces) {
    if ((f.x * 7 + f.y * 3) % 3 !== 0) continue;
    // 1.5 cells further out from the floor (the nearest open neighbour's side)
    const open = D4.find(([dx, dy]) => sc.open(f.x + dx, f.y + dy));
    if (!open) continue;
    const cx = f.x + 0.5 - open[0] * 1.6;
    const cy = f.y + 0.5 - open[1] * 1.6;
    out.push({
      poly: corners(cx, cy, (i * 30) % 90, 1.3, 1.8),
      base: 0,
      top: 2.5,
      asset: `lump${i % 3}`,
      rot: (i * 30) % 180,
      family: fams[i % 3] as string,
      role: "mass",
    });
    i++;
  }
  return out;
}

describe("cave wall mass: planning", () => {
  const sc = scene();
  const plan = planCaveWall(sc.input(9));
  const mass = plan.pieces.filter((p) => p.family === "A");

  it("covers the solid band, not a thin ring: under 8% of the solid cells show no rock from above", () => {
    const m = massMeasures(input(sc, asPieces(plan)));
    expect(m.solidCells).toBeGreaterThan(1000);
    expect(m.uncovered).toBeLessThan(0.08);
  });

  it("keeps neighbouring pieces touching along the wall, and leaves no long row of identical pieces", () => {
    const m = massMeasures(input(sc, asPieces(plan)));
    expect(m.separated).toBeLessThan(0.25);
    expect(m.longestRun).toBeLessThanOrEqual(3);
    for (const seed of [1, 2, 3]) {
      const q = massMeasures(input(sc, asPieces(planCaveWall(sc.input(seed)))));
      expect(q.separated, `seed ${seed}`).toBeLessThan(0.25);
      expect(q.uncovered, `seed ${seed}`).toBeLessThan(0.08);
      expect(q.longestRun, `seed ${seed}`).toBeLessThanOrEqual(3);
    }
  });

  it("closes the face with mass, leaving columns only as fill", () => {
    expect(plan.columns.size).toBeLessThan(sc.faces.length * 0.2);
  });

  it("is turned in 15 degree steps, in several shapes, and taller the deeper (a plateau flat cap beyond)", () => {
    expect(new Set(mass.map((p) => p.rot)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(mass.map((p) => p.shape)).size).toBeGreaterThanOrEqual(4);
    for (const p of plan.pieces) expect(p.rot % 15).toBe(0);
    const top = (p: (typeof mass)[number]): number => p.base + (SHAPES[p.shape] as WallShape).h;
    const mean = (v: number[]): number => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
    const by = (lo: number, hi: number): number[] => {
      const out: number[] = [];
      for (const p of mass) {
        const d = Math.min(
          Math.abs(p.cx - OPEN.x0),
          Math.abs(p.cx - OPEN.x1),
          Math.abs(p.cy - OPEN.y0),
          Math.abs(p.cy - OPEN.y1),
        );
        if (d >= lo && d < hi) out.push(top(p));
      }
      return out;
    };
    expect(mean(by(2.5, 5))).toBeGreaterThan(mean(by(0, 1.5)));
    expect(mass.some((p) => p.course >= 1)).toBe(true);
    const caps = plan.pieces.filter((p) => p.family === "cap");
    expect(caps.length).toBeGreaterThan(20);
    // the cap is one plateau (to a quarter tile) over this flat floor
    expect(new Set(caps.map((p) => p.base + (SHAPES[p.shape] as WallShape).h)).size).toBe(1);
  });

  it("stands only in solid cells inside the level: no piece reaches an open cell or the board edge", () => {
    for (const p of plan.pieces.filter((q) => q.family !== "toe")) {
      const s = SHAPES[p.shape] as WallShape;
      for (const [x, y] of corners(p.cx, p.cy, p.rot, s.w, s.d)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(W);
        expect(y).toBeLessThanOrEqual(H);
        expect(sc.open(Math.floor(x), Math.floor(y))).toBe(false);
      }
    }
  });

  it("lays low stones on the floor against the wall, never into a passage three wide", () => {
    const toes = plan.pieces.filter((p) => p.family === "toe");
    expect(toes.length).toBeGreaterThan(0);
    for (const p of toes) expect(sc.open(Math.floor(p.cx), Math.floor(p.cy))).toBe(true);
    const narrow = scene((x, y) => x >= 12 && x < 15 && y >= 12 && y < 30);
    for (const p of planCaveWall(narrow.input(3)).pieces.filter((q) => q.family === "toe"))
      expect(p.cy < 14 || p.cy > 28).toBe(true);
  });

  it("keeps under a ceiling and is deterministic", () => {
    const low = planCaveWall({ ...sc.input(9), ceiling: 3 });
    for (const p of low.pieces)
      if (p.family === "A") expect(p.base + (SHAPES[p.shape] as WallShape).h).toBeLessThanOrEqual(3);
    expect(planCaveWall(sc.input(9))).toEqual(plan);
  });
});

describe("cave wall review measures: the first try fails them, the planner passes", () => {
  const sc = scene();
  const bad = massMeasures(input(sc, firstTry(sc)));
  const good = massMeasures(input(sc, asPieces(planCaveWall(sc.input(9)))));
  const codes = (m: typeof bad): string[] =>
    caveMassNotesOf("l1", m)
      .map((n) => n.code)
      .sort();

  it("flags the posts and the lumps", () => {
    expect(bad.uncovered).toBeGreaterThan(0.5); // cave_rock_uncovered
    expect(bad.separated).toBeGreaterThan(0.5); // cave_mass_gaps
    expect(bad.families.length).toBeGreaterThanOrEqual(3); // cave_rock_tones
    expect(bad.longestRun).toBeGreaterThan(3); // cave_wall_row
    expect(codes(bad)).toEqual(["cave_mass_gaps", "cave_rock_tones", "cave_rock_uncovered", "cave_wall_row"]);
  });

  it("says nothing about the planned wall", () => {
    expect(codes(good)).toEqual([]);
  });
});

describe("cave wall mass: the whole build on a sea cave", () => {
  const fixture = loadPlan("sea-grotto");
  const palettes = loadPalettes();
  const build = (generator: 2 | 3) => {
    const plan = { ...fixture, generator };
    const r = resolvePlan(plan);
    const set = realize(r, palettes, {});
    set.diagnostics.push(...verifyBuild(r, set, palettes, { plan }).diagnostics);
    return { r, set };
  };
  const g2 = build(2);
  const g3 = build(3);
  const total = (s: typeof g3.set): number => s.levels.reduce((n, l) => n + l.placements.length, 0);

  it("generator 2 stays one column asset; generator 3 builds the mass from one rock family", () => {
    const wall2 = g2.set.levels
      .flatMap((l) => l.placements)
      .filter((p) => p.source.elementId === "wall.cave_rock");
    expect(new Set(wall2.map((p) => p.asset)).size).toBe(1);
    const L = g3.r.levels[0];
    if (!L) throw new Error("no level");
    const pieces = massPiecesOf(g3.set, g3.r, palettes, L.id);
    const m = massMeasures(massInputOf(L, pieces));
    expect(m.families).toEqual(["cavern"]);
    expect(m.mass).toBeGreaterThan(50);
    expect(new Set(pieces.filter((p) => p.role === "mass").map((p) => p.rot)).size).toBeGreaterThanOrEqual(6);
  });

  it("covers the solid rock and keeps the pieces touching", () => {
    const L = g3.r.levels[0];
    if (!L) throw new Error("no level");
    const m = massMeasures(massInputOf(L, massPiecesOf(g3.set, g3.r, palettes, L.id)));
    expect(m.uncovered).toBeLessThan(0.08);
    expect(m.separated).toBeLessThan(0.25);
    expect(m.longestRun).toBeLessThanOrEqual(3);
  });

  it("keeps the asset count sane, and verify raises no wall, cell or support warning", () => {
    expect(total(g3.set)).toBeLessThanOrEqual(total(g2.set) * 1.6);
    const bad = g3.set.diagnostics.filter((d) =>
      /verify_cell_obstructed|verify_prop_in_wall|verify_prop_no_floor|verify_prop_outside|verify_prop_sunk|verify_prop_floating|verify_wall_gap/.test(
        d.code,
      ),
    );
    expect(bad.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it("builds only in solid cells: no mass piece is anchored over a cell the map shows open", () => {
    const open = new Set<string>();
    for (const L of g3.r.levels)
      for (let y = 0; y < L.bounds.h; y++)
        for (let x = 0; x < L.bounds.w; x++)
          if (L.cells.state[y * L.bounds.w + x] === 2) open.add(`${x + L.bounds.x},${y + L.bounds.y}`);
    for (const p of g3.set.levels.flatMap((l) => l.placements)) {
      if (p.source.elementId !== "cave_mass" && p.source.elementId !== "cave_cap") continue;
      const c = p.source.cell;
      if (c) expect(open.has(`${c[0]},${c[1]}`)).toBe(false);
    }
  });
});

describe("cave wall review note (thin rock)", () => {
  const fixture = loadPlan("sea-grotto");
  it("measures wall thickness from the resolved level and fires only on thin walls at generator 3", () => {
    const r = resolvePlan(fixture);
    const L = r.levels[0];
    if (!L) throw new Error("no level");
    expect(caveWallThickness(L).length).toBeGreaterThan(20);
    expect(caveWallChecks(fixture, L)).toHaveLength(0);
    // open every other solid column: what is left is one cell of rock between neighbouring floors
    const w = L.bounds.w;
    const state = [...L.cells.state];
    for (let i = 0; i < state.length; i++) if (state[i] === 1 && (i % w) % 2 === 0) state[i] = 2;
    const thin = { ...L, cells: { ...L.cells, state } };
    expect(caveWallChecks(fixture, thin).map((n) => n.code)).toEqual(["cave_wall_thin"]);
    expect(caveWallChecks({ ...fixture, generator: 2 }, thin)).toHaveLength(0);
  });
});
