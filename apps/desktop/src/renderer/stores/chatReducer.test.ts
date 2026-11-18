import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/ipc";
import type { ChatItem } from "../../main/agent/provider/types";
import { answersFor, chatReducer, emptyChat, pendingQuestions, type ChatState } from "./chatReducer";

const sel = { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" as const };
const user: ChatItem = { type: "user", id: "u1", text: "Draw a crypt", createdAt: "2026-11-18T10:00:00Z" };
const asst = (id: string, text: string, turnId = "t1"): ChatItem => ({
  type: "assistant",
  id,
  turnId,
  parts: [{ type: "text", text }],
  stopReason: "end_turn",
  servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
  createdAt: "2026-11-18T10:00:05Z",
});

function run(events: ChatEvent[], start: ChatState = emptyChat()): ChatState {
  return events.reduce((s, e) => chatReducer(s, e, 1000), start);
}

describe("chatReducer", () => {
  it("streams text deltas into the live turn and clears them when the step's assistant item lands", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      { type: "item_appended", turnId: "t1", item: user },
      {
        type: "step_started",
        turnId: "t1",
        step: 0,
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      },
      { type: "text_delta", turnId: "t1", step: 0, text: "A drowned " },
      { type: "text_delta", turnId: "t1", step: 0, text: "crypt." },
    ]);
    expect(s.live?.text).toBe("A drowned crypt.");
    expect(s.items.map((i) => i.id)).toEqual(["u1"]);
    const s2 = chatReducer(s, { type: "item_appended", turnId: "t1", item: asst("a1", "A drowned crypt.") });
    expect(s2.live?.text).toBe("");
    expect(s2.items.map((i) => i.id)).toEqual(["u1", "a1"]);
  });

  it("tracks tool calls, progress and the new plan version", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      { type: "tool_call_started", turnId: "t1", step: 0, callId: "c1", name: "create_plan" },
      { type: "tool_call_progress", turnId: "t1", callId: "c1", bytes: 2048 },
      { type: "progress", turnId: "t1", step: "laying_out_level", label: "Laying out Level 1" },
    ]);
    expect(s.live?.tools[0]).toMatchObject({ callId: "c1", bytes: 2048, done: false });
    expect(s.live?.progress?.label).toBe("Laying out Level 1");
    const s2 = chatReducer(s, {
      type: "tool_call_finished",
      turnId: "t1",
      callId: "c1",
      name: "create_plan",
      ok: true,
      summary: "v1",
      newVersion: 1,
    });
    expect(s2.live?.tools[0]).toMatchObject({ done: true, ok: true, newVersion: 1 });
    expect(s2.live?.newVersions).toEqual([1]);
    expect(s2.live?.progress).toBeNull();
  });

  it("ignores events for a stale turn", () => {
    const s = run([{ type: "turn_started", turnId: "t2", selection: sel }]);
    const s2 = chatReducer(s, { type: "text_delta", turnId: "t1", step: 0, text: "old" });
    expect(s2).toBe(s);
  });

  it("moves a finished turn to `last`, marking cancel as stopped", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      { type: "text_delta", turnId: "t1", step: 0, text: "partial" },
      { type: "turn_finished", turnId: "t1", stopReason: "cancelled", canContinue: false, canRetry: true },
    ]);
    expect(s.live).toBeNull();
    expect(s.last).toMatchObject({ status: "stopped", canRetry: true, text: "" });
  });

  it("keeps the error of a failed turn for the error card", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      {
        type: "turn_failed",
        turnId: "t1",
        error: {
          code: "provider",
          message: "busy",
          provider: { kind: "overloaded", retryable: true, message: "busy" },
        },
        canRetry: true,
      },
    ]);
    expect(s.last?.status).toBe("failed");
    expect(s.last?.error?.provider?.kind).toBe("overloaded");
  });

  it("records question cards and notices", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      {
        type: "questions",
        turnId: "t1",
        callId: "q1",
        questions: [{ id: "tier", text: "Party tier?", default: "Tier 2", options: ["Tier 1", "Tier 2"] }],
      },
      { type: "notice", turnId: "t1", kind: "retrying", text: "retrying in 12s" },
    ]);
    expect(s.live?.questions?.callId).toBe("q1");
    expect(s.live?.notices).toEqual([{ kind: "retrying", text: "retrying in 12s" }]);
  });

  it("does not duplicate items appended twice (snapshot + event)", () => {
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      { type: "item_appended", turnId: "t1", item: user },
      { type: "item_appended", turnId: "t1", item: user },
    ]);
    expect(s.items).toHaveLength(1);
  });
});

describe("end-of-turn outstanding issues", () => {
  it("keeps the summary on the finished turn", () => {
    const outstanding = {
      version: 5,
      errors: 1,
      warnings: 0,
      items: [
        {
          severity: "error" as const,
          code: "opening_blocked" as const,
          message: "The east door is blocked.",
          hint: "move the stairs",
          cell: [9, 6] as const,
        },
      ],
    };
    const s = run([
      { type: "turn_started", turnId: "t1", selection: sel },
      {
        type: "turn_finished",
        turnId: "t1",
        stopReason: "end_turn",
        canContinue: false,
        canRetry: true,
        outstandingIssues: outstanding,
      },
    ]);
    expect(s.last?.outstanding).toEqual(outstanding);
  });
});

describe("question helpers", () => {
  const ask: ChatItem = {
    type: "assistant",
    id: "a1",
    turnId: "t1",
    parts: [
      {
        type: "tool_call",
        callId: "q1",
        name: "ask_questions",
        input: { questions: [{ id: "tier", text: "Tier?", default: "2", options: ["1", "2"] }] },
      },
    ],
    stopReason: "tool_use",
    servedBy: { providerId: "anthropic", modelId: "m" },
    createdAt: "x",
  };
  it("finds the open Question card until it is answered", () => {
    expect(pendingQuestions([user, ask])?.callId).toBe("q1");
    const answered: ChatItem = {
      type: "tool_results",
      id: "r1",
      turnId: "t2",
      results: [
        {
          callId: "q1",
          name: "ask_questions",
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "tier", answer: "2" }] }) }],
        },
      ],
      createdAt: "y",
    };
    expect(pendingQuestions([user, ask, answered])).toBeNull();
    expect(answersFor([user, ask, answered], "q1")).toEqual([{ id: "tier", answer: "2" }]);
  });
});
