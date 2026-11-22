/**
 * AnthropicProvider: the only place that knows about Anthropic (architecture §3.10). One `runStep` is one streamed
 * call to `client.beta.messages.stream(...)`, normalized to neutral events and a neutral StepResult.
 *
 * API features used, each degrading on its own:
 *  - adaptive thinking with display "summarized" (GA; thinking can't be disabled on these models);
 *  - effort via output_config.effort, or per-message effort system messages (beta, flag "perMessageEffort");
 *  - prompt caching: system prompt breakpoint with ttl 1h + automatic 5m (or 1h) tail breakpoint (GA);
 *  - eager_input_streaming on every tool (GA; inputs are validated by the executor);
 *  - server-side refusal fallback `fallbacks: "default"` (beta, flag "fallbacks"; not for Haiku);
 *  - thinking.block_binding prefix_mismatch_behavior (beta, flag "bindingControls");
 *  - server-side compaction compact_20260112 (beta, flag "compaction");
 *  - mid-conversation {role:"system"} context messages (GA on the supported models).
 * A 400 that names a beta feature disables that flag for the session and the step is retried without it.
 */
import { randomUUID } from "node:crypto";
import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import { invalidJsonInput } from "@slabyrinth/core/agent";
import { costOf, round6 } from "../../cost";
import { ProviderFailure, providerError } from "../errors";
import type {
  AssistantPart,
  ChatItem,
  ChatProvider,
  Cost,
  ModelDescriptor,
  ModelSelection,
  ProviderConfig,
  ProviderErrorInfo,
  ProviderInfo,
  StepEventSink,
  StepRequest,
  StepResult,
  StopReason,
  SwitchImpact,
  Usage,
} from "../types";
import { BETA_SPECS, BetaFlags, blamedFeature, type BetaFeature } from "./betas";
import { isToolJsonParseError, mapAnthropicError } from "./errors";
import { mergeModelList, modelSpec, pricingOf, staticDescriptors, type AnthropicModelSpec } from "./models";
import { buildRequest } from "./render";

// ───────────────────────────── client seam (mocked in tests) ─────────────────────────────

export interface StreamLike extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

export interface AnthropicClientLike {
  stream(params: BetaMessageStreamParams, options: { signal: AbortSignal }): StreamLike;
  listModels(signal: AbortSignal): AsyncIterable<ModelInfo>;
}

/**
 * Builds the SDK client. Only the key is passed: the adapter always talks to ANTHROPIC_API_BASE_URL and never
 * forwards a configured base URL or environment override (defence in depth; the settings store also drops it).
 */
export type ClientFactory = (cfg: { apiKey: string }) => AnthropicClientLike;

/** The only host the stored key is ever sent to (decisions.md "Pinned API host"). */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/**
 * Environment variables the SDK constructor reads that could redirect requests or add/replace auth headers and
 * that no explicit option can override: ANTHROPIC_CUSTOM_HEADERS is merged under `defaultHeaders` (it could set
 * `x-api-key`/`Authorization` or anything else). Hidden for the (synchronous) duration of the constructor only.
 * The others are neutralised by explicit options below: ANTHROPIC_BASE_URL (baseURL), ANTHROPIC_AUTH_TOKEN and
 * ANTHROPIC_API_KEY / ANTHROPIC_PROFILE / ANTHROPIC_CONFIG_DIR credential-chain variables (an explicit apiKey makes
 * the SDK skip them; authToken is pinned to null), ANTHROPIC_LOG (logLevel), ANTHROPIC_OPEN_TELEMETRY* (openTelemetry).
 */
const SDK_ENV_HIDDEN_AT_CONSTRUCTION = ["ANTHROPIC_CUSTOM_HEADERS"] as const;

function withEnvHidden<T>(names: readonly string[], fn: () => T): T {
  const saved = new Map<string, string>();
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined) {
      saved.set(n, v);
      Reflect.deleteProperty(process.env, n);
    }
  }
  try {
    return fn();
  } finally {
    for (const [n, v] of saved) process.env[n] = v;
  }
}

/** The real client: official SDK, SDK retries (maxRetries 2) for connect-time 408/409/429/5xx. */
export const sdkClientFactory: ClientFactory = (cfg) => {
  const client = withEnvHidden(
    SDK_ENV_HIDDEN_AT_CONSTRUCTION,
    () =>
      new Anthropic({
        apiKey: cfg.apiKey,
        authToken: null,
        webhookKey: null,
        baseURL: ANTHROPIC_API_BASE_URL,
        maxRetries: 2,
        logLevel: "warn",
        openTelemetry: false,
      }),
  );
  return {
    stream: (params, options) => client.beta.messages.stream(params, { signal: options.signal }),
    listModels: (signal) => client.models.list(undefined, { signal }),
  };
};

export interface AnthropicProviderOptions {
  createClient?: ClientFactory;
  newId?: () => string;
  now?: () => Date;
  /** Diagnostics (never prompts or keys). */
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface AnthropicOptions {
  cacheTtl: "5m" | "1h";
  /** "drop_block" in production; "error" in CI/dev so an accidental history edit fails loudly. */
  bindingBehavior: "drop_block" | "error";
  disabledBetas: BetaFeature[];
}

export function parseAnthropicOptions(o: Record<string, unknown> | undefined): AnthropicOptions {
  const ttl = o?.["cacheTtl"];
  const binding = o?.["bindingBehavior"];
  const disabled = Array.isArray(o?.["disabledBetas"]) ? (o["disabledBetas"] as unknown[]) : [];
  return {
    cacheTtl: ttl === "1h" ? "1h" : "5m",
    bindingBehavior: binding === "error" ? "error" : "drop_block",
    disabledBetas: BETA_SPECS.map((s) => s.feature).filter((f) => disabled.includes(f)),
  };
}

export const ANTHROPIC_INFO: ProviderInfo = {
  id: "anthropic",
  displayName: "Anthropic (Claude)",
  nature: "Cloud · your API key",
  needsKey: true,
  hasServerUrl: false,
  modelSource: "catalog",
  hasCost: true,
  hasSpeedGuidance: true,
  available: true,
};

const MAX_JSON_REISSUES = 2;
/** Reads the live flag (defeats control-flow narrowing after an earlier check). */
const isAborted = (s: AbortSignal): boolean => s.aborted;

function mapStopReason(s: BetaMessage["stop_reason"]): StopReason {
  switch (s) {
    case "end_turn":
    case "stop_sequence":
    case null:
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
    case "compaction":
      return "pause";
    default:
      return "end_turn";
  }
}

interface Accounted {
  usage: Usage;
  cost: Cost | null;
}

/** Usage and cost of one response; with usage.iterations (fallback, compaction), each attempt at its own model's rates. */
export function accountUsage(u: BetaUsage, requested: AnthropicModelSpec | undefined): Accounted {
  const iterations = (u.iterations ?? []).filter(
    (it): it is Extract<NonNullable<BetaUsage["iterations"]>[number], { input_tokens: number }> =>
      typeof (it as { input_tokens?: unknown }).input_tokens === "number",
  );
  if (iterations.length === 0) {
    const usage: Usage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    return {
      usage,
      cost: costOf(usage, requested?.pricing ?? null, u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    };
  }
  const attempts: NonNullable<Usage["attempts"]> = [];
  let amount = 0;
  let priced = true;
  for (const it of iterations) {
    const r = it as {
      model?: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens: number } | null;
    };
    const modelId = typeof r.model === "string" ? r.model : (requested?.id ?? "unknown");
    const a = {
      modelId,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.cache_creation_input_tokens ?? 0,
    };
    attempts.push(a);
    const c = costOf(a, pricingOf(modelId), r.cache_creation?.ephemeral_1h_input_tokens ?? 0);
    if (c === null) priced = false;
    else amount += c.amount;
  }
  const usage: Usage = {
    inputTokens: attempts.reduce((s, a) => s + a.inputTokens, 0),
    outputTokens: attempts.reduce((s, a) => s + a.outputTokens, 0),
    cacheReadTokens: attempts.reduce((s, a) => s + a.cacheReadTokens, 0),
    cacheWriteTokens: attempts.reduce((s, a) => s + a.cacheWriteTokens, 0),
    attempts,
  };
  return { usage, cost: priced ? { currency: "USD", amount: round6(amount), estimated: true } : null };
}

/** Neutral parts of a response (tool calls only for blocks the API will see again on replay). */
export function partsOf(
  content: readonly BetaContentBlock[],
  rawToolJson: ReadonlyMap<number, string>,
): AssistantPart[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  const parts: AssistantPart[] = [];
  content.forEach((b, i) => {
    switch (b.type) {
      case "text":
        if (b.text.length > 0) parts.push({ type: "text", text: b.text });
        break;
      case "thinking":
        if (i > lastFallback && b.thinking.length > 0) parts.push({ type: "reasoning", text: b.thinking });
        break;
      case "tool_use": {
        if (i < lastFallback) break; // declined model's call; never replayed, never run
        const raw = rawToolJson.get(i);
        let input: unknown = b.input;
        if (raw !== undefined && raw.trim().length > 0) {
          try {
            input = JSON.parse(raw);
          } catch {
            input = invalidJsonInput(raw);
          }
        }
        parts.push({ type: "tool_call", callId: b.id, name: b.name, input });
        break;
      }
      case "fallback":
        parts.push({
          type: "notice",
          kind: "fallback",
          text: `${b.from.model} declined; ${b.to.model} continued.`,
        });
        break;
      case "compaction":
        parts.push({
          type: "notice",
          kind: "compaction",
          text: "Earlier conversation was summarized to make room.",
        });
        break;
      default:
        break;
    }
  });
  return parts;
}

/** Adds the usage (and cost) of earlier failed or re-issued attempts of the same step to a successful result. */
export function withEarlierAttempts(
  result: StepResult,
  spent: readonly Usage[],
  spec: AnthropicModelSpec | undefined,
): StepResult {
  if (spent.length === 0) return result;
  let usage = result.usage;
  let amount = result.cost?.amount ?? 0;
  for (const u of spent) {
    usage = {
      ...usage,
      inputTokens: usage.inputTokens + u.inputTokens,
      outputTokens: usage.outputTokens + u.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens + u.cacheWriteTokens,
    };
    amount += costOf(u, spec?.pricing ?? null)?.amount ?? 0;
  }
  const out: StepResult = {
    ...result,
    usage,
    cost: result.cost === null && !spec ? null : { currency: "USD", amount: round6(amount), estimated: true },
  };
  if (out.assistant) out.assistant = { ...out.assistant, usage };
  return out;
}

export class AnthropicProvider implements ChatProvider {
  readonly id = "anthropic";
  readonly info: ProviderInfo = ANTHROPIC_INFO;
  private config: ProviderConfig = {};
  private options: AnthropicOptions = parseAnthropicOptions(undefined);
  private client: AnthropicClientLike | null = null;
  private clientKey: string | null = null;
  readonly flags: BetaFlags;
  private readonly createClient: ClientFactory;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  /** Effort support per model id from the last model list (static table until then). */
  private readonly effortSupport = new Map<string, boolean>();

  constructor(opts: AnthropicProviderOptions = {}) {
    this.createClient = opts.createClient ?? sdkClientFactory;
    this.newId = opts.newId ?? randomUUID;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => undefined);
    this.flags = new BetaFlags();
  }

  configure(config: ProviderConfig): void {
    this.config = { ...config };
    this.options = parseAnthropicOptions(config.options);
    for (const f of this.options.disabledBetas) this.flags.disable(f);
    if ((config.apiKey ?? null) !== this.clientKey) {
      this.client = null;
      this.clientKey = null;
    }
  }

  private getClient(): AnthropicClientLike {
    const key = this.config.apiKey;
    if (key === undefined || key.length === 0)
      throw providerError("auth", "Add your Anthropic API key to start.");
    if (this.client === null || this.clientKey !== key) {
      this.client = this.createClient({ apiKey: key });
      this.clientKey = key;
    }
    return this.client;
  }

  async checkConnection(
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: ProviderErrorInfo }> {
    try {
      const client = this.getClient();
      const it = client.listModels(signal)[Symbol.asyncIterator]();
      await it.next();
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderFailure) return { ok: false, error: err.info };
      return { ok: false, error: mapAnthropicError(err, signal.aborted) };
    }
  }

  async listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    let list: ModelDescriptor[];
    try {
      const client = this.getClient();
      const api: ModelInfo[] = [];
      for await (const m of client.listModels(signal)) api.push(m);
      list = mergeModelList(api);
    } catch (err) {
      this.log("models list unavailable; using the bundled table", {
        kind: mapAnthropicError(err, signal.aborted).kind,
      });
      list = staticDescriptors();
    }
    for (const d of list) this.effortSupport.set(d.modelId, d.effort.supported);
    return list;
  }

  describeSwitch(from: ModelSelection, to: ModelSelection, transcriptTokensEstimate: number): SwitchImpact {
    const tokens = Math.max(0, transcriptTokensEstimate);
    const toSpec = modelSpec(to.modelId);
    const fromSpec = modelSpec(from.modelId);
    const perMTok = (n: number | undefined): number => ((n ?? 0) * tokens) / 1e6;
    if (from.providerId !== to.providerId || from.modelId !== to.modelId) {
      const reasoningDropped =
        from.providerId !== to.providerId || !(toSpec?.readsThinkingFrom.includes(from.modelId) ?? false);
      const extra = toSpec
        ? Math.max(
            0,
            perMTok(toSpec.pricing.cacheWrite5mPerMTok) - perMTok(fromSpec?.pricing.cacheReadPerMTok),
          )
        : null;
      const messages = [
        `The next message re-reads the conversation without the cache${extra !== null ? ` (about $${extra.toFixed(2)} extra)` : ""}.`,
      ];
      if (reasoningDropped)
        messages.push(
          "Earlier hidden reasoning isn't carried over to the new model; the conversation itself is.",
        );
      return {
        cacheReset: true,
        reasoningDropped,
        estimatedExtraCost: extra === null ? null : round6(extra),
        messages,
      };
    }
    if (from.effort === to.effort)
      return { cacheReset: false, reasoningDropped: false, estimatedExtraCost: 0, messages: [] };
    const cachePreserved = this.flags.enabled("perMessageEffort") && toSpec?.perMessageEffort === true;
    if (cachePreserved)
      return { cacheReset: false, reasoningDropped: false, estimatedExtraCost: 0, messages: [] };
    const extra = toSpec
      ? Math.max(0, perMTok(toSpec.pricing.cacheWrite5mPerMTok) - perMTok(toSpec.pricing.cacheReadPerMTok))
      : null;
    return {
      cacheReset: true,
      reasoningDropped: false,
      estimatedExtraCost: extra === null ? null : round6(extra),
      messages: [
        `The next message re-reads the conversation${extra !== null ? ` (about $${extra.toFixed(2)} extra)` : ""}.`,
      ],
    };
  }

  async runStep(request: StepRequest, onEvent: StepEventSink, signal: AbortSignal): Promise<StepResult> {
    const client = this.getClient();
    const spec = modelSpec(request.selection.modelId);
    const effortSupported = this.effortSupport.get(request.selection.modelId) ?? spec !== undefined;
    let jsonReissues = 0;
    let stripThinking = false;
    /** Usage of attempts that streamed and then failed or were re-issued: billed, so counted. */
    const spent: Usage[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      if (signal.aborted) throw providerError("cancelled", "Stopped.");
      const built = buildRequest(request, {
        spec,
        flags: this.flags,
        effortSupported,
        cacheTtl: this.options.cacheTtl,
        bindingBehavior: this.options.bindingBehavior,
        stripThinking,
      });
      const partial: { usage: Usage | null } = { usage: null };
      try {
        const result = await this.streamOnce(client, built.params, request, spec, onEvent, signal, partial);
        return withEarlierAttempts(result, spent, spec);
      } catch (err) {
        if (partial.usage !== null) {
          // Reported as a usage event: if this step finally fails, the engine counts these; if it succeeds, the
          // result's usage already includes them.
          spent.push(partial.usage);
          onEvent({ type: "usage", usage: partial.usage });
        }
        if (isAborted(signal)) throw providerError("cancelled", "Stopped.");
        if (isToolJsonParseError(err) && jsonReissues < MAX_JSON_REISSUES) {
          jsonReissues++;
          this.log("tool input JSON unparseable; re-issuing the step", { attempt: jsonReissues });
          continue;
        }
        if (err instanceof BadRequestError) {
          const msg = `${err.apiMessage ?? ""} ${err.message}`;
          const blamed = blamedFeature(msg, built.features);
          if (blamed !== null) {
            this.flags.disable(blamed);
            this.log("beta feature rejected; disabled for this session and retrying", { feature: blamed });
            continue;
          }
          if (!stripThinking && /bound to a different conversation/i.test(msg)) {
            stripThinking = true;
            this.log("thinking blocks rejected by the history check; retrying once without them");
            continue;
          }
        }
        if (isToolJsonParseError(err))
          throw providerError("malformed_output", "The model sent tool input that could not be parsed.");
        throw new ProviderFailure(mapAnthropicError(err, signal.aborted));
      }
    }
    throw providerError("invalid_request", "The request kept being rejected.");
  }

  private async streamOnce(
    client: AnthropicClientLike,
    params: BetaMessageStreamParams,
    request: StepRequest,
    spec: AnthropicModelSpec | undefined,
    onEvent: StepEventSink,
    signal: AbortSignal,
    partial: { usage: Usage | null } = { usage: null },
  ): Promise<StepResult> {
    const stream = client.stream(params, { signal });
    const rawToolJson = new Map<number, string>();
    const toolIds = new Map<number, string>();
    for await (const ev of stream) {
      switch (ev.type) {
        case "message_start": {
          const u = ev.message.usage;
          partial.usage = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          };
          onEvent({ type: "started", servedBy: { providerId: "anthropic", modelId: ev.message.model } });
          break;
        }
        case "message_delta":
          if (partial.usage !== null)
            partial.usage = { ...partial.usage, outputTokens: ev.usage.output_tokens };
          break;
        case "content_block_start": {
          const b = ev.content_block;
          if (b.type === "tool_use") {
            toolIds.set(ev.index, b.id);
            rawToolJson.set(ev.index, "");
            onEvent({ type: "tool_call_start", callId: b.id, name: b.name });
          } else if (b.type === "fallback") {
            onEvent({
              type: "notice",
              kind: "fallback",
              text: `${b.from.model} declined; ${b.to.model} continued.`,
            });
          } else if (b.type === "compaction") {
            onEvent({
              type: "notice",
              kind: "compaction",
              text: "Earlier conversation was summarized to make room.",
            });
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta;
          if (d.type === "text_delta") onEvent({ type: "text_delta", text: d.text });
          else if (d.type === "thinking_delta") onEvent({ type: "reasoning_delta", text: d.thinking });
          else if (d.type === "input_json_delta") {
            const id = toolIds.get(ev.index);
            if (id !== undefined) {
              rawToolJson.set(ev.index, (rawToolJson.get(ev.index) ?? "") + d.partial_json);
              onEvent({ type: "tool_call_delta", callId: id, partialJson: d.partial_json });
            }
          }
          break;
        }
        case "content_block_stop": {
          const id = toolIds.get(ev.index);
          if (id !== undefined) onEvent({ type: "tool_call_end", callId: id });
          break;
        }
        default:
          break;
      }
    }
    const msg = await stream.finalMessage();
    return this.toResult(msg, request, spec, rawToolJson, onEvent);
  }

  private toResult(
    msg: BetaMessage,
    request: StepRequest,
    spec: AnthropicModelSpec | undefined,
    rawToolJson: ReadonlyMap<number, string>,
    onEvent: StepEventSink,
  ): StepResult {
    const stopReason = mapStopReason(msg.stop_reason);
    const { usage, cost } = accountUsage(msg.usage, spec);
    onEvent({ type: "usage", usage });
    const result: StepResult = { stopReason, usage, cost };
    // A refusal is reported in the result; the notice about how the turn ended is the engine's (one notice).
    if (stopReason === "refusal") {
      result.refusal = {
        category: msg.stop_details?.category ?? null,
        explanation: msg.stop_details?.explanation ?? null,
      };
    }
    // Branch on stop_reason before reading content: a refusal's partial output is display-only.
    let parts = partsOf(msg.content, rawToolJson);
    if (stopReason === "refusal")
      parts = [
        ...parts.filter((p) => p.type === "text"),
        { type: "notice", kind: "refusal", text: "The plan wasn't changed." },
      ];
    if (msg.content.length === 0 && stopReason === "refusal") return result;
    const item: Extract<ChatItem, { type: "assistant" }> = {
      type: "assistant",
      id: this.newId(),
      turnId: request.turnId,
      parts,
      stopReason,
      servedBy: { providerId: "anthropic", modelId: msg.model },
      providerState: { providerId: "anthropic", modelId: request.selection.modelId, raw: msg.content },
      usage,
      createdAt: this.now().toISOString(),
    };
    if (stopReason === "refusal") item.excludedFromContext = true;
    result.assistant = item;
    return result;
  }
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): AnthropicProvider {
  return new AnthropicProvider(opts);
}
