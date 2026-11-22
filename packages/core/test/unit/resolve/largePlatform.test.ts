/** A platform of more cells than a call may have arguments resolves (largeAreaPlan.ts). */
import { describe, expect, it } from "vitest";
import { errorsAt1024, oneAreaPlan } from "./largeAreaPlan";

describe("large areas resolve at the 1024 tier", () => {
  it("a 498 x 498 platform in a courtyard", { timeout: 120_000 }, () => {
    const plan = oneAreaPlan(
      520,
      { id: "yard", kind: "courtyard", shape: { type: "rect", x: 10, y: 10, w: 500, h: 500 } },
      [{ id: "dais", op: "platform", shape: { type: "rect", x: 11, y: 11, w: 498, h: 498 }, tiers: 1 }],
    );
    expect(errorsAt1024(plan)).toEqual([]);
  });
});
