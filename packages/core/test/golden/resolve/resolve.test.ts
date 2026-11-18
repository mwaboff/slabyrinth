/**
 * Golden snapshots of the canonical ResolvedPlan for examples A and B and every other fixture, plus determinism.
 * Update deliberately with `npm run test:golden:update` (generator changes need a new generator version, §2.7).
 */
import { describe, expect, it } from "vitest";
import { canonicalResolved, resolvePlan } from "../../../src/resolve/index";
import { allFixtures } from "./allFixtures";

const fixtures = allFixtures();

describe("resolvePlan golden snapshots", () => {
  it.each(fixtures)("%s resolves to its golden canonical form", async (name, plan) => {
    const r = resolvePlan(plan);
    await expect(canonicalResolved(r)).toMatchFileSnapshot(`__golden__/${name}.resolved.json`);
  });

  it("records the hashes of all fixtures", async () => {
    const lines = fixtures.map(([name, plan]) => `${name} ${resolvePlan(plan).hash}`).join("\n");
    await expect(lines + "\n").toMatchFileSnapshot("__golden__/hashes.txt");
  });
});

describe("determinism", () => {
  it.each(fixtures)("%s: resolving twice gives identical bytes", (_name, plan) => {
    const a = canonicalResolved(resolvePlan(plan));
    const b = canonicalResolved(resolvePlan(structuredClone(plan)));
    expect(b).toBe(a);
  });

  it("does not mutate the input plan", () => {
    for (const [, plan] of fixtures) {
      const before = JSON.stringify(plan);
      resolvePlan(plan);
      expect(JSON.stringify(plan)).toBe(before);
    }
  });

  it("hash ignores nothing: changing the seed changes generated content", () => {
    const [, b] = fixtures.find(([n]) => n === "example-b") as [string, Parameters<typeof resolvePlan>[0]];
    const h1 = resolvePlan(b).hash;
    const h2 = resolvePlan({ ...b, seed: b.seed + 1 }).hash;
    expect(h2).not.toBe(h1);
  });
});

describe("worked example A (architecture §2.9)", () => {
  const plan = fixtures.find(([n]) => n === "example-a")?.[1];
  if (!plan) throw new Error("missing example-a");
  const r = resolvePlan(plan);
  const l1 = r.levels.find((l) => l.id === "l1");
  const l2 = r.levels.find((l) => l.id === "l2");
  if (!l1 || !l2) throw new Error("levels");

  it("orders levels by elevation", () => {
    expect(r.levels.map((l) => l.id)).toEqual(["l2", "l1"]);
  });
  it("routes c1 two wide through x 14–15 with archways at both ends", () => {
    const c1 = l1.areas.find((a) => a.id === "c1");
    expect(c1?.bbox).toEqual({ x: 14, y: 14, w: 2, h: 4 });
    const autos = l1.openings.filter((o) => o.id.startsWith("c1~"));
    expect(autos.map((o) => [o.kind, o.orientation, o.start, o.width])).toEqual([
      ["archway", "h", [14, 18], 2],
      ["archway", "h", [14, 14], 2],
    ]);
  });
  it("routes c2 across x 6–7 with doors", () => {
    const c2 = l1.areas.find((a) => a.id === "c2");
    expect(c2?.bbox).toEqual({ x: 6, y: 9, w: 2, h: 1 });
    expect(l1.openings.filter((o) => o.id.startsWith("c2~")).every((o) => o.kind === "door")).toBe(true);
  });
  it("puts the secret door mid-run on x = 24", () => {
    const d = l1.openings.find((o) => o.id === "d_secret");
    expect(d).toMatchObject({ orientation: "v", start: [24, 9], width: 1, sides: ["hall", "ossuary"] });
  });
  it("runs the stairs over 3 cells and cuts the stairwell above", () => {
    const s = r.links[0];
    expect(s?.lowerCells).toEqual([
      [26, 11],
      [26, 10],
      [26, 9],
    ]);
    expect(s?.arrival).toEqual([26, 8]);
    for (const [x, y] of s?.upperCells ?? []) {
      expect((l1.cells.flags[y * 30 + x] as number) & 0b11).toBe(0b11);
    }
  });
  it("merges the landing openly into the cave (both perimeter)", () => {
    const ai = l2.areaIds.indexOf("landing") + 1;
    const ci = l2.areaIds.indexOf("cistern") + 1;
    let shared = 0;
    for (let i = 0; i < l2.vEdges.kind.length; i++) {
      const lx = i % 31;
      const ly = Math.floor(i / 31);
      if (lx === 0 || lx === 30) continue;
      const a = l2.cells.area[ly * 30 + lx - 1];
      const b = l2.cells.area[ly * 30 + lx];
      if ((a === ai && b === ci) || (a === ci && b === ai)) {
        shared++;
        expect(l2.vEdges.kind[i]).toBe(0);
      }
    }
    expect(shared).toBeGreaterThan(0);
  });
  it("raises the dais 0.5 with a ledge", () => {
    expect(l2.cells.height[11 * 30 + 3]).toBe(2);
    expect(l2.vEdges.kind.some((k) => k === 3)).toBe(true);
  });
  it("has no resolution errors", () => {
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("worked example B (architecture §2.10)", () => {
  const plan = fixtures.find(([n]) => n === "example-b")?.[1];
  if (!plan) throw new Error("missing example-b");
  const r = resolvePlan(plan);
  const g = r.levels[0];
  if (!g) throw new Error("level");
  it("hosts the ruin's exterior walls on the grass side (full 8×7 interior)", () => {
    const W = g.bounds.w;
    // north wall of the ruin: horizontal edges y = 11, x 18..25 → host 0 (north, grass)
    for (let x = 18; x < 26; x++)
      expect([g.hEdges.kind[11 * W + x], g.hEdges.host[11 * W + x]]).toEqual([1, 0]);
    expect(g.areas.find((a) => a.id === "ruin")?.cellCount).toBe(56);
  });
  it("removes three edges of the east wall (breach)", () => {
    const W1 = g.bounds.w + 1;
    expect([13, 14, 15].map((y) => g.vEdges.kind[y * W1 + 26])).toEqual([0, 0, 0]);
    expect(g.vEdges.kind[12 * W1 + 26]).toBe(1);
  });
  it("keeps the clearing zone semantic (no walls, own key)", () => {
    expect(g.areas.find((a) => a.id === "clearing")).toMatchObject({ kind: "zone", key: "2" });
  });
  it("generates trees outside the clearing and off water/paths", () => {
    const trees = g.features.filter((f) => f.generatedBy === "trees");
    expect(trees.length).toBeGreaterThan(100);
    for (const t of trees) {
      const i = t.at[1] * g.bounds.w + t.at[0];
      expect((g.cells.flags[i] as number) & (4 | 8)).toBe(0);
      expect(g.cells.area[i]).toBe(0);
    }
  });
});
