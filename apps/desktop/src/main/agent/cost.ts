/**
 * Provider-neutral usage and cost arithmetic over the contract's Pricing table. Every figure is an estimate
 * (Cost.estimated = true); the provider's bill is authoritative.
 */
import type { Cost, Pricing, Usage } from "./provider/types";

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function addCost(a: Cost | null, b: Cost | null): Cost | null {
  if (a === null) return b === null ? null : { ...b };
  if (b === null) return { ...a };
  return { currency: "USD", amount: round6(a.amount + b.amount), estimated: a.estimated || b.estimated };
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Total prompt size of a request (uncached + cache read + cache write). */
export function promptTokens(u: Pick<Usage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** Rates in effect for a prompt of `prompt` tokens (Haiku's above-100K tier, etc.). */
export function ratesFor(
  pricing: Pricing,
  prompt: number,
): { input: number; output: number; cacheRead: number; write5m: number; write1h: number } {
  let input = pricing.inputPerMTok;
  let output = pricing.outputPerMTok;
  let cacheRead = pricing.cacheReadPerMTok ?? input * 0.1;
  let write5m = pricing.cacheWrite5mPerMTok ?? input * 1.25;
  let write1h = pricing.cacheWrite1hPerMTok ?? input * 2;
  const tier = [...(pricing.tiers ?? [])]
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find((t) => prompt > t.aboveInputTokens);
  if (tier) {
    const scale = tier.inputPerMTok / input;
    input = tier.inputPerMTok;
    output = tier.outputPerMTok;
    cacheRead = tier.cacheReadPerMTok ?? cacheRead * scale;
    write5m *= scale;
    write1h *= scale;
  }
  return { input, output, cacheRead, write5m, write1h };
}

/**
 * Cost of one request. `cacheWrite1hTokens` is the part of cacheWriteTokens written with the 1-hour TTL
 * (the rest is priced at the 5-minute rate).
 */
export function costOf(usage: Usage, pricing: Pricing | null, cacheWrite1hTokens = 0): Cost | null {
  if (pricing === null) return null;
  const r = ratesFor(pricing, promptTokens(usage));
  const w1h = Math.min(cacheWrite1hTokens, usage.cacheWriteTokens);
  const w5m = usage.cacheWriteTokens - w1h;
  const amount =
    (usage.inputTokens * r.input +
      usage.outputTokens * r.output +
      usage.cacheReadTokens * r.cacheRead +
      w5m * r.write5m +
      w1h * r.write1h) /
    1e6;
  return { currency: "USD", amount: round6(amount), estimated: true };
}
