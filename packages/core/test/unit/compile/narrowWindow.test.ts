/**
 * A window no window piece fits (generator 5, switch `windowSpanClosed`, compile/realize/openings.ts). The test ship's
 * 1-wide windows in a theme whose window pieces are 2 wide were left as holes in the wall with a role_missing warning
 * the model could not act on. Now the span is wall and the warning names the width that fits; generator 4 still leaves
 * the hole.
 */
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { dungeonPlan } from "../../fixtures/planBuilder";

const pal = bundledPalettes();

function build(generator: 4 | 5, width: 1 | 2) {
  const plan = dungeonPlan({
    generator,
    w: 12,
    h: 10,
    theme: "wood_town",
    areas: [{ id: "a", kind: "room", shape: { type: "rect", x: 2, y: 2, w: 6, h: 5 } }],
    openings: [{ id: "w", kind: "window", width, at: { x: 4, y: 2, side: "N" } }],
  });
  const b = compileResolved(resolvePlan(plan, pal), pal, slabCodec, { plan, createdAt: "t" });
  return { diagnostics: b.diagnostics, assets: b.chunks.reduce((n, c) => n + c.assetCount, 0) };
}

describe("a window no piece fits (generator 5)", () => {
  it("is built as wall, and the warning names the width that fits", () => {
    const g5 = build(5, 1);
    const g4 = build(4, 1);
    const warn = g5.diagnostics.find((d) => d.code === "role_missing" && d.elementId === "w");
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toMatch(/built as plain wall; give it width 2/);
    // the hole is filled: more pieces than generator 4's build of the same plan, which leaves it open
    expect(g4.diagnostics.find((d) => d.code === "role_missing")?.message).toMatch(/left open/);
    expect(g5.assets).toBeGreaterThan(g4.assets);
    // and verify finds nothing wrong with the wall that closes it
    expect(g5.diagnostics.filter((d) => d.severity !== "info").map((d) => d.code)).toEqual(["role_missing"]);
  });

  it("leaves a window that fits alone", () => {
    expect(build(5, 2).diagnostics.filter((d) => d.code === "role_missing")).toEqual([]);
  });
});
