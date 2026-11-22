/**
 * The view budget: every model-facing tool result stays bounded at the plan size limit. Shared by the fast unit test
 * (test/unit/agent/viewBudget.test.ts, a moderate plan) and the sweep (test/sweep/run.ts, a level at the side limit).
 */
import type { MapPlan } from "../../src/contracts/plan";
import { createToolExecutor, type AgentToolContext } from "../../src/agent";
import { bundledPalettes } from "../../src/palette";

/** The most characters one block of a tool result may hold (the old worst case, a 160 × 160 view, was ~27,000). */
export const RESULT_BLOCK_BUDGET = 32_000;

const exec = createToolExecutor();
const pal = bundledPalettes();

export function budgetCtx(plan: MapPlan | null, head = 3): AgentToolContext {
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

/**
 * Runs every tool that shows a plan (create_plan, the ASCII view whole and as a region of the first level, outline,
 * json, compile_preview) on `plan`; returns each failed call and each block over the budget, and the default ASCII
 * view's text.
 */
export async function viewBudgetRun(plan: MapPlan): Promise<{ problems: string[]; ascii: string }> {
  const b = plan.levels[0]?.bounds ?? { x: 0, y: 0, w: 1, h: 1 };
  const calls: Array<[string, unknown, AgentToolContext]> = [
    ["create_plan", { replace: false, summary: "x", plan: authored(plan) }, budgetCtx(null, 0)],
    ["view_plan", { format: "ascii" }, budgetCtx(plan)],
    ["view_plan", { format: "ascii", region: { x: b.x, y: b.y, w: b.w, h: b.h } }, budgetCtx(plan)],
    ["view_plan", { format: "outline" }, budgetCtx(plan)],
    ["view_plan", { format: "json" }, budgetCtx(plan)],
    ["compile_preview", {}, budgetCtx(plan)],
  ];
  const problems: string[] = [];
  let ascii = "";
  for (const [i, [name, input, c]] of calls.entries()) {
    const out = await exec(c, name, input);
    if (!out.ok) problems.push(`${name}: failed`);
    for (const t of blocks(out))
      if (t.length > RESULT_BLOCK_BUDGET) problems.push(`${name}: a block of ${t.length} characters`);
    if (i === 1) ascii = blocks(out).join("\n");
  }
  return { problems, ascii };
}
