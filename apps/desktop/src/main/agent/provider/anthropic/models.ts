/**
 * Anthropic model capabilities (architecture §3.8): a bundled static table (works offline; supplies what the
 * Models API lacks: default effort, guidance, cost/speed tiers, pricing, fallback and per-message-effort support)
 * merged with the live Models API.
 *
 * Ids, context sizes and prices come from the claude-api skill (model catalog cached 2026-11-03). They are an
 * estimate; the UI says so and the Anthropic bill is authoritative.
 */
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";
import type { EffortLevel, ModelDescriptor, Pricing } from "../types";
import { EFFORT_LEVELS } from "../types";

export const PRICING_AS_OF = "2026-11 (bundled price table)";
export const DEFAULT_MODEL_ID = "claude-opus-5-5";

/** Anthropic-only facts the adapter needs per model (never seen by the engine). */
export interface AnthropicModelSpec {
  id: string;
  displayName: string;
  defaultEffort: EffortLevel;
  levels: EffortLevel[];
  /** Server-side refusal fallback ("default" mode) is offered for this model. */
  fallbacks: boolean;
  /** Effort-only {role:"system", output_config} messages (beta mid-conversation-output-config-2026-07-01). */
  perMessageEffort: boolean;
  /** Mid-conversation {role:"system"} messages (GA). */
  systemMessages: boolean;
  /** Models whose thinking blocks this model can read (preserved thinking, model binding). */
  readsThinkingFrom: string[];
  contextWindow: number;
  maxOutputTokens: number;
  pricing: Pricing;
  guidance: string;
  costTier: 1 | 2 | 3 | 4;
  speedTier: 1 | 2 | 3;
  status: ModelDescriptor["status"];
}

const ALL: EffortLevel[] = [...EFFORT_LEVELS];

/** Cache writes are 1.25× (5 min) and 2× (1 h) of input. */
function price(input: number, output: number, cacheRead: number, tiers?: Pricing["tiers"]): Pricing {
  const p: Pricing = {
    currency: "USD",
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWrite5mPerMTok: +(input * 1.25).toFixed(4),
    cacheWrite1hPerMTok: +(input * 2).toFixed(4),
    asOf: PRICING_AS_OF,
  };
  if (tiers) p.tiers = tiers;
  return p;
}

export const ANTHROPIC_MODELS: readonly AnthropicModelSpec[] = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    defaultEffort: "medium",
    levels: ALL,
    fallbacks: true,
    perMessageEffort: true,
    systemMessages: true,
    readsThinkingFrom: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: price(4, 20, 0.2),
    guidance: "Recommended. Best balance of layout quality and cost.",
    costTier: 3,
    speedTier: 2,
    status: "recommended",
  },
  {
    id: "claude-fable-5-2",
    displayName: "Claude Fable 5.2",
    defaultEffort: "high",
    levels: ALL,
    fallbacks: true,
    perMessageEffort: true,
    systemMessages: true,
    readsThinkingFrom: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: price(8, 40, 0.2),
    guidance: "Most capable. For large, intricate multi-level maps.",
    costTier: 4,
    speedTier: 1,
    status: "available",
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    defaultEffort: "high",
    levels: ALL,
    fallbacks: true,
    perMessageEffort: true,
    systemMessages: true,
    readsThinkingFrom: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: price(2, 10, 0.1),
    guidance: "Cheaper. Good for most maps and edits.",
    costTier: 2,
    speedTier: 2,
    status: "available",
  },
  {
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    defaultEffort: "medium",
    levels: ALL,
    fallbacks: false,
    perMessageEffort: true,
    systemMessages: true,
    readsThinkingFrom: ["claude-haiku-5-5"],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: price(0.1, 0.5, 0.01, [
      { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05 },
    ]),
    guidance: "Fastest and cheapest. Quick drafts and chat.",
    costTier: 1,
    speedTier: 3,
    status: "available",
  },
];

/** Prices of models that can serve a step only as a server-side refusal fallback (not offered in the picker). */
export const FALLBACK_TARGET_PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-sonnet-5": price(2, 10, 0.2),
};

/** Pricing for any model id the adapter may see in a response, or null when unknown (never guessed). */
export function pricingOf(id: string): Pricing | null {
  return modelSpec(id)?.pricing ?? FALLBACK_TARGET_PRICING[id] ?? null;
}

export function modelSpec(id: string): AnthropicModelSpec | undefined {
  return ANTHROPIC_MODELS.find((m) => m.id === id);
}

function fromSpec(s: AnthropicModelSpec): ModelDescriptor {
  return {
    providerId: "anthropic",
    modelId: s.id,
    displayName: s.displayName,
    contextWindow: s.contextWindow,
    maxOutputTokens: s.maxOutputTokens,
    effort: { supported: true, levels: [...s.levels], default: s.defaultEffort },
    thinking: "always",
    toolCalling: "native",
    imageInput: true,
    features: {
      promptCaching: true,
      serverCompaction: true,
      refusalFallback: s.fallbacks,
      reasoningSummaries: true,
    },
    pricing: s.pricing,
    source: "static",
    status: s.status,
    guidance: s.guidance,
    costTier: s.costTier,
    speedTier: s.speedTier,
  };
}

export function staticDescriptors(): ModelDescriptor[] {
  return ANTHROPIC_MODELS.map(fromSpec);
}

function effortFromCapabilities(info: ModelInfo): ModelDescriptor["effort"] | null {
  const e = info.capabilities?.effort;
  if (!e) return null;
  if (!e.supported) return { supported: false };
  const levels = EFFORT_LEVELS.filter((l) => (l === "xhigh" ? e.xhigh?.supported === true : e[l].supported));
  if (levels.length === 0) return { supported: false };
  return {
    supported: true,
    levels,
    default: levels.includes("high") ? "high" : (levels[levels.length - 1] ?? "high"),
  };
}

/**
 * Merges the live list with the static table. Static entries supply defaults the API lacks; models the API does not
 * list are marked "unavailable" (not offered to this key). Unknown API models appear with capabilities only.
 */
export function mergeModelList(api: readonly ModelInfo[]): ModelDescriptor[] {
  const byId = new Map(api.map((m) => [m.id, m]));
  const out: ModelDescriptor[] = [];
  for (const spec of ANTHROPIC_MODELS) {
    const live = byId.get(spec.id);
    const d = fromSpec(spec);
    if (!live) {
      out.push({ ...d, status: "unavailable" });
      continue;
    }
    d.source = "api+static";
    if (live.max_input_tokens) d.contextWindow = live.max_input_tokens;
    if (live.max_tokens) d.maxOutputTokens = live.max_tokens;
    if (live.capabilities) {
      d.imageInput = live.capabilities.image_input.supported;
      const eff = effortFromCapabilities(live);
      if (eff?.supported)
        d.effort = {
          supported: true,
          levels: eff.levels,
          default: eff.levels.includes(spec.defaultEffort) ? spec.defaultEffort : eff.default,
        };
      d.features.serverCompaction =
        live.capabilities.context_management.compact_20260112?.supported ?? d.features.serverCompaction;
    }
    out.push(d);
  }
  for (const live of api) {
    if (modelSpec(live.id) || !live.id.startsWith("claude-")) continue;
    if (live.lifecycle === "retired") continue;
    out.push({
      providerId: "anthropic",
      modelId: live.id,
      displayName: live.display_name,
      contextWindow: live.max_input_tokens,
      maxOutputTokens: live.max_tokens,
      effort: effortFromCapabilities(live) ?? { supported: false },
      thinking: live.capabilities?.thinking.types.adaptive.supported ? "optional" : "unknown",
      toolCalling: "native",
      imageInput: live.capabilities?.image_input.supported ?? false,
      features: {
        promptCaching: true,
        serverCompaction: live.capabilities?.context_management.compact_20260112?.supported ?? false,
        refusalFallback: false,
        reasoningSummaries: live.capabilities?.thinking.supported ?? false,
      },
      pricing: null,
      source: "api",
      status: live.lifecycle === "deprecated" ? "legacy" : "available",
    });
  }
  return out;
}
