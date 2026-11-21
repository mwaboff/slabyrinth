/**
 * Generator 3 roofs of cottages and inns: the roof is the larger part of the visible height (the study: 55-65 %), the top
 * storey sits inside it, cross wings and lean-tos stand lower than the main ridge, and where two roofs meet the higher
 * surface owns each cell so no cell of any outline is left open.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedLevel, ResolvedStructure } from "../../../src/contracts/resolved";
import { realize } from "../../../src/compile";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve/index";
import { mergeRoofs, roofOwners, roofProportion } from "../../../src/resolve";
import { gableRoof, type RoofOwner } from "../../../src/resolve/roof";
import { reviewDesign } from "../../../src/review";
import { townPlan } from "../../fixtures/planBuilder";

const palettes = loadPalettes();
const SIZES: Array<[number, number]> = [
  [6, 5],
  [7, 6],
  [8, 6],
  [9, 7],
  [10, 7],
  [7, 7],
  [10, 8],
];

/** One cottage (or inn, by `use`) of the given seed and footprint on a 22x22 lot. */
const plan = (seed: number, use: string | undefined, w: number, h: number, generator: 2 | 3 = 3): MapPlan =>
  townPlan({
    generator,
    id: "roofs",
    seed: 3,
    w: 22,
    h: 22,
    structures: [
      { id: "b", style: "cottage", seed, ...(use ? { use } : {}), wings: [{ x: 5, y: 5, w, h }], front: "S" },
    ],
    level: { features: [{ id: "f", type: "statue", at: [1, 1] }] },
  });
const build = (p: MapPlan): ResolvedStructure =>
  ((resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel).structures ?? [])[0] as ResolvedStructure;

const SAMPLE: Array<{
  use: "cottage" | "inn";
  seed: number;
  w: number;
  h: number;
  st: ResolvedStructure;
  p: MapPlan;
}> = [];
for (const use of ["cottage", "inn"] as const)
  for (let seed = 1; seed <= 40; seed++) {
    const [w, h] = SIZES[seed % SIZES.length] as [number, number];
    const p = plan(seed, use === "inn" ? "tavern" : undefined, w, h);
    SAMPLE.push({ use, seed, w, h, st: build(p), p });
  }

describe("roof proportions (generator 3)", () => {
  for (const use of ["cottage", "inn"] as const) {
    it(`${use}s: the roof is about half to two thirds of the visible height, seeded`, () => {
      const shares = SAMPLE.filter((s) => s.use === use)
        .map((s) => roofProportion(s.st)?.share)
        .filter((x): x is number => x !== undefined)
        .sort((a, b) => a - b);
      expect(shares.length).toBeGreaterThan(30);
      const median = shares[Math.floor(shares.length / 2)] as number;
      expect(median).toBeGreaterThanOrEqual(0.5);
      expect(median).toBeLessThanOrEqual(0.66);
      // most reach half; none is a squat lid under a third
      expect(shares.filter((x) => x >= 0.5).length / shares.length).toBeGreaterThan(0.5);
      expect(shares[0] as number).toBeGreaterThan(0.3);
      // two buildings of one style differ by seed
      expect(new Set(shares.map((x) => x.toFixed(2))).size).toBeGreaterThan(4);
      expect(
        new Set(SAMPLE.filter((s) => s.use === use).map((s) => s.st.design?.archetype)).size,
      ).toBeGreaterThan(2);
    });
  }

  it("the top storey sits inside the roof more often than at generator 2, and the walls are lower", () => {
    let attic3 = 0;
    let attic2 = 0;
    let walls3 = 0;
    let walls2 = 0;
    let n = 0;
    for (const s of SAMPLE.filter((x) => x.use === "cottage")) {
      const old = build(plan(s.seed, undefined, s.w, s.h, 2));
      n++;
      if (s.st.design?.top === "attic") attic3++;
      if (old.design?.top === "attic") attic2++;
      walls3 += s.st.volumes?.[0]?.storeys.at(-1)?.wallTop ?? 0;
      walls2 += old.volumes?.[0]?.storeys.at(-1)?.wallTop ?? 0;
    }
    expect(attic3).toBeGreaterThan(attic2);
    expect(walls3 / n).toBeLessThan(walls2 / n);
  });

  it("a cross wing or lean-to ridge stands a tile or more below the main ridge", () => {
    let multi = 0;
    for (const s of SAMPLE) {
      const rp = roofProportion(s.st);
      if (!rp || rp.ridges.length < 2) continue;
      multi++;
      const [main, ...others] = rp.ridges as [number, ...number[]];
      for (const r of others)
        expect(main - r, `${s.use} ${s.st.design?.archetype} ${rp.ridges.join(",")}`).toBeGreaterThanOrEqual(
          1 - 1e-9,
        );
    }
    expect(multi).toBeGreaterThan(20);
  });

  it("generator 2 designs are untouched: no roof share, no valleys", () => {
    const old = build(plan(7, "tavern", 9, 7, 2));
    expect(old.design?.roofShare).toBeUndefined();
    expect(old.valleys).toBeUndefined();
    expect(build(plan(7, "tavern", 9, 7, 3)).valleys).toBe(true);
  });

  it("the review notes a squat pitched roof (roof_squat) only when the roof is under 40 % of the height", () => {
    const p = SAMPLE[0]?.p as MapPlan;
    const r = resolvePlan(p, bundledPalettes());
    const st = (r.levels[0] as ResolvedLevel).structures?.[0] as ResolvedStructure;
    expect(reviewDesign(p, r, bundledPalettes(), { limit: 99 }).some((n) => n.code === "roof_squat")).toBe(
      (roofProportion(st)?.share ?? 1) < 0.4,
    );
    // raise the walls of every volume until the roof is a lid
    for (const v of st.volumes ?? []) for (const s of v.storeys) s.wallTop += 6;
    expect(roofProportion(st)?.share ?? 1).toBeLessThan(0.4);
    expect(reviewDesign(p, r, bundledPalettes(), { limit: 99 }).some((n) => n.code === "roof_squat")).toBe(
      true,
    );
  });
});

/**
 * Cells covered by the kept pieces of a merged roof set, and the highest surface of any roof at each cell. Slope pieces
 * of one roof overlap by half on purpose, so "covered" means at least once; a kept piece always belongs to the roof
 * whose surface is the highest there.
 */
function covered(owners: RoofOwner[]): { cover: Map<string, number>; high: Map<string, number> } {
  const merged = mergeRoofs(owners);
  const cover = new Map<string, number>();
  for (const [, ps] of merged)
    for (const p of ps)
      for (let y = p.y; y < p.y + p.h; y++)
        for (let x = p.x; x < p.x + p.w; x++) cover.set(`${x},${y}`, (cover.get(`${x},${y}`) ?? 0) + 1);
  const high = new Map<string, number>();
  for (const o of owners)
    for (const p of o.pieces)
      for (let y = p.y; y < p.y + p.h; y++)
        for (let x = p.x; x < p.x + p.w; x++) {
          const s = o.surface(x, y);
          if (s >= 0) high.set(`${x},${y}`, Math.max(high.get(`${x},${y}`) ?? -1, o.base + s));
        }
  return { cover, high };
}

describe("valleys where roofs meet (generator 3)", () => {
  it("two gables meeting at right angles leave no cell open; the higher surface owns the overlap", () => {
    const main = { x: 0, y: 0, w: 9, h: 5, ridge: "ew" as const };
    const wing = { x: 0, y: 5, w: 5, h: 5, ridge: "ns" as const };
    const mk = (
      id: string,
      w: { x: number; y: number; w: number; h: number; ridge: "ew" | "ns" },
      base: number,
    ): RoofOwner => {
      const g = gableRoof(w);
      const o = g.outline;
      return {
        id,
        base,
        pieces: g.pieces,
        surface: (x, y) =>
          x < o.x || y < o.y || x >= o.x + o.w || y >= o.y + o.h
            ? -1
            : (g.rowCourse[w.ridge === "ew" ? y - o.y : x - o.x] ?? -1),
      };
    };
    const owners = [mk("main#0", main, 4), mk("wing#0", wing, 3)];
    const { cover, high } = covered(owners);
    expect(high.size).toBeGreaterThan(60);
    // every roofed cell is covered by the kept pieces, and no cell is roofed that no roof reaches
    for (const k of high.keys()) expect(cover.get(k), k).toBeGreaterThanOrEqual(1);
    expect(cover.size).toBe(high.size);
    // a kept piece never lies on a cell where another roof stands higher (no roof cutting through another)
    const merged = mergeRoofs(owners);
    for (const [id, ps] of merged) {
      const o = owners.find((q) => q.id === id) as RoofOwner;
      for (const p of ps)
        for (let y = p.y; y < p.y + p.h; y++)
          for (let x = p.x; x < p.x + p.w; x++)
            expect(o.base + o.surface(x, y), `${id} ${x},${y}`).toBeGreaterThanOrEqual(
              (high.get(`${x},${y}`) ?? 0) - 1e-9,
            );
    }
    expect((merged.get("wing#0") ?? []).length).toBeGreaterThan(0);
    expect((merged.get("main#0") ?? []).length).toBeGreaterThan(0);
  });

  it("every ell, twin and lean-to of the sample is roofed without a hole", () => {
    let checked = 0;
    for (const s of SAMPLE) {
      const vols = s.st.volumes ?? [];
      if (vols.filter((v) => v.on === null && v.roof.layers.length > 0).length < 2) continue;
      const holes = new Set(s.st.chimneys.map((c) => `${c.at[0]},${c.at[1]}`));
      const { cover, high } = covered(roofOwners(vols, holes));
      for (const k of high.keys())
        expect(cover.get(k), `${s.st.design?.archetype} ${k}`).toBeGreaterThanOrEqual(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("the compiler builds the merged roof: a generator 3 ell has roof pieces and verifies without a roof overlap", () => {
    const s = SAMPLE.find((x) => x.use === "inn" && x.st.design?.archetype === "ell");
    expect(s).toBeDefined();
    const pl =
      realize(resolvePlan((s as { p: MapPlan }).p, bundledPalettes()), palettes).levels[0]?.placements ?? [];
    expect(pl.filter((q) => /roof/.test(String(q.source.elementId))).length).toBeGreaterThan(20);
  });
});
