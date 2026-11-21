/**
 * Generator 3 terrain, round three (2026-11-20): bridges cross channels square and short, a cave passage that reaches
 * the board edge is an exit, the plane height and dry upper reaches are reported, floors lay 1x2 pieces both ways,
 * and the review judges a map with no real depth.
 */
import { describe, expect, it } from "vitest";
import { placementMeta, realize, verifyBuild } from "../../../src/compile";
import type { MapPlan } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { reviewDesign } from "../../../src/review";
import { loadPlan } from "../../fixtures";

const rift = (generator: 2 | 3): MapPlan => loadPlan("heartroot-rift-v7", { generator });
const cat = loadPalettes();
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};

describe("bridges cross the channel (generator 3)", () => {
  const p = rift(3);
  const r = resolvePlan(p);
  const L = must(r.levels[0]);

  it("the arched bridge is a short span across the rift, not a ribbon down it", () => {
    const b = must(must(L.bridges).find((q) => q.id === "rift~b1"));
    const xs = b.cells.map((c) => c[0]);
    const ys = b.cells.map((c) => c[1]);
    const dx = Math.max(...xs) - Math.min(...xs) + 1;
    const dy = Math.max(...ys) - Math.min(...ys) + 1;
    // v7 laid this deck 10 cells down the crack (2 wide); now it spans it
    expect(Math.max(dx, dy)).toBeLessThanOrEqual(8);
    expect(reviewDesign(p, r, { limit: 99 }).map((n) => n.code)).not.toContain("bridge_along");
  });

  it("bridge_along fires on a deck laid down the channel", () => {
    const bad = structuredClone(r);
    const lv = must(bad.levels[0]);
    const b = must(must(lv.bridges).find((q) => q.id === "rift~b1"));
    const c0 = must(must(L.channels)[0]).centre;
    // the straightest stretch of the course: a deck laid along it
    let k = 2;
    let bestAlign = 0;
    for (let j = 2; j < c0.length - 2; j++) {
      const u = must(c0[j - 2]);
      const v = must(c0[j + 2]);
      const align =
        Math.max(Math.abs(v[0] - u[0]), Math.abs(v[1] - u[1])) / (Math.hypot(v[0] - u[0], v[1] - u[1]) || 1);
      if (align > bestAlign) {
        bestAlign = align;
        k = j;
      }
    }
    const mid = must(c0[k]);
    b.cells = [];
    const a = must(c0[Math.max(0, k - 1)]);
    const z = must(c0[Math.min(c0.length - 1, k + 1)]);
    const alongX = Math.abs(z[0] - a[0]) > Math.abs(z[1] - a[1]);
    for (let t = -4; t <= 5; t++)
      for (const o of [0, 1])
        b.cells.push([Math.floor(mid[0]) + (alongX ? t : o), Math.floor(mid[1]) + (alongX ? o : t)]);
    const notes = reviewDesign(p, bad, { limit: 99 });
    // only fires when the course there runs along the deck: the stray of the rift is mostly north-south
    expect(notes.some((n) => n.code === "bridge_along")).toBe(true);
  });
});

describe("a passage that reaches the board edge is an exit (generator 3)", () => {
  it("places nothing outside the bounds and verify accepts the open edge", () => {
    const p = rift(3);
    const r = resolvePlan(p);
    const set = realize(r, cat);
    const outside = must(set.levels[0]).placements.filter((q) => q.role === "wall" && q.x < -0.01);
    expect(outside).toEqual([]);
    const gaps = verifyBuild(r, set, cat, { plan: p }).diagnostics.filter(
      (d) => d.code === "verify_wall_gap",
    );
    expect(gaps).toEqual([]);
  });

  it("generator 2 still builds the end caps outside the bounds", () => {
    const p = rift(2);
    const r = resolvePlan(p);
    const set = realize(r, cat);
    const outside = must(set.levels[0]).placements.filter(
      (q) => q.x < -0.01 && /Cave Wall/.test(placementMeta.get(q)?.name ?? ""),
    );
    expect(outside.length).toBeGreaterThan(0);
  });
});

describe("water is one plane (generator 3)", () => {
  const p = loadPlan("three-step-glen-v1");
  const r = resolvePlan(p);
  it("a stepped brook warns that its upper reaches stay dry, and no trail ford is called flooded", () => {
    const w = r.issues.filter((i) => i.code === "water_level");
    expect(w.some((i) => /stay dry/.test(i.message))).toBe(true);
    expect(w.some((i) => /dry floor cell/.test(i.message))).toBe(false);
  });
  it("the grid hands dressing the plane height", () => {
    expect(must(r.levels[0]).waterLevel).toBeTypeOf("number");
  });
});

describe("floors vary orientation (generator 3)", () => {
  it("1x2 cave floor pieces lie both ways", () => {
    const p = rift(3);
    const set = realize(resolvePlan(p), cat);
    const rots = new Set<number>();
    for (const q of must(set.levels[0]).placements)
      if (q.role === "floor" && /Cave Floor - Rock 04/.test(placementMeta.get(q)?.name ?? ""))
        rots.add(q.rot);
    expect([...rots].some((x) => x === 90 || x === 270)).toBe(true);
    expect([...rots].some((x) => x === 0 || x === 180)).toBe(true);
  });
});

describe("flat_map judges real depth (generator 3)", () => {
  it("fires on the heartroot cave (88% within a tile of one height), quiet on the stepped glen", () => {
    const cave = rift(3);
    expect(reviewDesign(cave, resolvePlan(cave), { limit: 99 }).map((n) => n.code)).toContain("flat_map");
    const glen = loadPlan("three-step-glen-v1");
    expect(reviewDesign(glen, resolvePlan(glen), { limit: 99 }).map((n) => n.code)).not.toContain("flat_map");
  });
});
