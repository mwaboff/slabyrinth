/** The outline shows how each room was read (generator 4), so the model can see and correct a wrong reading. */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { outlineView } from "../../../src/text";
import { loadPlan } from "../../fixtures";
import { townPlan } from "../../fixtures/planBuilder";

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

  it("a building's arrow slits are counted with its windows (generator 4); released outlines list them as doors", () => {
    const tower = (generator: 3 | 4): string => {
      const plan = townPlan({
        generator,
        id: "slit",
        seed: 3,
        theme: "forest",
        w: 30,
        h: 30,
        structures: [
          {
            id: "b",
            style: "keep",
            seed: 3,
            wings: [{ x: 10, y: 10, w: 8, h: 8 }],
            openings: [
              { kind: "arrow_slit", side: "N", position: 0.3 },
              { kind: "door", side: "S", position: 0.5 },
            ],
          },
        ],
        level: {},
      });
      return (
        outline(plan)
          .split("\n")
          .find((l) => l.startsWith("  STRUCT b ")) ?? ""
      );
    };
    const g4 = tower(4);
    const g3 = tower(3);
    expect(g4).not.toContain("arrow_slit");
    expect(g3).toContain("arrow_slit");
    const count = (line: string): number => Number(/ (\d+) windows?/.exec(line)?.[1] ?? -1);
    expect(count(g4)).toBe(count(g3) + 1);
  });

  it("released generators' outlines are unchanged", () => {
    const plan = loadPlan("purpose-lineup-v1", { generator: 3 });
    for (const l of plan.levels) for (const a of l.areas) delete a.purpose;
    const old = outline(plan);
    expect(old).not.toMatch(/reads as|abandoned|purpose=/);
  });
});
