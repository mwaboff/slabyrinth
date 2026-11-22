/**
 * Generator 5 (`layeredProps`): overlapping props paste whole in game (the engine-operators proof), so verify warns only
 * when two pieces of blocking furniture stand in one spot and reports other overlaps as info; generator 4's message
 * stays as it was released.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import type { ResolvedFeature } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const rows = ["########", "#......#", "#......#", "#......#", "#......#", "########"];

function overlaps(
  generator: 4 | 5,
  features: Array<Partial<ResolvedFeature> & Pick<ResolvedFeature, "id" | "type" | "at">>,
) {
  const r = { ...handPlan([handLevel({ id: "l", rows, theme: "wood_town", features })]), generator };
  return verifyBuild(r, realize(r, cat), cat).diagnostics.filter((d) => d.code === "verify_props_overlap");
}

describe("prop overlaps", () => {
  const twoTables = [
    { id: "t1", type: "table" as const, at: [2, 2] as const, size: [2, 1] as const },
    {
      id: "t2",
      type: "table" as const,
      at: [2, 2] as const,
      size: [2, 1] as const,
      offset: [0.25, 0] as [number, number],
    },
  ];

  it("generator 5: two tables in one spot (a quarter tile apart) are a layout fault, without the claim that TaleSpire drops them", () => {
    const d = overlaps(5, twoTables);
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe("warning");
    expect(d[0]?.message).toMatch(/furniture stand in the same spot/);
    expect(d[0]?.message).not.toMatch(/drop/);
    expect(d[0]?.hint ?? "").not.toMatch(/minSpacing|one cell apart/);
  });

  it("generator 5: a piece overlapping another without taking its spot is info", () => {
    const d = overlaps(5, [
      { id: "t1", type: "table", at: [2, 2], size: [2, 1] },
      { id: "b1", type: "barrel", at: [3, 2], offset: [0.45, 0] },
    ]);
    for (const x of d) expect(x.severity).toBe("info");
  });

  it("generator 4 keeps its released message", () => {
    const d = overlaps(4, twoTables);
    expect(d[0]?.severity).toBe("warning");
    expect(d[0]?.message).toMatch(/TaleSpire can silently drop overlapping props when pasting/);
    expect(d[0]?.hint).toBe("Space these features at least one cell apart (scatter: raise minSpacing).");
  });
});
