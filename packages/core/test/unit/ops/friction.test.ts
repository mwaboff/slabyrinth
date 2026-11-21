/**
 * Tool friction seen in real runs: a dress op with no area dresses the whole level (generator 2), generated
 * features can be removed by the id a result showed ("rocks#5"), and a remove op takes a filter.
 */
import { describe, expect, it } from "vitest";
import "../../../src/resolve/autoregister";
import type { MapPlan, TerrainOp } from "../../../src/contracts/plan";
import { applyOps } from "../../../src/ops";
import { validatePlan } from "../../../src/plan";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { designReviewDelta, type DesignNote } from "../../../src/review";

function meadow(terrain: TerrainOp[], generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "fr",
    title: "Friction",
    kind: "outdoor",
    theme: "outdoor",
    seed: 3,
    links: [],
    levels: [
      {
        id: "g",
        name: "G",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 30, h: 20 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
      },
    ],
  };
}
const rocks: TerrainOp = { id: "rocks", op: "scatter", feature: "boulder", density: 0.08, minSpacing: 2 };

describe("dress with no area", () => {
  it("dresses the whole level on generator 2 (no area, or the level id)", () => {
    for (const area of [undefined, "g"]) {
      const op = { id: "wood", op: "dress", preset: "woodland", ...(area ? { area } : {}) } as TerrainOp;
      const p = meadow([op]);
      expect(validatePlan(p).issues.filter((i) => i.severity === "error")).toEqual([]);
      const l = resolvePlan(p, bundledPalettes()).levels[0];
      expect(l?.features.filter((f) => f.generatedBy === "wood").length).toBeGreaterThan(10);
    }
  });
  it("is an error with a plain hint on generator 1, and an unknown area names the way out", () => {
    const p1 = meadow([{ id: "wood", op: "dress", preset: "woodland" }], 1);
    const e1 = validatePlan(p1).issues.find((i) => i.severity === "error");
    expect(e1?.hint).toContain("area");
    const p2 = meadow([{ id: "wood", op: "dress", area: "l1", preset: "woodland" }]);
    const e2 = validatePlan(p2).issues.find((i) => i.code === "ref_unknown");
    expect(e2?.hint).toContain("leave area out to dress the whole level");
  });
});

describe("removing generated features", () => {
  it("accepts the id a result showed (rocks#3): the op is materialized and that piece removed", () => {
    const p = meadow([rocks]);
    const before =
      resolvePlan(p, bundledPalettes()).levels[0]?.features.filter((f) => f.generatedBy === "rocks") ?? [];
    expect(before.length).toBeGreaterThan(3);
    const r = applyOps(p, [{ op: "remove", ids: ["rocks#3"] }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const feats = r.plan.levels[0]?.features ?? [];
    expect(feats.length).toBe(before.length - 1);
    expect(feats.some((f) => f.id === "rocks_3")).toBe(false);
    expect(r.plan.levels[0]?.terrain.some((t) => t.id === "rocks")).toBe(false);
  });
  it("removes by filter in one op: every generated piece of an op inside a rect", () => {
    const p = meadow([rocks]);
    const all =
      resolvePlan(p, bundledPalettes()).levels[0]?.features.filter((f) => f.generatedBy === "rocks") ?? [];
    const rect = { x: 0, y: 0, w: 15, h: 20 };
    const inside = all.filter((f) => f.at[0] < 15).length;
    const r = applyOps(p, [{ op: "remove", ids: [], where: { generatedBy: "rocks", rect } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const left = r.plan.levels[0]?.features ?? [];
    expect(left.length).toBe(all.length - inside);
    expect(left.every((f) => f.at[0] >= 15)).toBe(true);
  });
});

describe("review delta", () => {
  const note = (code: DesignNote["code"], msg: string): DesignNote => ({
    code,
    levelId: "g",
    score: 1,
    message: msg,
    action: "do it",
  });
  it("shows new notes in full, open ones short and cleared ones by code", () => {
    const prev = [note("flat_map", "flat"), note("dead_space", "empty")];
    const now = [note("flat_map", "still flat"), note("bare_ground", "bare")];
    const t = designReviewDelta(now, prev);
    expect(t).toContain("DESIGN REVIEW");
    expect(t).toContain("[bare_ground] level g: bare → do it");
    expect(t).toContain("still open: [flat_map] still flat");
    expect(t).toContain("cleared: dead_space");
    expect(designReviewDelta(now, undefined)).toContain("[flat_map] level g: still flat → do it");
  });
});
