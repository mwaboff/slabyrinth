import { describe, expect, it } from "vitest";
import { DefaultProviderRegistry } from "../src/main/agent/provider/registry";
import type { StepRequest } from "../src/main/agent/provider/types";
import { ScriptedProvider, call, say, type ScriptedStep } from "../src/main/agent/testing/scriptedProvider";
import { DEFAULT_BRIEFS, formatReport, runEval } from "./agent-eval";

const PLAN = {
  title: "Room",
  kind: "dungeon",
  theme: "stone_dungeon",
  levels: [
    {
      id: "l1",
      name: "One",
      elevation: 0,
      bounds: { x: 0, y: 0, w: 8, h: 8 },
      base: { type: "solid" },
      areas: [{ id: "r1", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 4, h: 4 } }],
    },
  ],
  links: [],
};

/** Fake model: brief 1 asks a question first, brief 2 sends one invalid plan then a valid one, brief 3 refuses. */
function script(req: StepRequest): ScriptedStep {
  const users = req.transcript.filter((i) => i.type === "user");
  const first = users[0]?.type === "user" ? users[0].text : "";
  const last = req.transcript.at(-1);
  const results = last?.type === "tool_results" ? last.results : [];
  if (results.some((r) => r.name === "create_plan" && !r.isError))
    return { kind: "reply", parts: [say("Drafted.")] };
  if (first.startsWith("Q")) {
    if (users.length === 1)
      return {
        kind: "reply",
        parts: [
          call("ask_questions", {
            questions: [{ id: "q1", text: "Size?", default: "small", options: ["small", "big"] }],
          }),
        ],
      };
    return { kind: "reply", parts: [call("create_plan", { replace: false, summary: "Draft", plan: PLAN })] };
  }
  if (first.startsWith("R")) {
    const bad = !results.some((r) => r.name === "create_plan");
    return {
      kind: "reply",
      parts: [
        call("create_plan", {
          replace: false,
          summary: "Draft",
          plan: bad ? { ...PLAN, kind: "spaceship" } : PLAN,
        }),
      ],
    };
  }
  return { kind: "reply", parts: [say("No.")], stopReason: "refusal" };
}

describe("agent-eval harness (mocked provider only)", () => {
  it("reports validation error rate, retries, tokens and cost", async () => {
    const registry = new DefaultProviderRegistry([new ScriptedProvider(script)]);
    const lines: string[] = [];
    const report = await runEval({
      briefs: ["Q: a tiny room", "R: a room", "X: something"],
      selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
      registry,
      log: (l) => lines.push(l),
    });
    const [q, r, x] = report.results;
    expect(q).toMatchObject({ ok: true, createAttempts: 1, questionRounds: 1, createRejected: 0 });
    expect(r).toMatchObject({ ok: true, createAttempts: 2, createRejected: 1 });
    expect(x).toMatchObject({ ok: false, createAttempts: null });
    expect(report.summary).toMatchObject({ briefs: 3, validFirstDraftWithin2Retries: 2, retries: 1 });
    expect(report.summary.validationErrorRate).toBeCloseTo(1 / 3, 6);
    expect(report.summary.usage.outputTokens).toBeGreaterThan(0);
    expect(report.summary.cost?.amount).toBeGreaterThan(0);
    expect(formatReport(report)).toContain("First drafts valid within 2 retries: 2/3");
    expect(lines.length).toBe(6);
  });

  it("ships ten default briefs", () => {
    expect(DEFAULT_BRIEFS).toHaveLength(10);
  });
});
