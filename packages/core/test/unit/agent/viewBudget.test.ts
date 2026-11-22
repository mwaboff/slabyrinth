/**
 * Every model-facing tool result stays bounded at the plan size limit. The ASCII view is the one whose size grows with
 * the map's area: a crop over MAX_VIEW_CELLS (160 × 160, the largest level before the limit rose to 320) is drawn as
 * an overview of cell blocks, so no result costs more than the old worst case; a crop within it is drawn exactly as
 * before (outline, json and the preview are capped by element counts and their own budgets).
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { PLAN_LIMITS } from "../../../src/contracts/plan";
import { createToolExecutor, type AgentToolContext } from "../../../src/agent";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { MAX_VIEW_CELLS, asciiView } from "../../../src/text";
import { largeOutdoorPlan } from "../../fixtures/largePlan";

/** The most characters one block of a tool result may hold (the old worst case, a 160 × 160 view, was ~27,000). */
const RESULT_BLOCK_BUDGET = 32_000;

const exec = createToolExecutor();
const pal = bundledPalettes();

function ctx(plan: MapPlan | null, head = 3): AgentToolContext {
  return {
    plan,
    head,
    brief: {},
    renderImage: null,
    estimate: (p) => ({
      perLevel: p.levels.map((l) => ({ levelId: l.id, assets: 12, estimatedChunks: 1 })),
      totalAssets: 12,
      estimatedChunks: 1,
      diagnostics: [],
    }),
    catalog: { themes: [{ id: "outdoor", name: "Outdoor" }], featureCoverage: () => ({}) },
    newSeed: () => 1234,
    newPlanId: () => "00000000-0000-4000-8000-000000000001",
    palettes: pal,
    nextVersion: 4,
  };
}

const blocks = (o: { content: Array<{ type: string; text?: string }> }): string[] =>
  o.content.map((c) => c.text ?? "");

function authored(plan: MapPlan): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...plan };
  delete rest["schema"];
  delete rest["generator"];
  delete rest["id"];
  return rest;
}

describe("tool results stay within the view budget at the plan size limit", () => {
  it("a level at the side limit: no block of any result is over the budget; the ASCII view is an overview", async () => {
    const side = PLAN_LIMITS.levelSide;
    const plan = largeOutdoorPlan(side);
    const calls: Array<[string, unknown, AgentToolContext]> = [
      ["create_plan", { replace: false, summary: "x", plan: authored(plan) }, ctx(null, 0)],
      ["view_plan", { format: "ascii" }, ctx(plan)],
      ["view_plan", { format: "ascii", region: { x: 0, y: 0, w: side, h: side } }, ctx(plan)],
      ["view_plan", { format: "outline" }, ctx(plan)],
      ["view_plan", { format: "json" }, ctx(plan)],
      ["compile_preview", {}, ctx(plan)],
    ];
    for (const [name, input, c] of calls) {
      const out = await exec(c, name, input);
      expect(out.ok, name).toBe(true);
      for (const b of blocks(out)) expect(b.length, name).toBeLessThanOrEqual(RESULT_BLOCK_BUDGET);
    }
    const ascii = blocks(await exec(ctx(plan), "view_plan", { format: "ascii" })).join("\n");
    expect(ascii).toMatch(/overview: level crop is 320×320 cells.*1 char = 2×2 cells/);
    expect(ascii).toMatch(/region of at most 160×160 cells/);
  }, 60_000);

  it("a crop of at most MAX_VIEW_CELLS cells is drawn cell by cell, as before the limit rose", () => {
    const plan = largeOutdoorPlan(PLAN_LIMITS.levelSide);
    const resolved = resolvePlan(plan, pal);
    const full = asciiView(resolved, "g", { region: { x: 0, y: 0, w: 160, h: 160 } });
    expect(160 * 160).toBe(MAX_VIEW_CELLS);
    expect(full).not.toMatch(/overview/);
    expect(full).toMatch(/1 char per cell/);
    const over = asciiView(resolved, "g", { region: { x: 0, y: 0, w: 161, h: 160 } });
    expect(over).toMatch(/overview/);
    expect(over.length).toBeLessThan(full.length + 200);
  });
});
