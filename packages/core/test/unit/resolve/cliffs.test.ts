/**
 * Cliffs after the reference study (docs/internal/cliffs-lessons-reference.md): cliff runs on the resolved level,
 * bold defaults for natural hills, the natural board outline with a low apron, rock ramps, and the review's cliff
 * checks (each fires on a bad fixture and stays silent on a good one).
 */
import { describe, expect, it } from "vitest";
import type { Feature, Level, MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { CELL, CELL_FLAG, type ResolvedLevel } from "../../../src/contracts/resolved";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { compileResolved, realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { slabCodec } from "../../../src/slab";

const W = 40;
const H = 30;
function meadow(terrain: TerrainOp[], extra: Partial<Level> = {}, generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "cl",
    title: "Cliffs",
    kind: "outdoor",
    theme: "outdoor",
    seed: 9,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: W, h: H },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
        ...extra,
      },
    ],
  };
}
const L0 = (p: MapPlan): ResolvedLevel => resolvePlan(p).levels[0] as ResolvedLevel;
const block = (rise: number, extra: Partial<Extract<TerrainOp, { op: "platform" }>> = {}): TerrainOp => ({
  id: "hill",
  op: "platform",
  shape: { type: "rect", x: 10, y: 8, w: 16, h: 12 },
  tiers: 1,
  rise,
  material: "grass",
  edge: "clean",
  ...extra,
});
const codes = (p: MapPlan): string[] => reviewDesign(p, resolvePlan(p), { limit: 99 }).map((n) => n.code);

describe("cliff runs", () => {
  it("a clean 2-tile plateau is one closed run round its edge, in order, with its heights", () => {
    const l = L0(meadow([block(2)], { outline: "rect" }));
    expect(l.cliffs?.length).toBe(1);
    const run = l.cliffs?.[0];
    expect(run?.closed).toBe(true);
    expect(run?.edges.length).toBe(2 * (16 + 12));
    expect(run?.minRise).toBe(8);
    expect(run?.edges.every((e) => e.high === 8 && e.low === 0)).toBe(true);
    expect(run?.material).toBe("grass");
  });
  it("a plank of stairs up the plateau is kept in the run as a crossing", () => {
    const stairs: TerrainOp = { id: "up", op: "stairs", from: [18, 22], to: [18, 18], width: 2 };
    const l = L0(meadow([block(2), stairs], { outline: "rect" }));
    expect(l.cliffs?.some((r) => r.crossings.length > 0)).toBe(true);
  });
});

describe("bold rises and rock ramps", () => {
  it("a natural ragged hill with no rise given defaults to two terraces 2.5 tiles apart", () => {
    const hill: TerrainOp = {
      id: "hill",
      op: "platform",
      shape: { type: "rect", x: 8, y: 6, w: 24, h: 18 },
      material: "grass",
    };
    const l = L0(meadow([hill], { outline: "rect" }));
    expect(Math.max(...Array.from(l.cells.height))).toBe(20);
  });
  it("a rock ramp climbs in half-tile steps on rock floor and is recorded", () => {
    const ramp: TerrainOp = {
      id: "ramp",
      op: "stairs",
      from: [6, 26],
      to: [16, 14],
      width: 4,
      style: "ramp",
    };
    const l = L0(meadow([block(2), ramp], { outline: "rect" }));
    const r = l.ramps?.[0];
    expect(r?.id).toBe("ramp");
    const cells = new Set((r?.cells ?? []).map(([x, y]) => `${x},${y}`));
    for (const [x, y] of r?.cells ?? []) {
      expect(l.materials[(l.cells.material[y * W + x] as number) - 1]).toBe("rock");
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ] as const)
        if (cells.has(`${nx},${ny}`))
          expect(
            Math.abs((l.cells.height[y * W + x] as number) - (l.cells.height[ny * W + nx] as number)),
          ).toBeLessThanOrEqual(2);
    }
  });
});

describe("natural board outline", () => {
  const openShare = (l: ResolvedLevel): number =>
    Array.from(l.cells.state).filter((s) => s === CELL.OPEN).length / (W * H);
  it("an open-air natural level is ragged; rect, roads and generator 1 keep the rectangle", () => {
    const l = L0(meadow([block(2)]));
    const share = openShare(l);
    expect(share).toBeGreaterThan(0.7);
    expect(share).toBeLessThan(0.95);
    expect(openShare(L0(meadow([block(2)], { outline: "rect" })))).toBe(1);
    expect(openShare(L0(meadow([block(2)], {}, 1)))).toBe(1);
    const road: TerrainOp = {
      id: "road",
      op: "path",
      points: [
        [0, 2],
        [39, 2],
      ],
      width: 4,
      material: "asphalt",
      sidewalk: { width: 1, material: "concrete" },
    };
    expect(openShare(L0(meadow([road])))).toBe(1);
  });
  it("a river still reaches the true board edge", () => {
    const river: TerrainOp = {
      id: "river",
      op: "path",
      points: [
        [0, 15],
        [20, 17],
        [39, 14],
      ],
      width: 3,
      material: "water_shallow",
    };
    const l = L0(meadow([river]));
    let atEdge = 0;
    for (let y = 0; y < H; y++)
      for (const x of [0, W - 1])
        if (
          ((l.cells.flags[y * W + x] as number) & CELL_FLAG.WATER) !== 0 &&
          l.cells.state[y * W + x] === CELL.OPEN
        )
          atEdge++;
    expect(atEdge).toBeGreaterThan(0);
  });
});

describe("review: cliff checks", () => {
  // rock pieces along every edge of the 2-tile plateau, reaching out over the low ground, with crests at the lip
  const band = (): Feature[] => {
    const out: Feature[] = [];
    let n = 0;
    const face = (x: number, y: number): void => {
      out.push({ id: `r${n++}`, type: "cliff_face", at: [x, y], size: [2, 3] });
    };
    for (let x = 10; x < 26; x += 2) {
      face(x, 6);
      face(x, 19);
      out.push({ id: `c${n++}`, type: "cliff_crest", at: [x, 8] });
      out.push({ id: `c${n++}`, type: "cliff_crest", at: [x, 19] });
    }
    for (let y = 8; y < 20; y += 2) {
      out.push({ id: `r${n++}`, type: "cliff_face", at: [8, y], size: [3, 2] });
      out.push({ id: `r${n++}`, type: "cliff_face", at: [25, y], size: [3, 2] });
      out.push({ id: `c${n++}`, type: "cliff_crest", at: [10, y] });
      out.push({ id: `c${n++}`, type: "cliff_crest", at: [25, y] });
    }
    return out;
  };
  it("cliff_unclad: a bare 2-tile cliff fires; a faced one is quiet", () => {
    expect(codes(meadow([block(2)], { outline: "rect" }))).toContain("cliff_unclad");
    expect(codes(meadow([block(2)], { outline: "rect", features: band() }))).not.toContain("cliff_unclad");
  });
  it("rise_timid: a hill of one-tile steps fires; two bold terraces are quiet", () => {
    const steps = block(1, { tiers: 4, inset: 2 });
    expect(codes(meadow([steps], { outline: "rect" }))).toContain("rise_timid");
    const bold = block(2.5, { tiers: 2, inset: 3 });
    expect(codes(meadow([bold], { outline: "rect" }))).not.toContain("rise_timid");
  });
  it("board_rectangular: a natural map that fills its rectangle fires; the natural outline is quiet", () => {
    expect(codes(meadow([block(2)], {}, 1))).toContain("board_rectangular");
    expect(codes(meadow([block(2)]))).not.toContain("board_rectangular");
  });
});

describe("review: cliff checks, the rest", () => {
  // the 2-tile plateau's edge: x 10..25 on rows 8 and 19, y 8..19 on columns 10 and 25
  type Piece = {
    at: [number, number];
    size: [number, number];
    type?: "cliff_face" | "cliff_crest";
    rot?: 0 | 90 | 180 | 270;
    lift?: number | undefined;
  };
  const pieces = (list: Piece[]): Feature[] =>
    list.map((p, i) => ({
      id: `p${i}`,
      type: p.type ?? "cliff_face",
      at: p.at,
      size: p.size,
      ...(p.rot !== undefined ? { rot: p.rot } : {}),
      ...(p.lift !== undefined ? { lift: p.lift } : {}),
    }));
  // rocks reaching 2 cells out and 1 back, with crests at the lip; `jag` pushes alternate pieces a cell further out
  const band = (o: { jag?: boolean; crest?: boolean; turn?: boolean; lift?: number } = {}): Feature[] => {
    const list: Piece[] = [];
    const rot = (i: number): 0 | 90 | 180 | 270 => (o.turn ? (([0, 90, 180, 270] as const)[i % 4] ?? 0) : 0);
    let i = 0;
    for (let x = 10; x < 26; x += 2) {
      const j = o.jag && (x / 2) % 2 === 0 ? 1 : 0;
      list.push({ at: [x, 6 - j], size: [2, 3 + 2 * j], rot: rot(i++), lift: o.lift });
      list.push({ at: [x, 19], size: [2, 3 + 2 * j], rot: rot(i++), lift: o.lift });
      if (o.crest !== false)
        list.push(
          { at: [x, 8], size: [1, 1], type: "cliff_crest" },
          { at: [x, 19], size: [1, 1], type: "cliff_crest" },
        );
    }
    for (let y = 8; y < 20; y += 2) {
      const j = o.jag && (y / 2) % 2 === 0 ? 1 : 0;
      list.push({ at: [8 - j, y], size: [3 + 2 * j, 2], rot: rot(i++), lift: o.lift });
      list.push({ at: [25, y], size: [3 + 2 * j, 2], rot: rot(i++), lift: o.lift });
      if (o.crest !== false)
        list.push(
          { at: [10, y], size: [1, 1], type: "cliff_crest" },
          { at: [25, y], size: [1, 1], type: "cliff_crest" },
        );
    }
    return pieces(list);
  };
  // flush pieces: covering the edge from the upper side only, one cell deep
  const flush = (): Feature[] => {
    const list: Piece[] = [];
    for (let x = 10; x < 26; x++) list.push({ at: [x, 8], size: [1, 1] }, { at: [x, 19], size: [1, 1] });
    for (let y = 9; y < 19; y++) list.push({ at: [10, y], size: [1, 1] }, { at: [25, y], size: [1, 1] });
    return pieces(list);
  };
  const at = (rise: number, features: Feature[]): string[] =>
    codes(meadow([block(rise)], { outline: "rect", features }));

  it("cliff_unclad_low: bare one-tile banks fire; banks with boulders are quiet", () => {
    expect(at(1, [])).toContain("cliff_unclad_low");
    expect(at(1, band())).not.toContain("cliff_unclad_low");
  });
  it("cliff_sheer and cliff_band_thin: flush one-cell blocks fire; a band reaching out is quiet", () => {
    const bad = at(2, flush());
    expect(bad).toContain("cliff_sheer");
    expect(bad).toContain("cliff_band_thin");
    const good = at(2, band());
    expect(good).not.toContain("cliff_sheer");
    expect(good).not.toContain("cliff_band_thin");
  });
  it("cliff_no_crest: a band without crest boulders fires; with crests it is quiet", () => {
    expect(at(2, band({ crest: false }))).toContain("cliff_no_crest");
    expect(at(2, band())).not.toContain("cliff_no_crest");
  });
  it("cliff_straight: a ruler-edged band fires; a jagged one is quiet", () => {
    expect(at(2, band())).toContain("cliff_straight");
    expect(at(2, band({ jag: true }))).not.toContain("cliff_straight");
  });
  it("cliff_repetition: one piece in one turn fires; turned pieces are quiet", () => {
    expect(at(2, band({ crest: false }))).toContain("cliff_repetition");
    expect(at(2, band({ turn: true }))).not.toContain("cliff_repetition");
  });
  it("cliff_hanging: rocks lifted into the air fire; rocks on the ground are quiet", () => {
    expect(at(2, band({ lift: 2 }))).toContain("cliff_hanging");
    expect(at(2, band())).not.toContain("cliff_hanging");
  });
});

describe("verify: a band cliff with nothing in front", () => {
  it("never ships a hole: an edge the band left bare gets a face block of one family, and verify stays quiet", () => {
    const cat = loadPalettes();
    const p = (features: Feature[]): MapPlan => ({
      ...meadow([block(2)], { outline: "rect", features }),
      theme: "forest",
    });
    const gap = (plan: MapPlan): boolean =>
      compileResolved(resolvePlan(plan), cat, slabCodec, { plan }).diagnostics.some(
        (d) => d.code === "verify_cliff_gap",
      );
    expect(gap(p([]))).toBe(false);
    const bare = p([]);
    const ledges =
      realize(resolvePlan(bare), cat).levels[0]?.placements.filter(
        (q) =>
          q.role === "ledge" &&
          (q.source.cell?.[0] ?? -1) >= 10 &&
          (q.source.cell?.[0] ?? 99) <= 25 &&
          (q.source.cell?.[1] ?? -1) >= 8 &&
          (q.source.cell?.[1] ?? 99) <= 19,
      ) ?? [];
    expect(ledges.length).toBeGreaterThan(20);
    expect(new Set(ledges.map((q) => q.asset)).size).toBe(1);
    const cover: Feature[] = [];
    let n = 0;
    for (let x = 9; x < 27; x += 2) {
      cover.push({ id: `a${n++}`, type: "cliff_face", at: [x, 6], size: [2, 3] });
      cover.push({ id: `a${n++}`, type: "cliff_face", at: [x, 19], size: [2, 3] });
    }
    for (let y = 8; y < 20; y += 2) {
      cover.push({ id: `a${n++}`, type: "cliff_face", at: [8, y], size: [3, 2] });
      cover.push({ id: `a${n++}`, type: "cliff_face", at: [25, y], size: [3, 2] });
    }
    expect(gap(p(cover))).toBe(false);
  });
});

describe("uneven ground is gentle", () => {
  const rough: TerrainOp = { id: "rough", op: "uneven", amount: 1, scale: 4 };
  it("generator 2 rounds its half-tile bands so no square terraces show; generator 1's square lumps raise the note", () => {
    const g2 = meadow([rough], { outline: "rect" });
    expect(codes(g2)).not.toContain("square_terraces");
    const l = L0(g2);
    const hs = Array.from(l.cells.height);
    expect(hs.every((h) => h % 2 === 0)).toBe(true);
    expect(codes(meadow([rough], {}, 1))).toContain("square_terraces");
  });
});

describe("the rock band follows the theme's pieces", () => {
  const dressed = (theme: string): ResolvedLevel => {
    const p = meadow([block(2.5), { id: "wood", op: "dress", preset: "natural_clusters" }], {
      outline: "rect",
    });
    return L0({ ...p, theme });
  };
  it("a theme without rock formations gets no band pieces; a forest gets them at their real size", () => {
    for (const theme of ["city", "stone_dungeon"]) {
      const l = dressed(theme);
      expect(l.features.filter((f) => f.type === "cliff_face" || f.type === "cliff_crest")).toEqual([]);
    }
    const forest = dressed("forest");
    const faces = forest.features.filter((f) => f.type === "cliff_face");
    expect(faces.length).toBeGreaterThan(0);
    // Cliff Face is 5 × 3 cells in the bundled palettes (a turned piece covers up to 5 × 5), never the nominal 4 × 2
    for (const f of faces) {
      expect(Math.max(...f.size)).toBe(5);
      expect(Math.min(...f.size)).toBeGreaterThanOrEqual(3);
    }
  });
});
