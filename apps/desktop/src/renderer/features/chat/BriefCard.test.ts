/** Brief summary lines: plan values win over the brief's intended values once a plan exists. */
import { describe, expect, it } from "vitest";
import type { DesignBrief, MapPlan } from "@slabyrinth/core";
import { briefSummary } from "./BriefCard";

const brief = {
  levels: { value: { count: 2, names: [] }, source: "user" },
  footprint: { value: { preset: "large", widthSq: 80, heightSq: 60 }, source: "user" },
} as unknown as DesignBrief;
const level = (x: number, w: number, h: number) => ({ bounds: { x, y: 0, w, h } });

describe("briefSummary", () => {
  it("shows the brief's intended levels and size before a plan exists", () => {
    expect(briefSummary(brief)[1]).toBe("2 levels · 80×60 sq (400×300 ft)");
    expect(briefSummary(brief, null)[1]).toBe("2 levels · 80×60 sq (400×300 ft)");
  });

  it("shows the plan's level count and overall bounds once there is a plan", () => {
    const plan = { levels: [level(0, 80, 60), level(0, 80, 60), level(10, 90, 40)] } as unknown as Pick<
      MapPlan,
      "levels"
    >;
    expect(briefSummary(brief, plan)[1]).toBe("3 levels · 100×60 sq (500×300 ft)");
  });
});
