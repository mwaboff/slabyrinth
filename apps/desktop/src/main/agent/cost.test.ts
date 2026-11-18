import { describe, expect, it } from "vitest";
import { ZERO_USAGE, addCost, addUsage, costOf, promptTokens, ratesFor } from "./cost";
import { pricingOf, staticDescriptors } from "./provider/anthropic/models";

describe("cost accounting", () => {
  const opus = pricingOf("claude-opus-5-5");
  const haiku = pricingOf("claude-haiku-5-5");

  it("prices every usage component at its own rate", () => {
    const u = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(costOf(u, opus)?.amount).toBeCloseTo(4 + 20 + 0.2 + 5, 9);
    expect(costOf(u, opus, 1_000_000)?.amount).toBeCloseTo(4 + 20 + 0.2 + 8, 9);
    expect(costOf(u, null)).toBeNull();
  });

  it("uses Haiku's higher tier only above 100K prompt tokens", () => {
    if (!haiku) throw new Error("no haiku pricing");
    expect(ratesFor(haiku, 100_000).input).toBe(0.1);
    expect(ratesFor(haiku, 100_001)).toMatchObject({ input: 0.5, output: 2.5, cacheRead: 0.05 });
    expect(ratesFor(haiku, 100_001).write5m).toBeCloseTo(0.625, 9);
  });

  it("sums usage and cost", () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    expect(addUsage(ZERO_USAGE, a)).toEqual(a);
    expect(promptTokens(a)).toBe(8);
    expect(addCost(null, null)).toBeNull();
    expect(
      addCost(
        { currency: "USD", amount: 0.1, estimated: true },
        { currency: "USD", amount: 0.2, estimated: true },
      )?.amount,
    ).toBeCloseTo(0.3, 9);
  });

  it("bundled table matches the decided models and defaults (decisions.md #2)", () => {
    const d = staticDescriptors();
    expect(d.map((m) => [m.modelId, m.effort.supported ? m.effort.default : null, m.status])).toEqual([
      ["claude-opus-5-5", "medium", "recommended"],
      ["claude-fable-5-2", "high", "available"],
      ["claude-sonnet-5-5", "high", "available"],
      ["claude-haiku-5-5", "medium", "available"],
    ]);
    expect(d.find((m) => m.modelId === "claude-haiku-5-5")?.features.refusalFallback).toBe(false);
  });
});
