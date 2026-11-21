/** The outline shows how each room was read (generator 4), so the model can see and correct a wrong reading. */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { outlineView } from "../../../src/text";
import { loadPlan } from "../../fixtures";

const outline = (plan: MapPlan): string => outlineView(plan, resolvePlan(plan, bundledPalettes()));
const areaLine = (text: string, id: string): string =>
  text.split("\n").find((l) => l.startsWith(`  AREA ${id} `)) ?? "";

describe("outline: room reading", () => {
  const text = outline(loadPlan("purpose-lineup-v1"));

  it("a purpose read from the room's words follows the resolved facts", () => {
    expect(areaLine(text, "kitchen")).toMatch(/ -> reads as kitchen$/);
  });

  it("a stated purpose is a parameter; an abandoned room says so", () => {
    expect(areaLine(text, "antechamber")).toContain(" purpose=shrine ");
    expect(areaLine(text, "antechamber")).not.toContain("reads as");
    expect(areaLine(text, "cellar")).toContain(" purpose=storeroom ");
    expect(areaLine(text, "cellar")).toMatch(/ -> abandoned$/);
  });

  it("released generators' outlines are unchanged", () => {
    const plan = loadPlan("purpose-lineup-v1", { generator: 3 });
    for (const l of plan.levels) for (const a of l.areas) delete a.purpose;
    const old = outline(plan);
    expect(old).not.toMatch(/reads as|abandoned|purpose=/);
  });
});
