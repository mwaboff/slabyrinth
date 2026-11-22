/** A cave of more cells than a call may have arguments resolves (largeAreaPlan.ts). */
import { describe, expect, it } from "vitest";
import { errorsAt1024, oneAreaPlan } from "./largeAreaPlan";

describe("large areas resolve at the 1024 tier", () => {
  it("a 370 x 370 cave", { timeout: 120_000 }, () => {
    const plan = oneAreaPlan(374, {
      id: "deep",
      kind: "cave",
      shape: { type: "rect", x: 2, y: 2, w: 370, h: 370 },
    });
    expect(errorsAt1024(plan)).toEqual([]);
  });
});
