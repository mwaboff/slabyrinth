/**
 * Slabyrinth — chat provider abstraction (Electron MAIN process only).
 * NORMATIVE CONTRACT. Copy verbatim into apps/desktop/src/main/agent/provider/types.ts.
 *
 * The conversation loop (ConversationEngine, §3) talks ONLY to this interface. v1 ships exactly one
 * implementation, AnthropicProvider (official @anthropic-ai/sdk). LM Studio (OpenAI-compatible local
 * server) is a future provider in its own module (§3.12). Everything provider-specific — prompt
 * caching, adaptive thinking, effort mapping, server-side refusal fallbacks, beta headers, refusal
 * stop reasons, native message formats — stays inside the adapter.
 *
 * Division of labour:
 *   - Provider: ONE model call ("step"): render neutral transcript → native request, stream, normalize
 *     the response back to neutral parts, report usage/cost, classify errors.
 *   - Engine: the turn loop (steps until no tool calls), tool execution, plan versions, persistence,
 *     retries policy, cancellation, UI events.
 */
import type { MapSelection } from "@slabyrinth/core/contracts/resolved";
import type { ToolDefinition, ToolResultContent } from "@slabyrinth/core/agent/tools";

// ───────────────────────────── identity & selection ─────────────────────────────

export type ProviderId = "anthropic" | "lmstudio" | (string & {});

/** Provider-neutral effort scale. A model may support a subset or none (descriptor.effort.supported=false). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What a conversation runs on. effort = null ⇒ model default / no effort control. */
export interface ModelSelection {
  providerId: ProviderId;
  modelId: string;
  effort: EffortLevel | null;
}

// ───────────────────────────── capability descriptor ─────────────────────────────

export interface Pricing {
  currency: "USD";
  /** Per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
  /** Prompt-size tiers, e.g. Haiku 5.5 above 100K input tokens. First matching tier (highest threshold ≤ prompt) wins. */
  tiers?: Array<{ aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number }>;
  /** Where the numbers came from; shown in the UI ("estimate, verify on the provider's pricing page"). */
  asOf: string;
}

export interface ModelDescriptor {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  effort:
    | { supported: false }
    | { supported: true; levels: EffortLevel[]; default: EffortLevel };
  /** "always" = cannot be disabled (Opus 5.5, Fable 5.x); "optional"; "none"; "unknown" (local models). */
  thinking: "always" | "optional" | "none" | "unknown";
  /**
   * How plan-edit tools are offered:
   *  "native" = provider tool calling;  "json" = JSON-reply protocol validated by the same schemas (§3.11);
   *  "none"   = chat only, the model cannot edit the plan (UI says so).
   */
  toolCalling: "native" | "json" | "none";
  imageInput: boolean;
  /** Informational flags for the UI/settings; the engine never branches on these except toolCalling/imageInput. */
  features: {
    promptCaching: boolean;
    serverCompaction: boolean;
    refusalFallback: boolean;
    reasoningSummaries: boolean;
  };
  pricing: Pricing | null;           // null = free/unknown (local)
  /** "api": live Models API; "static": bundled table; "api+static": merged (static supplies defaults the API lacks, e.g. default effort). */
  source: "api" | "static" | "api+static";
  status: "recommended" | "available" | "legacy" | "unavailable";
  /** UX §5.8 guidance (static table only; absent = listed under "Other models"). */
  guidance?: string;
  /** Release time (ISO 8601) from the live Models API; absent for bundled-only entries. Orders "Other models". */
  createdAt?: string;
  costTier?: 1 | 2 | 3 | 4;
  speedTier?: 1 | 2 | 3;
  notes?: string[];
}

/** Provider-level facts the settings UI renders from (UX §8.4). Missing capability ⇒ UI hides the element. */
export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  nature: string;                 // "Cloud · your API key" / "Runs on this PC · no API cost"
  needsKey: boolean;
  hasServerUrl: boolean;
  defaultServerUrl?: string;
  modelSource: "catalog" | "fetched";
  hasCost: boolean;
  hasSpeedGuidance: boolean;
  /** v1: false for LM Studio (card shown as "Later"). */
  available: boolean;
}

// ───────────────────────────── neutral transcript ─────────────────────────────

export interface ImageRef {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64 data (no data: prefix). Stored in the project file's blob table, referenced by hash. */
  dataBase64?: string;
  blobHash?: string;
}

/** Opaque per-provider payload the adapter needs to replay a message EXACTLY (e.g. Anthropic content blocks with thinking signatures). */
export interface ProviderMessageState {
  providerId: ProviderId;
  modelId: string;
  /** JSON-serializable; persisted verbatim; never interpreted outside the adapter that wrote it. */
  raw: unknown;
}

export type AssistantPart =
  | { type: "text"; text: string }
  /** Reasoning summary for display only (may be empty when the provider hides reasoning). */
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  /** Provider-side events worth showing: fallback model took over, context compacted, etc. */
  | { type: "notice"; kind: "fallback" | "compaction" | "truncated" | "refusal"; text: string };

export type ChatItem =
  | {
      type: "user";
      id: string;
      text: string;
      selection?: MapSelection;
      images?: ImageRef[];
      createdAt: string;
    }
  /**
   * App-injected operator context (NOT user-authored): plan-state resync, phase change, retry hints.
   * Anthropic adapter → mid-conversation {role:"system"} message; others → tagged user-turn text.
   */
  | {
      type: "context";
      id: string;
      reason: "session_start" | "plan_changed" | "brief_changed" | "phase" | "resync" | "retry_hint" | "model_switched" | "resumed";
      text: string;
      createdAt: string;
    }
  | {
      type: "assistant";
      id: string;
      turnId: string;
      parts: AssistantPart[];
      stopReason: StopReason;
      /** Model that actually produced it (may differ from requested after a fallback). */
      servedBy: { providerId: ProviderId; modelId: string };
      providerState?: ProviderMessageState;
      usage?: Usage;
      /**
       * true for stopped (cancelled) partial output and refused output: kept for display, NEVER sent to any model
       * (a partial message cannot be replayed faithfully).
       */
      excludedFromContext?: boolean;
      createdAt: string;
    }
  /**
   * Selection change point (model and/or effort). Providers render it their own way — Anthropic: an effort-only
   * {role:"system", content:[], output_config:{effort}} message when only effort changed on a model that supports
   * per-message effort; nothing otherwise. Appended (never inserted) so replays stay byte-identical.
   */
  | { type: "marker"; id: string; kind: "selection_changed"; selection: ModelSelection; createdAt: string }
  | {
      type: "tool_results";
      id: string;
      turnId: string;
      results: Array<{ callId: string; name: string; isError: boolean; content: ToolResultContent[] }>;
      createdAt: string;
    };

// ───────────────────────────── step request / result ─────────────────────────────

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"     // output cut off
  | "refusal"        // safety decline (after any provider-side fallback chain)
  | "pause"          // provider asks to continue (Anthropic pause_turn) — engine re-issues
  | "cancelled"
  | "error";

export interface StepRequest {
  conversationId: string;
  turnId: string;
  selection: ModelSelection;
  /** Frozen for the life of the conversation (byte-identical across steps). */
  systemPrompt: string;
  /** Frozen for the life of the conversation (deterministic order). */
  tools: ToolDefinition[];
  /** Full neutral transcript to send (append-only between steps). */
  transcript: ChatItem[];
  /** Engine-level cap; adapter may clamp to model max. */
  maxOutputTokens: number;
  /**
   * Effort for THIS step (may differ from selection.effort under Smart effort, §3.8). The adapter chooses the
   * cheapest cache-preserving mechanism (Anthropic: per-message effort system message when supported, else top-level).
   */
  effort: EffortLevel | null;
  /** Decided by engine from the descriptor (and user override). */
  toolMode: "native" | "json" | "none";
}

export interface Usage {
  inputTokens: number;            // uncached input
  outputTokens: number;           // includes reasoning tokens where the provider bills them as output
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per-attempt breakdown when the provider ran more than one model in the step (refusal fallback). */
  attempts?: Array<{ modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
}

export interface Cost {
  currency: "USD";
  amount: number;
  /** true when computed from a bundled price table (always, in v1). */
  estimated: boolean;
}

export interface StepResult {
  stopReason: StopReason;
  /** Assistant item to append to the transcript (absent when the step produced nothing to keep, e.g. refusal-before-output or cancel). */
  assistant?: Extract<ChatItem, { type: "assistant" }>;
  usage: Usage;
  cost: Cost | null;
  /** Refusal details (informational). */
  refusal?: { category: string | null; explanation: string | null };
}

/** Streaming events, normalized. Emitted in order; tool_call_* only in native or json mode. */
export type StepEvent =
  | { type: "started"; servedBy: { providerId: ProviderId; modelId: string } }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; callId: string; name: string }
  | { type: "tool_call_delta"; callId: string; partialJson: string }
  | { type: "tool_call_end"; callId: string }
  | { type: "notice"; kind: "fallback" | "compaction" | "truncated" | "refusal"; text: string }
  | { type: "usage"; usage: Usage };

export type StepEventSink = (e: StepEvent) => void;

// ───────────────────────────── errors ─────────────────────────────

export type ProviderErrorKind =
  | "auth"              // missing/invalid key
  | "permission"        // key lacks access to model/feature
  | "not_found"         // unknown model id
  | "invalid_request"   // 400 — bug or unsupported parameter; not retryable
  | "context_overflow"  // prompt too long
  | "rate_limit"        // 429
  | "overloaded"        // 529 / provider busy
  | "server"            // 5xx
  | "network"           // DNS/TLS/connection reset; local server not running
  | "timeout"
  | "cancelled"
  | "malformed_output"; // unparseable tool input / JSON protocol violation after adapter retries

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus?: number;
  /** Provider request id for support (Anthropic `request-id`). */
  requestId?: string;
  /** Safe-to-display message (never contains the API key). */
  message: string;
}

/** Thrown by provider methods. */
export interface ProviderError extends Error {
  readonly info: ProviderErrorInfo;
}

// ───────────────────────────── the interface ─────────────────────────────

export interface ProviderConfig {
  /** Secret, injected by SecretStore at call time; absent for keyless providers. */
  apiKey?: string;
  /** For local/self-hosted providers (LM Studio default http://localhost:1234/v1). */
  baseUrl?: string;
  /** Provider-specific, schema-validated, non-secret options (e.g. anthropic.cacheTtl). */
  options?: Record<string, unknown>;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly info: ProviderInfo;

  configure(config: ProviderConfig): void;

  /** Cheap reachability/auth probe for the settings screen. */
  checkConnection(signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: ProviderErrorInfo }>;

  /** Live list merged with bundled static descriptors; cached by the engine for 24 h. */
  listModels(signal: AbortSignal): Promise<ModelDescriptor[]>;

  /** One model call. Must honour `signal` (abort → resolve with stopReason "cancelled" or throw kind "cancelled"). */
  runStep(request: StepRequest, onEvent: StepEventSink, signal: AbortSignal): Promise<StepResult>;

  /**
   * Called when the selection changes mid-conversation, BEFORE the next step, so the adapter can say
   * what the switch costs (UI confirmation). Pure/advisory.
   */
  describeSwitch(from: ModelSelection, to: ModelSelection, transcriptTokensEstimate: number): SwitchImpact;
}

export interface SwitchImpact {
  /** Prompt cache for the conversation will be cold on the next step. */
  cacheReset: boolean;
  /** Earlier hidden reasoning will not be visible to the new model (e.g. Anthropic thinking blocks across models). */
  reasoningDropped: boolean;
  /** Estimated one-off extra cost of re-reading the conversation uncached, USD (null if unknown/free). */
  estimatedExtraCost: number | null;
  /** Lines for the confirmation dialog. */
  messages: string[];
}

/** Registry used by the engine; v1 registers only "anthropic". */
export interface ProviderRegistry {
  get(id: ProviderId): ChatProvider | undefined;
  list(): ChatProvider[];
}
