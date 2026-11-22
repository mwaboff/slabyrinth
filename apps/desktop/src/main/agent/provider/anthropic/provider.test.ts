import { describe, expect, it } from "vitest";
import { APIConnectionError, APIError, AnthropicError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import { SYSTEM_PROMPT, toolsForConversation, INVALID_JSON_KEY } from "@slabyrinth/core/agent";
import type { StepEvent, StepRequest } from "../types";
import { AnthropicProvider, accountUsage, type AnthropicClientLike, type StreamLike } from "./provider";
import { mapAnthropicError } from "./errors";
import { modelSpec } from "./models";

// ───────────── mocked SDK stream ─────────────

type Script =
  | { events: BetaRawMessageStreamEvent[]; final: BetaMessage }
  | { error: unknown; afterEvents?: BetaRawMessageStreamEvent[] }
  | { hang: true };

function message(
  content: unknown[],
  stop: BetaMessage["stop_reason"],
  extra: Partial<BetaMessage> = {},
): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 },
      iterations: null,
    },
    ...extra,
  } as unknown as BetaMessage;
}

const start = (model = "claude-opus-5-5"): BetaRawMessageStreamEvent =>
  ({ type: "message_start", message: message([], null, { model }) }) as unknown as BetaRawMessageStreamEvent;
const ev = (e: unknown): BetaRawMessageStreamEvent => e as BetaRawMessageStreamEvent;

function textEvents(text: string): BetaRawMessageStreamEvent[] {
  return [
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ev({ type: "content_block_stop", index: 0 }),
  ];
}

function toolEvents(index: number, id: string, name: string, chunks: string[]): BetaRawMessageStreamEvent[] {
  return [
    ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
    ...chunks.map((c) =>
      ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } }),
    ),
    ev({ type: "content_block_stop", index }),
  ];
}

class MockClient implements AnthropicClientLike {
  readonly params: BetaMessageStreamParams[] = [];
  constructor(
    private readonly scripts: Script[],
    private readonly models: ModelInfo[] | Error = [],
  ) {}
  stream(params: BetaMessageStreamParams, options: { signal: AbortSignal }): StreamLike {
    this.params.push(structuredClone(params));
    const script = this.scripts.shift();
    if (!script) throw new Error("no script");
    const signal = options.signal;
    let final: BetaMessage | null = null;
    return {
      async *[Symbol.asyncIterator]() {
        if ("hang" in script) {
          yield start();
          await new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(new APIUserAbortError());
            });
          });
          return;
        }
        if ("error" in script) {
          for (const e of script.afterEvents ?? []) yield e;
          throw script.error;
        }
        yield start(script.final.model);
        for (const e of script.events) yield e;
        final = script.final;
      },
      finalMessage: () => (final ? Promise.resolve(final) : Promise.reject(new Error("no final"))),
    };
  }
  async *listModels(): AsyncIterable<ModelInfo> {
    await Promise.resolve();
    if (this.models instanceof Error) throw this.models;
    for (const m of this.models) yield m;
  }
}

function provider(client: MockClient): AnthropicProvider {
  let n = 0;
  const p = new AnthropicProvider({
    createClient: () => client,
    newId: () => `item${++n}`,
    now: () => new Date(0),
  });
  p.configure({ apiKey: "sk-test" });
  return p;
}

const REQ: StepRequest = {
  conversationId: "c",
  turnId: "t1",
  selection: { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" },
  systemPrompt: SYSTEM_PROMPT,
  tools: toolsForConversation(true),
  transcript: [{ type: "user", id: "u", text: "hi", createdAt: "x" }],
  maxOutputTokens: 64000,
  effort: "medium",
  toolMode: "native",
};

const apiError = (status: number, message: string, headers: Record<string, string> = {}): APIError =>
  APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers(headers));

async function run(
  p: AnthropicProvider,
  signal = new AbortController().signal,
): Promise<{ events: StepEvent[]; result: Awaited<ReturnType<AnthropicProvider["runStep"]>> }> {
  const events: StepEvent[] = [];
  const result = await p.runStep(REQ, (e) => events.push(e), signal);
  return { events, result };
}

describe("AnthropicProvider.runStep (mocked SDK stream)", () => {
  it("streams text and normalizes a finished turn with verbatim providerState", async () => {
    const content = [
      { type: "thinking", thinking: "plan it", signature: "sig" },
      { type: "text", text: "Hello GM", citations: null },
    ];
    const client = new MockClient([{ events: textEvents("Hello GM"), final: message(content, "end_turn") }]);
    const { events, result } = await run(provider(client));
    expect(events[0]).toEqual({
      type: "started",
      servedBy: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    });
    expect(events).toContainEqual({ type: "text_delta", text: "Hello GM" });
    expect(result.stopReason).toBe("end_turn");
    expect(result.assistant?.parts).toEqual([
      { type: "reasoning", text: "plan it" },
      { type: "text", text: "Hello GM" },
    ]);
    expect(result.assistant?.providerState?.raw).toEqual(content);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 9000,
      cacheWriteTokens: 400,
    });
    // $4 in, $20 out, $0.20 read, $5 5m write per MTok.
    expect(result.cost?.amount).toBeCloseTo((100 * 4 + 50 * 20 + 9000 * 0.2 + 400 * 5) / 1e6, 9);
  });

  it("tool calls: streamed deltas, strict re-parse of the raw input, invalid JSON marked for the executor", async () => {
    const content = [
      { type: "tool_use", id: "toolu_a", name: "view_plan", input: { format: "outline" } },
      { type: "tool_use", id: "toolu_b", name: "edit_plan", input: { baseVersion: 1 } },
    ];
    const events = [
      ...toolEvents(0, "toolu_a", "view_plan", ['{"format":', '"outline"}']),
      ...toolEvents(1, "toolu_b", "edit_plan", ['{"baseVersion":1,"summary":"x', '","ops":[{"op"']),
    ];
    const client = new MockClient([{ events, final: message(content, "tool_use") }]);
    const out = await run(provider(client));
    expect(out.events.filter((e) => e.type === "tool_call_delta")).toHaveLength(4);
    expect(out.result.stopReason).toBe("tool_use");
    const calls = out.result.assistant?.parts.filter((p) => p.type === "tool_call");
    expect(calls?.[0]).toMatchObject({ callId: "toolu_a", input: { format: "outline" } });
    expect(calls?.[1]).toMatchObject({
      callId: "toolu_b",
      input: { [INVALID_JSON_KEY]: '{"baseVersion":1,"summary":"x","ops":[{"op"' },
    });
  });

  it("refusal: stop_reason checked first, output display-only, details returned", async () => {
    const final = message([{ type: "text", text: "I can't", citations: null }], "refusal", {
      stop_details: { type: "refusal", category: "cyber", explanation: "policy" },
    } as unknown as Partial<BetaMessage>);
    const client = new MockClient([{ events: textEvents("I can't"), final }]);
    const { events, result } = await run(provider(client));
    expect(result.stopReason).toBe("refusal");
    expect(result.refusal).toEqual({ category: "cyber", explanation: "policy" });
    expect(result.assistant?.excludedFromContext).toBe(true);
    // the notice about how the turn ended is the engine's alone
    expect(events.some((e) => e.type === "notice" && e.kind === "refusal")).toBe(false);
  });

  it("refusal before any output yields no assistant item", async () => {
    const client = new MockClient([{ events: [], final: message([], "refusal") }]);
    const { result } = await run(provider(client));
    expect(result.assistant).toBeUndefined();
  });

  it("max_tokens and pause_turn map to neutral stop reasons", async () => {
    const client = new MockClient([
      {
        events: [],
        final: message([{ type: "tool_use", id: "t", name: "edit_plan", input: {} }], "max_tokens"),
      },
      { events: [], final: message([{ type: "text", text: "…" }], "pause_turn") },
      { events: [], final: message([{ type: "text", text: "…" }], "model_context_window_exceeded") },
    ]);
    const p = provider(client);
    expect((await run(p)).result.stopReason).toBe("max_tokens");
    expect((await run(p)).result.stopReason).toBe("pause");
    expect((await run(p)).result.stopReason).toBe("max_tokens");
  });

  it("server-side fallback: notice, servedBy the fallback model, per-attempt pricing", async () => {
    const content = [
      { type: "text", text: "Here", citations: null },
      {
        type: "fallback",
        from: { model: "claude-opus-5-5" },
        to: { model: "claude-opus-4-8" },
        trigger: { type: "refusal" },
      },
      { type: "text", text: " is the plan", citations: null },
    ];
    const final = message(content, "end_turn", { model: "claude-opus-4-8" });
    (final.usage as unknown as { iterations: unknown[] }).iterations = [
      {
        type: "message",
        model: "claude-opus-5-5",
        input_tokens: 1000,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
      },
      {
        type: "fallback_message",
        model: "claude-opus-4-8",
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
      },
    ];
    const events = [ev({ type: "content_block_start", index: 1, content_block: content[1] })];
    const client = new MockClient([{ events, final }]);
    const { events: out, result } = await run(provider(client));
    expect(out.some((e) => e.type === "notice" && e.kind === "fallback")).toBe(true);
    expect(result.assistant?.servedBy.modelId).toBe("claude-opus-4-8");
    expect(result.usage.attempts?.map((a) => a.modelId)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    expect(result.cost?.amount).toBeCloseTo((1000 * 4 + 10 * 20 + 1000 * 5 + 100 * 25) / 1e6, 9);
  });

  it("beta auto-disable: a 400 naming a beta turns that flag off and retries once without it", async () => {
    const final = message([{ type: "text", text: "ok" }], "end_turn");
    const client = new MockClient([
      { error: apiError(400, "fallbacks: Extra inputs are not permitted") },
      { error: apiError(400, "Unexpected value(s) `compact-2026-01-12` for the `anthropic-beta` header.") },
      { events: [], final },
    ]);
    const p = provider(client);
    const { result } = await run(p);
    expect(result.stopReason).toBe("end_turn");
    expect(client.params[0]?.fallbacks).toBe("default");
    expect(client.params[1]?.fallbacks).toBeUndefined();
    expect(client.params[2]?.context_management).toBeUndefined();
    expect(client.params[2]?.betas).not.toContain("compact-2026-01-12");
    expect(p.flags.disabledList()).toEqual(["compaction", "fallbacks"]);
  });

  it("a 400 that names no beta is an invalid_request error (not retried)", async () => {
    const client = new MockClient([{ error: apiError(400, "messages: roles must alternate") }]);
    await expect(run(provider(client))).rejects.toMatchObject({
      info: { kind: "invalid_request", retryable: false, httpStatus: 400 },
    });
  });

  it("history-check 400: strips thinking once and retries", async () => {
    const client = new MockClient([
      {
        error: apiError(
          400,
          "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
        ),
      },
      { events: [], final: message([], "end_turn") },
    ]);
    const p = provider(client);
    await run(p);
    expect(client.params).toHaveLength(2);
  });

  it("re-issues the step when the SDK cannot parse tool JSON (cap 2), then fails as malformed_output", async () => {
    const parseErr = (): AnthropicError =>
      new AnthropicError("Unable to parse tool parameter JSON from model. Please retry your request.");
    const ok = new MockClient([{ error: parseErr() }, { events: [], final: message([], "end_turn") }]);
    expect((await run(provider(ok))).result.stopReason).toBe("end_turn");
    const bad = new MockClient([{ error: parseErr() }, { error: parseErr() }, { error: parseErr() }]);
    await expect(run(provider(bad))).rejects.toMatchObject({ info: { kind: "malformed_output" } });
  });

  it("rate limit and overload map to retryable kinds with retry-after", async () => {
    const rl = new MockClient([
      { error: apiError(429, "slow down", { "retry-after": "7", "request-id": "req_1" }) },
    ]);
    await expect(run(provider(rl))).rejects.toMatchObject({
      info: { kind: "rate_limit", retryable: true, retryAfterMs: 7000 },
    });
    const ol = new MockClient([{ error: apiError(529, "overloaded") }]);
    await expect(run(provider(ol))).rejects.toMatchObject({ info: { kind: "overloaded", retryable: true } });
  });

  it("cancel: aborting mid-stream rejects with kind cancelled", async () => {
    const client = new MockClient([{ hang: true }]);
    const ac = new AbortController();
    const pending = run(provider(client), ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 5);
    await expect(pending).rejects.toMatchObject({ info: { kind: "cancelled" } });
  });

  it("without a key, runStep fails with auth", async () => {
    const p = new AnthropicProvider({ createClient: () => new MockClient([]) });
    await expect(p.runStep(REQ, () => undefined, new AbortController().signal)).rejects.toMatchObject({
      info: { kind: "auth" },
    });
  });
});

describe("review fixes (adapter)", () => {
  it("7: an SSE error event (APIError without a status) maps on its error type and is retryable", () => {
    const sse = (type: string): APIError =>
      new APIError(
        undefined,
        { type: "error", error: { type, message: type } },
        undefined,
        new Headers(),
        type as never,
      );
    expect(mapAnthropicError(sse("overloaded_error"))).toMatchObject({ kind: "overloaded", retryable: true });
    expect(mapAnthropicError(sse("api_error"))).toMatchObject({ kind: "server", retryable: true });
    expect(mapAnthropicError(sse("rate_limit_error"))).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapAnthropicError(sse("invalid_request_error"))).toMatchObject({
      kind: "invalid_request",
      retryable: false,
    });
    expect(mapAnthropicError(sse("something_new_error"))).toMatchObject({ kind: "network", retryable: true });
    // Type only in the body (no `type` argument).
    const bodyOnly = new APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "x" } },
      undefined,
      new Headers(),
    );
    expect(mapAnthropicError(bodyOnly).kind).toBe("overloaded");
  });

  it("7: a mid-stream overloaded error surfaces as retryable from runStep", async () => {
    const sse = new APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      new Headers(),
      "overloaded_error",
    );
    const client = new MockClient([{ error: sse, afterEvents: [start()] }]);
    await expect(run(provider(client))).rejects.toMatchObject({
      info: { kind: "overloaded", retryable: true },
    });
  });

  it("10: usage streamed by a re-issued attempt is added to the step; a failing attempt reports it as an event", async () => {
    const parseErr = new AnthropicError("Unable to parse tool parameter JSON from model.");
    const delta = ev({
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage: { output_tokens: 30 },
    });
    const client = new MockClient([
      { error: parseErr, afterEvents: [start(), delta] },
      { events: [], final: message([{ type: "text", text: "ok", citations: null }], "end_turn") },
    ]);
    const { events, result } = await run(provider(client));
    // start() carries 100 in / 9000 read / 400 write; the partial output was 30.
    expect(result.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 18000,
      cacheWriteTokens: 800,
    });
    expect(result.cost?.amount).toBeCloseTo((2 * (100 * 4 + 9000 * 0.2 + 400 * 5) + (50 + 30) * 20) / 1e6, 9);
    expect(events.filter((e) => e.type === "usage")[0]).toMatchObject({ usage: { outputTokens: 30 } });

    const failing = new MockClient([{ error: apiError(529, "overloaded"), afterEvents: [start(), delta] }]);
    const seen: StepEvent[] = [];
    await expect(
      provider(failing).runStep(REQ, (e) => seen.push(e), new AbortController().signal),
    ).rejects.toBeTruthy();
    expect(seen.filter((e) => e.type === "usage")).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 9000, cacheWriteTokens: 400 },
      },
    ]);
  });

  it("never sends a configured base URL to the SDK client", async () => {
    const seen: unknown[] = [];
    const p = new AnthropicProvider({
      createClient: (cfg) => {
        seen.push(cfg);
        return new MockClient([{ events: [], final: message([], "end_turn") }]);
      },
    });
    p.configure({ apiKey: "sk-test", baseUrl: "https://evil.example" });
    await p.runStep(REQ, () => undefined, new AbortController().signal);
    expect(seen).toEqual([{ apiKey: "sk-test" }]);
  });
});

describe("error mapping (most specific first)", () => {
  it.each([
    [401, "auth"],
    [402, "permission"],
    [403, "permission"],
    [404, "not_found"],
    [413, "context_overflow"],
    [429, "rate_limit"],
    [500, "server"],
    [529, "overloaded"],
  ])("%i → %s", (status, kind) => {
    expect(mapAnthropicError(apiError(status, "x")).kind).toBe(kind);
  });
  it("prompt too long → context_overflow; connection → network; abort → cancelled", () => {
    expect(
      mapAnthropicError(apiError(400, "prompt is too long: 1200000 tokens > 1000000 maximum")).kind,
    ).toBe("context_overflow");
    expect(mapAnthropicError(new APIConnectionError({ message: "reset" })).kind).toBe("network");
    expect(mapAnthropicError(new APIUserAbortError()).kind).toBe("cancelled");
  });
  it("never puts the key in the message", () => {
    const info = mapAnthropicError(apiError(401, "invalid x-api-key"));
    expect(info.message).toBe("Your API key was rejected.");
  });
});

describe("models, pricing, switching", () => {
  it("falls back to the bundled table when the Models API is unreachable", async () => {
    const p = provider(new MockClient([], new Error("offline")));
    const list = await p.listModels(new AbortController().signal);
    expect(list.map((m) => m.modelId)).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-2",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(list[0]).toMatchObject({
      source: "static",
      status: "recommended",
      effort: { supported: true, default: "medium" },
    });
  });

  it("merges the live list: missing models become unavailable, unknown ones appear without pricing", async () => {
    const live = (id: string): ModelInfo =>
      ({
        id,
        display_name: id,
        created_at: "",
        type: "model",
        deprecated_at: null,
        lifecycle: "active",
        line: null,
        retires_at: null,
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: true },
          },
          thinking: { supported: true, types: { adaptive: { supported: true } } },
          context_management: { compact_20260112: { supported: true } },
        },
      }) as unknown as ModelInfo;
    const p = provider(
      new MockClient([], [live("claude-opus-5-5"), live("claude-sonnet-5-5"), live("claude-sonnet-6")]),
    );
    const list = await p.listModels(new AbortController().signal);
    expect(list.find((m) => m.modelId === "claude-opus-5-5")).toMatchObject({
      source: "api+static",
      status: "recommended",
    });
    expect(list.find((m) => m.modelId === "claude-haiku-5-5")?.status).toBe("unavailable");
    expect(list.find((m) => m.modelId === "claude-sonnet-6")).toMatchObject({
      source: "api",
      pricing: null,
      effort: { default: "high" },
    });
  });

  it("prices Haiku's above-100K tier and 1h cache writes", () => {
    const u = accountUsage(
      {
        input_tokens: 150_000,
        output_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        iterations: null,
      } as never,
      modelSpec("claude-haiku-5-5"),
    );
    expect(u.cost?.amount).toBeCloseTo((150_000 * 0.5 + 1000 * 2.5) / 1e6, 9);
    const w = accountUsage(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
        iterations: null,
      } as never,
      modelSpec("claude-opus-5-5"),
    );
    expect(w.cost?.amount).toBeCloseTo((1000 * 8) / 1e6, 9);
  });

  it("describeSwitch: effort-only keeps the cache with per-message effort; model change resets and may drop reasoning", () => {
    const p = provider(new MockClient([]));
    const opus = { providerId: "anthropic", modelId: "claude-opus-5-5", effort: "medium" } as const;
    expect(p.describeSwitch(opus, { ...opus, effort: "high" }, 50_000)).toMatchObject({
      cacheReset: false,
      estimatedExtraCost: 0,
    });
    const toFable = p.describeSwitch(opus, { ...opus, modelId: "claude-fable-5-2" }, 50_000);
    expect(toFable).toMatchObject({ cacheReset: true, reasoningDropped: false });
    expect(toFable.estimatedExtraCost).toBeCloseTo((50_000 * 16) / 1e6 / 1.6 - (50_000 * 0.2) / 1e6, 6);
    expect(p.describeSwitch({ ...opus, modelId: "claude-fable-5-2" }, opus, 50_000).reasoningDropped).toBe(
      true,
    );
    p.flags.disable("perMessageEffort");
    expect(p.describeSwitch(opus, { ...opus, effort: "high" }, 50_000).cacheReset).toBe(true);
  });
});
