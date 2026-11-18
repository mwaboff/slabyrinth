import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, toolsForConversation } from "@slabyrinth/core/agent";
import { RECORDED_TRANSCRIPT } from "../../testing/fixtures";
import { requestShapeViolations } from "../../testing/invariants";
import type { ChatItem, StepRequest } from "../types";
import { BetaFlags } from "./betas";
import { modelSpec } from "./models";
import { buildRequest, renderMessages, replayableContent, selectionTag, type RenderOptions } from "./render";

const OPTS: RenderOptions = {
  modelId: "claude-opus-5-5",
  perMessageEffort: true,
  systemMessages: true,
  toolMode: "native",
};

function request(transcript: ChatItem[], over: Partial<StepRequest> = {}): StepRequest {
  return {
    conversationId: "c",
    turnId: "t",
    selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
    systemPrompt: SYSTEM_PROMPT,
    tools: toolsForConversation(true),
    transcript,
    maxOutputTokens: 64000,
    effort: "medium",
    toolMode: "native",
    ...over,
  };
}

describe("renderMessages (recorded fixture)", () => {
  const messages = renderMessages(RECORDED_TRANSCRIPT, OPTS);

  it("produces the expected roles and merges", () => {
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "assistant",
      "user",
      "system",
      "assistant",
      // The marker recorded right after a reply is placed after the next user message, not after the assistant.
      "user",
      "system",
    ]);
  });

  it("merges the session context with the effort marker into one system message", () => {
    expect(messages[1]).toEqual({
      role: "system",
      content: [{ type: "text", text: 'Installed themes: stone_dungeon "Stone dungeon".\nPlan: none yet.' }],
      output_config: { effort: "high" },
    });
    expect(messages[9]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
  });

  it("replays thinking signatures and compaction blocks verbatim", () => {
    const a1 = RECORDED_TRANSCRIPT[3];
    expect(a1?.type === "assistant" && messages[2]?.content).toEqual(
      a1?.type === "assistant" ? a1.providerState?.raw : null,
    );
    expect(JSON.stringify(messages[7])).toContain(
      '"type":"compaction","content":"Summary of the earlier conversation.","encrypted_content":"enc","signature":"sig-c"',
    );
  });

  it("applies the fallback replay rule: only text survives before the final fallback block", () => {
    const content = messages[4]?.content as Array<{ type: string; id?: string }>;
    expect(content.map((b) => b.type)).toEqual(["text", "fallback", "thinking", "tool_use"]);
    expect(content.some((b) => b.id === "toolu_declined")).toBe(false);
  });

  it("puts tool results first in a merged user message, then the selection and text", () => {
    const content = messages[3]?.content as Array<{ type: string; text?: string }>;
    expect(content.map((b) => b.type)).toEqual(["tool_result", "text", "text"]);
    expect(content[1]?.text).toBe('<selection level="l1" areas="hall" rect="2,3 4x4"/>');
    expect(messages[5]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: [{ type: "text", text: "no_plan" }],
          is_error: true,
        },
      ],
    });
  });

  it("never sends excluded (stopped/refused) output", () => {
    expect(JSON.stringify(messages)).not.toContain("Partial…");
  });

  it("is byte-stable and append-only: re-rendering a longer transcript keeps the earlier bytes", () => {
    const again = JSON.stringify(renderMessages(structuredClone(RECORDED_TRANSCRIPT), OPTS));
    expect(again).toBe(JSON.stringify(messages));
    const longer: ChatItem[] = [
      ...RECORDED_TRANSCRIPT,
      {
        type: "assistant",
        id: "a5",
        turnId: "t4",
        parts: [],
        stopReason: "end_turn",
        servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
        providerState: {
          providerId: "anthropic",
          modelId: "claude-opus-5-5",
          raw: [{ type: "text", text: "You're welcome." }],
        },
        createdAt: "x",
      },
      { type: "user", id: "u4", text: "Next", createdAt: "x" },
    ];
    const prefix = JSON.stringify(renderMessages(longer, OPTS).slice(0, messages.length));
    expect(prefix).toBe(JSON.stringify(messages));
  });

  it("keeps other models' thinking blocks when switching (the API drops what it can't read)", () => {
    const onFable = renderMessages(RECORDED_TRANSCRIPT, { ...OPTS, modelId: "claude-fable-5-2" });
    expect(JSON.stringify(onFable)).toContain("sig-opus-1");
    // Markers recorded for another model render nothing.
    expect(onFable.filter((m) => m.role === "system").every((m) => !("output_config" in m))).toBe(true);
  });

  it("strip-and-retry recovery drops every thinking block and nothing else", () => {
    const stripped = JSON.stringify(renderMessages(RECORDED_TRANSCRIPT, { ...OPTS, stripThinking: true }));
    expect(stripped).not.toContain('"type":"thinking"');
    expect(stripped).toContain("toolu_02");
  });

  it("renders context as tagged user text where system messages are unavailable", () => {
    const m = renderMessages(RECORDED_TRANSCRIPT, {
      ...OPTS,
      systemMessages: false,
      perMessageEffort: false,
    });
    expect(m.some((x) => x.role === "system")).toBe(false);
    expect(JSON.stringify(m)).toContain('<app_context reason=\\"session_start\\">');
  });

  it("rebuilds turns from other providers from neutral parts with safe ids", () => {
    const m = renderMessages(
      [
        { type: "user", id: "u", text: "hi", createdAt: "x" },
        {
          type: "assistant",
          id: "a",
          turnId: "t",
          parts: [
            { type: "reasoning", text: "r" },
            { type: "tool_call", callId: "call:1/x", name: "view_plan", input: { format: "outline" } },
          ],
          stopReason: "tool_use",
          servedBy: { providerId: "lmstudio", modelId: "qwen" },
          createdAt: "x",
        },
      ],
      OPTS,
    );
    expect(m[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1_x", name: "view_plan", input: { format: "outline" } }],
    });
  });

  it("selectionTag lists only what is selected", () => {
    expect(
      selectionTag({ levelId: "l2", areaIds: [], featureIds: ["abbot"], openingIds: [], linkIds: [] }),
    ).toBe('<selection level="l2" features="abbot"/>');
  });

  it("replayableContent is a no-op without fallback blocks", () => {
    const raw = [
      { type: "thinking", signature: "s" },
      { type: "tool_use", id: "x" },
    ];
    expect(replayableContent(raw)).toEqual(raw);
  });
});

describe("placement of system entries (review item 2)", () => {
  const sel = { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "high" } as const;
  const T = "t";

  it("a marker recorded while a question card was pending lands after the answers, not between tool_use and tool_result", () => {
    const tr: ChatItem[] = [
      { type: "user", id: "u1", text: "hi", createdAt: T },
      {
        type: "assistant",
        id: "a1",
        turnId: "t1",
        parts: [{ type: "tool_call", callId: "q1", name: "ask_questions", input: {} }],
        stopReason: "tool_use",
        servedBy: sel,
        createdAt: T,
      },
      { type: "marker", id: "m1", kind: "selection_changed", selection: sel, createdAt: T },
      {
        type: "tool_results",
        id: "r1",
        turnId: "t2",
        results: [
          { callId: "q1", name: "ask_questions", isError: false, content: [{ type: "text", text: "{}" }] },
        ],
        createdAt: T,
      },
      { type: "user", id: "u2", text: "small", createdAt: T },
    ];
    const m = renderMessages(tr, OPTS);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(m[3]).toEqual({ role: "system", content: [], output_config: { effort: "high" } });
    expect(requestShapeViolations(m)).toEqual([]);
  });

  it("context recorded right after an assistant message waits for the next user message", () => {
    const tr: ChatItem[] = [
      { type: "user", id: "u1", text: "hi", createdAt: T },
      {
        type: "assistant",
        id: "a1",
        turnId: "t1",
        parts: [{ type: "text", text: "hello" }],
        stopReason: "end_turn",
        servedBy: sel,
        createdAt: T,
      },
      { type: "context", id: "c1", reason: "plan_changed", text: "v2 now", createdAt: T },
      { type: "user", id: "u2", text: "next", createdAt: T },
    ];
    const m = renderMessages(tr, OPTS);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(requestShapeViolations(m)).toEqual([]);
    const noSys = renderMessages(tr, { ...OPTS, systemMessages: false });
    expect(noSys.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(noSys[2])).toContain("app_context");
  });

  it("the recorded fixture renders a valid request", () => {
    expect(requestShapeViolations(renderMessages(RECORDED_TRANSCRIPT, OPTS))).toEqual([]);
  });

  it("the invariant checker catches the old bad shapes", () => {
    expect(
      requestShapeViolations([
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "ask_questions", input: {} }] },
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "q1" }] },
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe("buildRequest", () => {
  const base = {
    flags: new BetaFlags(),
    effortSupported: true,
    cacheTtl: "5m" as const,
    bindingBehavior: "drop_block" as const,
  };

  it("Opus 5.5: all betas, fallbacks default, adaptive summarized thinking, per-message effort, 1h system + 5m tail", () => {
    const { params, features } = buildRequest(request(RECORDED_TRANSCRIPT), {
      ...base,
      spec: modelSpec("claude-opus-5-5"),
    });
    expect(features).toEqual(["fallbacks", "bindingControls", "compaction", "perMessageEffort"]);
    expect(params.betas).toEqual([
      "server-side-fallback-2026-07-01",
      "thinking-binding-controls-2026-08-01",
      "compact-2026-01-12",
      "mid-conversation-output-config-2026-07-01",
    ]);
    expect(params.fallbacks).toBe("default");
    expect(params.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(params.output_config).toBeUndefined();
    expect(params.context_management).toEqual({ edits: [{ type: "compact_20260112" }] });
    expect(params.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(params.tools?.every((t) => "eager_input_streaming" in t && t.eager_input_streaming === true)).toBe(
      true,
    );
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("temperature");
  });

  it("Haiku 5.5 gets no fallbacks", () => {
    const { params } = buildRequest(
      request([], { selection: { providerId: "anthropic", modelId: "claude-haiku-5-5", effort: "low" } }),
      { ...base, spec: modelSpec("claude-haiku-5-5") },
    );
    expect(params.fallbacks).toBeUndefined();
    expect(params.betas).not.toContain("server-side-fallback-2026-07-01");
  });

  it("with every beta off the core request still works: top-level effort, no betas", () => {
    const flags = new BetaFlags(["fallbacks", "bindingControls", "compaction", "perMessageEffort"]);
    const { params } = buildRequest(request(RECORDED_TRANSCRIPT), {
      ...base,
      flags,
      spec: modelSpec("claude-opus-5-5"),
    });
    expect(params.betas).toBeUndefined();
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(JSON.stringify(params.messages)).not.toContain("output_config");
  });

  it("JSON tool mode embeds the protocol in the system prompt and sends no tools", () => {
    const { params } = buildRequest(request([], { toolMode: "json" }), {
      ...base,
      spec: modelSpec("claude-opus-5-5"),
    });
    expect(params.tools).toBeUndefined();
    expect(JSON.stringify(params.system)).toContain("Reply with exactly one JSON object");
  });

  it("clamps max_tokens to the model limit", () => {
    const { params } = buildRequest(request([], { maxOutputTokens: 500_000 }), {
      ...base,
      spec: modelSpec("claude-opus-5-5"),
    });
    expect(params.max_tokens).toBe(128_000);
  });
});
