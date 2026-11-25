/**
 * Draws that vary by an index must not come out nearly equal for neighbours (util/hash.ts `hashUnitMixed`): in game the
 * scatter station read as two neat rows and the fence's odd pieces came in runs. These tests measure the result: a
 * scatter spreads in two dimensions with irregular spacing over all of its area, a run's imperfections differ piece to
 * piece, and odd ones stand alone.
 */
import { describe, expect, it } from "vitest";
import { pick, repeat, scatter, single, vary, HAND_BUILT, type Arrangement } from "../../../src/arrange";
import { hashUnit, hashUnitMixed } from "../../../src/util/hash";
import { maxOf, minOf } from "../../../src/util/lists";
import { synthetic } from "./synthetic";

const stone = synthetic("stone", 0.4, 0.3, 0.5);
const pile = synthetic("pile", 0.7, 0.25, 0.8);
const slat = synthetic("slat", 0.25, 2, 0.24);
const pillar = synthetic("pillar", 0.6, 2, 0.6);

/** Smaller over larger eigenvalue of the points' covariance: 0 on a line, 1 for an even spread. */
function spreadRatio(a: Arrangement): number {
  const n = a.length;
  const mx = a.reduce((s, p) => s + p.x, 0) / n;
  const mz = a.reduce((s, p) => s + p.z, 0) / n;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of a) {
    sxx += (p.x - mx) ** 2;
    szz += (p.z - mz) ** 2;
    sxz += (p.x - mx) * (p.z - mz);
  }
  const tr = (sxx + szz) / n;
  const det = (sxx * szz - sxz * sxz) / (n * n);
  const d = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  return (tr / 2 - d) / (tr / 2 + d);
}

const cv = (xs: readonly number[]): number => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) / m;
};

describe("hash draws by index", () => {
  it("the mixed draw of neighbouring indices is spread over [0, 1); the plain FNV draw is not", () => {
    const mixed = Array.from({ length: 8 }, (_, j) => hashUnitMixed("proof", "scatter", "x", 3, j));
    const plain = Array.from({ length: 8 }, (_, j) => hashUnit("proof", "scatter", "x", 3, j));
    expect(maxOf(mixed) - minOf(mixed)).toBeGreaterThan(0.3);
    // why the operators stopped using it: neighbours cluster within a few hundredths
    expect(maxOf(plain) - minOf(plain)).toBeLessThan(0.1);
  });
});

describe("scatter spreads in two dimensions", () => {
  for (const seed of ["proof", "a", "b", 7]) {
    it(`over a 4 x 4 area (seed ${seed}): not on lines, irregular spacing, every quarter covered`, () => {
      const a = scatter([...single(pile), ...single(stone)], {
        area: { w: 4, d: 4 },
        density: 3,
        cluster: 0.6,
        clusterSize: 2,
        edgeBias: 0.2,
        minSpacing: 0.15,
        empty: 0.2,
        seed,
      });
      expect(a.length).toBeGreaterThan(15);
      expect(spreadRatio(a)).toBeGreaterThan(0.4);
      // no column of pieces: few share an x with another (the rows the plain draw made shared it exactly)
      const sharing = a.filter((p) => a.some((q) => q !== p && Math.abs(q.x - p.x) < 0.005)).length;
      expect(sharing / a.length).toBeLessThan(0.25);
      const nearest = a.map((p) =>
        minOf(a.filter((q) => q !== p).map((q) => Math.hypot(q.x - p.x, q.z - p.z))),
      );
      expect(cv(nearest)).toBeGreaterThan(0.25);
      const quarters = new Set(a.map((p) => `${p.x < 0 ? "W" : "E"}${p.z < 0 ? "S" : "N"}`));
      expect(quarters.size).toBe(4);
      // the pieces' turns and choices differ too
      expect(new Set(a.map((p) => p.yaw)).size).toBeGreaterThan(5);
    });
  }
});

describe("vary and pick along a run", () => {
  const fence = repeat(single(slat), { axis: "x", pitch: 0.24, length: 6 });

  it("vary moves each piece its own way, by amounts visible at table-top zoom", () => {
    const v = vary(fence, { seed: "proof", ...HAND_BUILT });
    const dh = v.map((p) => p.y);
    expect(maxOf(dh) - minOf(dh)).toBeGreaterThan(0.15);
    // neighbours' heights are not alike: the mean step between neighbours is a fair share of the range
    const steps = dh.slice(1).map((h, i) => Math.abs(h - (dh[i] ?? 0)));
    expect(steps.reduce((s, x) => s + x, 0) / steps.length).toBeGreaterThan(0.06);
    expect(new Set(v.map((p) => p.yaw)).size).toBeGreaterThan(1);
  });

  it("vary's empty slots are scattered along the run, never two in a row", () => {
    const v = vary(fence, { seed: "proof", empty: 0.15 });
    const kept = new Set(v.map((p) => Math.round(p.x * 100)));
    const missing = fence.map((p, i) => (kept.has(Math.round(p.x * 100)) ? -1 : i)).filter((i) => i >= 0);
    expect(missing.length).toBeGreaterThan(1);
    for (let k = 1; k < missing.length; k++)
      expect((missing[k] ?? 0) - (missing[k - 1] ?? 0)).toBeGreaterThan(1);
    expect((missing[missing.length - 1] ?? 0) - (missing[0] ?? 0)).toBeGreaterThan(fence.length / 3);
  });

  it("pick's odd ones stand alone among the run", () => {
    const p = pick(fence, { from: [slat, pillar], policy: { kind: "odd", rate: 0.12 }, seed: "proof" });
    const odd = p.map((q, i) => (q.piece === pillar ? i : -1)).filter((i) => i >= 0);
    expect(odd.length).toBeGreaterThan(0);
    expect(odd.length).toBeLessThan(fence.length / 4);
    for (let k = 1; k < odd.length; k++) expect((odd[k] ?? 0) - (odd[k - 1] ?? 0)).toBeGreaterThan(1);
  });
});
