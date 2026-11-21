/**
 * Generator 3 rock band spacing and tone: boulders come in groups with gaps (not a fence along the lip), face rock carries
 * the cover, the board-edge skirt is one course inside the board's bounds, and a role's pieces are narrowed to one
 * rock tone. Also the review's even-spacing measure (review/rockSpacing.ts).
 */
import { describe, expect, it } from "vitest";
import type { MapPlan, Side } from "../../../src/contracts/plan";
import { cliffBand, matchTone, terraceRockShare, type PlacementGrid } from "../../../src/gen/index";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { reviewDesign } from "../../../src/review/index";
import { FENCE, fenceShare, type FenceRule } from "../../../src/review/rockSpacing";
import { loadPlan } from "../../fixtures";

const W = 44;
const H = 30;
const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

/** A plateau of rise 3 over low ground: a long lip, no routes. */
function plateau(): { grid: PlacementGrid; cells: Array<[number, number]> } {
  const height = (x: number, y: number): number => (y >= 4 && y <= 24 && x >= 6 && x <= 38 ? 3 : 0);
  const grid: PlacementGrid = {
    inBounds: inB,
    isFloor: inB,
    flags: () => 0,
    area: (x, y) => (inB(x, y) ? 1 : 0),
    occupied: () => false,
    edge: (x, y, s: Side) => {
      const nx = x + (s === "E" ? 1 : s === "W" ? -1 : 0);
      const ny = y + (s === "S" ? 1 : s === "N" ? -1 : 0);
      return inB(nx, ny) && height(nx, ny) !== height(x, y) ? 3 : 0;
    },
    height,
    generator: 3,
  };
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cells.push([x, y]);
  return { grid, cells };
}

const centres = (
  list: ReadonlyArray<{
    at: readonly [number, number];
    size: readonly [number, number];
    offset?: readonly [number, number] | undefined;
  }>,
): Array<{ x: number; y: number }> =>
  list.map((q) => ({
    x: q.at[0] + q.size[0] / 2 + (q.offset?.[0] ?? 0),
    y: q.at[1] + q.size[1] / 2 + (q.offset?.[1] ?? 0),
  }));

describe("even spacing measure (boulders set like a fence along the lip)", () => {
  const rule = FENCE.cliff_crest as FenceRule;
  // v3 as built: boulders along a lip at gaps of 1.8 to 3.4 tiles, one after the other (gaps taken from the proof)
  const v3Gaps = [2.5, 3.3, 2.3, 2.5, 3.1, 2.9, 3.0, 2.3, 1.8, 2.5, 1.9, 1.8];
  const along = (gaps: number[]): Array<{ x: number; y: number }> => {
    let x = 0;
    return [{ x, y: 0 }, ...gaps.map((g) => ({ x: (x += g), y: 0 }))];
  };

  it("v3's boulder fence fails: most of its boulders stand in one run", () => {
    const s = fenceShare(along(v3Gaps), rule);
    expect(s.runs).toHaveLength(1);
    expect(s.share).toBeGreaterThan(0.9);
  });

  it("groups of two to five with clear gaps between them pass", () => {
    const pts: Array<{ x: number; y: number }> = [];
    let x = 0;
    for (const n of [3, 2, 5, 4, 3]) {
      for (let i = 0; i < n; i++) pts.push({ x: (x += 0.9 + (i % 2) * 0.3), y: (i % 3) * 0.3 });
      x += 5 + n * 0.4;
    }
    expect(fenceShare(pts, rule).runs).toEqual([]);
  });

  it("boulders piled on one spot count once", () => {
    const pts = along([2.2, 2.2, 2.2]).flatMap((p) => [p, { x: p.x + 0.1, y: p.y }]);
    expect(fenceShare(pts, rule).runs).toHaveLength(0);
    expect(
      fenceShare(
        along([2.2, 2.2, 2.2, 2.2]).flatMap((p) => [p, { x: p.x + 0.1, y: p.y }]),
        rule,
      ).runs,
    ).toHaveLength(1);
  });

  it("long pieces laid at one constant step fail, an irregular step passes", () => {
    const faceRule = FENCE.cliff_face as FenceRule;
    expect(fenceShare(along([2, 2, 2, 2, 2, 2, 2, 2]), faceRule).runs).toHaveLength(1);
    expect(fenceShare(along([1.5, 2.9, 2.0, 1.4, 3.0, 2.2, 1.6, 2.8]), faceRule).runs).toEqual([]);
  });
});

describe("review: cliff_even_spacing", () => {
  const load = (): MapPlan => loadPlan("terraced-hill");

  it("the default band passes; the same level with its boulders in an even row fails", () => {
    const plan = load();
    const ok = reviewDesign(plan, resolvePlan(plan, bundledPalettes()), bundledPalettes(), { limit: 99 }).map(
      (n) => n.code,
    );
    expect(ok).not.toContain("cliff_even_spacing");
    const resolved = resolvePlan(plan, bundledPalettes());
    const L = resolved.levels[0];
    if (!L) throw new Error("no level");
    const crest = L.features.find((f) => f.type === "cliff_crest");
    if (!crest) throw new Error("no crest boulder in the fixture");
    const rest = L.features.filter((f) => f.type !== "cliff_crest");
    const row = Array.from({ length: 16 }, (_, i) => ({
      ...crest,
      offset: [0, 0] as [number, number],
      id: `row${String(i)}`,
      at: [L.bounds.x + 4 + i * 2, L.bounds.y + 4] as [number, number],
    }));
    L.features = [...rest, ...row];
    const codes = reviewDesign(plan, resolved, bundledPalettes(), { limit: 99 }).map((n) => n.code);
    expect(codes).toContain("cliff_even_spacing");
  });
});

describe("generator 3 crest boulders are accents in groups", () => {
  it("no row of boulders, stretches of bare lip, and more face rock than boulders", () => {
    let faces = 0;
    let crests = 0;
    let inRows = 0;
    let total = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const { grid, cells } = plateau();
      const r = cliffBand(grid, { areaCells: cells, seed });
      const crest = r.placements.filter((q) => q.type === "cliff_crest");
      faces += r.placements.filter((q) => q.type === "cliff_face").length;
      crests += crest.length;
      // (one group of five may read as a short run; a row is most of the boulders)
      const fs = fenceShare(centres(crest), FENCE.cliff_crest as FenceRule);
      inRows += fs.inRuns;
      total += fs.rocks;
      const lip = r.rises.filter((u) => u.hi - u.lo >= 2);
      const bare = lip.filter(
        (u) => !crest.some((q) => Math.hypot(q.at[0] + 0.5 - u.low[0], q.at[1] + 0.5 - u.low[1]) <= 3),
      );
      expect(bare.length / Math.max(1, lip.length), `seed ${String(seed)}`).toBeGreaterThan(0.3);
    }
    // (an occasional group of five may read as a short run; a row is most of the boulders; the review's limit is 25%)
    expect(inRows / Math.max(1, total)).toBeLessThanOrEqual(0.15);
    expect(faces / Math.max(1, crests)).toBeGreaterThanOrEqual(1.5);
  }, 30_000); // eight full cliff bands: 3 to 4 s under a parallel run, too close to the 5 s default on a slow CI runner
});

describe("generator 3 board-edge skirt", () => {
  const Wd = 40;
  const Hd = 30;
  const inBd = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < Wd && y < Hd;
  const ring = (x: number, y: number): boolean => x < 4 || y < 4 || x >= Wd - 4 || y >= Hd - 4;
  const base: PlacementGrid = {
    inBounds: inBd,
    isFloor: (x, y) => inBd(x, y) && !ring(x, y),
    flags: () => 0,
    area: (x, y) => (inBd(x, y) ? 1 : 0),
    occupied: () => false,
    edge: () => 0,
    height: (x, y) => (ring(x, y) ? 0 : 2),
    void: (x, y) => !inBd(x, y) || ring(x, y),
    generator: 3,
  };
  const all = (pred: (x: number, y: number) => boolean): Array<[number, number]> => {
    const c: Array<[number, number]> = [];
    for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (pred(x, y)) c.push([x, y]);
    return c;
  };

  it("is one course of face rock, wholly inside the bounds", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = cliffBand(base, { areaCells: all((x, y) => base.isFloor(x, y)), seed });
      expect(r.placements.length).toBeGreaterThan(5);
      for (const q of r.placements) {
        expect(q.type).toBe("cliff_face");
        expect(q.at[0]).toBeGreaterThanOrEqual(0);
        expect(q.at[1]).toBeGreaterThanOrEqual(0);
        expect(q.at[0] + q.size[0]).toBeLessThanOrEqual(Wd);
        expect(q.at[1] + q.size[1]).toBeLessThanOrEqual(Hd);
      }
    }
  });

  it("is left out where the ground stands at the bounds (a piece would lie beyond them)", () => {
    const edgeGrid: PlacementGrid = { ...base, isFloor: inBd, height: () => 2, void: (x, y) => !inBd(x, y) };
    expect(cliffBand(edgeGrid, { areaCells: all(inBd), seed: 3 }).placements).toEqual([]);
  });
});

describe("rock on a terrace", () => {
  it("terraceRockShare counts the walkable cells a standing rock covers", () => {
    const cells: Array<{ x: number; y: number; ground: number }> = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) cells.push({ x, y, ground: 2 });
    // a 4 x 2 rock standing on the ground over 8 cells, and one at another height (on a different terrace's rock)
    const on = { cx: 2, cy: 1, rot: 0, w: 4, d: 2, base: 2, top: 4 };
    const above = { cx: 7, cy: 5, rot: 0, w: 4, d: 2, base: 5, top: 7 };
    const r = terraceRockShare([on, above], cells);
    expect(r).toHaveLength(1);
    expect(r[0]?.covered).toBe(8);
    expect(r[0]?.share).toBeCloseTo(0.1, 5);
  });

  it("a piece never piles on another of its kind at the same height", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const { grid, cells } = plateau();
      const r = cliffBand(grid, { areaCells: cells, seed });
      const key = (q: (typeof r.placements)[number]): string =>
        `${q.type}|${String(Math.round((grid.height?.(q.at[0], q.at[1]) ?? 0) + q.lift))}|${String(Math.round(q.at[0] / 1.5))}|${String(Math.round(q.at[1] / 1.5))}`;
      const counts = new Map<string, number>();
      for (const q of r.placements) counts.set(key(q), (counts.get(key(q)) ?? 0) + 1);
      expect(Math.max(...counts.values()), `seed ${String(seed)}`).toBeLessThanOrEqual(3);
      expect(r.placements.length).toBeLessThan(260);
    }
  });
});

describe("one rock tone per cliff", () => {
  const v = (tone?: "dark" | "mid" | "light"): { tone?: "dark" | "mid" | "light"; weight: number } => ({
    ...(tone ? { tone } : {}),
    weight: 1,
  });

  it("narrows a role to the tone family it shares with its pair", () => {
    const m = matchTone([v("light"), v("dark"), v("dark")], [v("dark"), v("mid")]);
    expect(m.tone).toBe("dark");
    expect(m.pool).toHaveLength(2);
  });

  it("with no shared tone keeps the family with most pieces and names the tone the pair lacks", () => {
    const m = matchTone([v("light"), v("light"), v("dark")], [v("mid")]);
    expect(m.tone).toBe("light");
    expect(m.missing).toBe("light");
    expect(m.pool).toHaveLength(2);
  });

  it("leaves untagged pieces alone", () => {
    expect(matchTone([v()], [v("dark")]).pool).toHaveLength(1);
  });
});
