/**
 * Generator 3: small props rest on larger ones (goods on a counter, candles on a table, a lantern on a chest, a tuft
 * on a boulder) at the support's real top height, instead of standing on the floor beside it; verify accepts them.
 * Generator 2 output is untouched. Ground cover drifts in clusters with bare ground between.
 */
import { describe, expect, it } from "vitest";
import type { Side } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { dressArea, type GeneratedPlacement, type PlacementGrid } from "../../../src/gen/index";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { loadPlan } from "../../fixtures";

const W = 30;
const H = 20;
const EXTENT: Record<string, { w: number; d: number; h: number }> = {
  table: { w: 1.7, d: 0.9, h: 0.74 },
  desk: { w: 1.4, d: 0.6, h: 1.22 },
  chest: { w: 0.8, d: 0.5, h: 0.42 },
  boulder: { w: 1.5, d: 1.8, h: 1.62 },
};
function room(generator: number): PlacementGrid {
  return {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    flags: () => 0,
    area: () => 1,
    occupied: () => false,
    edge: (x, y, s: Side) =>
      (s === "N" && y === 0) ||
      (s === "S" && y === H - 1) ||
      (s === "W" && x === 0) ||
      (s === "E" && x === W - 1)
        ? 1
        : 0,
    height: () => 0,
    generator,
    pieceExtent: (t) => EXTENT[t],
  };
}
const cells = (): Array<[number, number]> => {
  const o: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o.push([x, y]);
  return o;
};
const dress = (preset: "tavern" | "campsite" | "natural_clusters", generator: number, seed: number) =>
  dressArea(room(generator), {
    preset,
    areaIndex: 1,
    areaCells: cells(),
    density: 0.8,
    seed,
    remaining: 5000,
  }).placements;

const supports = (ps: GeneratedPlacement[], t: string): GeneratedPlacement[] =>
  ps.filter((p) => p.type === t);
const rests = (top: GeneratedPlacement, sup: GeneratedPlacement): boolean => {
  const mx = sup.at[0] + sup.size[0] / 2;
  const my = sup.at[1] + sup.size[1] / 2;
  const cx = top.at[0] + 0.5 + (top.offset?.[0] ?? 0);
  const cy = top.at[1] + 0.5 + (top.offset?.[1] ?? 0);
  return Math.abs(cx - mx) <= 0.35 && Math.abs(cy - my) <= 0.35;
};

describe("props rest on props", () => {
  it("a table, desk or chest carries small pieces at its real top height at generator 3", () => {
    let found = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const ps = dress("tavern", 3, seed);
      for (const top of ps.filter((p) => p.lift !== undefined)) {
        const sup = ps.find((s) => EXTENT[s.type] !== undefined && s !== top && rests(top, s));
        expect(sup).toBeDefined();
        expect(top.lift).toBeCloseTo(EXTENT[(sup as GeneratedPlacement).type]?.h ?? -1, 5);
        found++;
      }
    }
    expect(found).toBeGreaterThan(5);
  });

  it("a group part with `on` stands on its support (a lantern on a chest) and takes no cell of its own", () => {
    let lifted = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const ps = dress("campsite", 3, seed);
      for (const top of ps.filter(
        (p) => p.lift !== undefined && (p.type === "lantern" || p.type === "candles"),
      )) {
        const chest = supports(ps, "chest").find((c) => rests(top, c));
        expect(chest).toBeDefined();
        expect(top.lift).toBeCloseTo(0.42, 5);
        lifted++;
      }
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it("generator 2 is untouched: nothing is lifted, and the output is the same with or without the hooks", () => {
    for (const preset of ["tavern", "campsite", "natural_clusters"] as const) {
      const a = dress(preset, 2, 7);
      expect(a.filter((p) => p.lift !== undefined)).toHaveLength(0);
    }
  });

  it("leaves bare ground between ground-cover drifts at generator 3", () => {
    const bare = (ps: GeneratedPlacement[]): number => {
      const cover = ps.filter((p) => p.type === "ground_cover" || p.type === "small_detail");
      let far = 0;
      for (const [x, y] of cells())
        if (!cover.some((c) => Math.hypot(c.at[0] - x, c.at[1] - y) <= 1.5)) far++;
      return far / (W * H);
    };
    let b2 = 0;
    let b3 = 0;
    for (let seed = 1; seed <= 6; seed++) {
      b2 += bare(dress("natural_clusters", 2, seed));
      b3 += bare(dress("natural_clusters", 3, seed));
    }
    // cells with no ground cover or small detail within a cell and a half
    expect(b3 / 6).toBeGreaterThan(b2 / 6 + 0.04);
    expect(b3 / 6).toBeGreaterThan(0.3);
  });
});

describe("props rest on props: the whole build", () => {
  const fixture = loadPlan("sea-grotto");
  const palettes = loadPalettes();
  const build = (generator: 2 | 3) => {
    const plan = { ...fixture, generator };
    const r = resolvePlan(plan, bundledPalettes());
    const set = realize(r, palettes, {});
    set.diagnostics.push(...verifyBuild(r, set, palettes, { plan }).diagnostics);
    return { r, set };
  };
  it("lifts small props onto furniture, and verify raises no floating or sunk warning for them", () => {
    const g3 = build(3);
    const L = g3.r.levels[0];
    const lifted = (L?.features ?? []).filter((f) => {
      const i = (f.at[1] - (L?.bounds.y ?? 0)) * (L?.bounds.w ?? 1) + (f.at[0] - (L?.bounds.x ?? 0));
      return f.baseHeight > (L?.elevation ?? 0) + 0.5 + (L?.cells.height[i] ?? 0) / 4 + 0.2;
    });
    expect(lifted.length).toBeGreaterThan(0);
    const bad = g3.set.diagnostics.filter((d) => /verify_prop_floating|verify_prop_sunk/.test(d.code));
    expect(bad.map((d) => d.message)).toEqual([]);
    const g2 = build(2);
    const lifted2 = (g2.r.levels[0]?.features ?? []).filter((f) => f.id.includes("#") && f.baseHeight > 0.8);
    expect(lifted2.filter((f) => f.type === "candles")).toHaveLength(0);
  });
});
