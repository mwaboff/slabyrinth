/**
 * Every model-facing tool result stays bounded at the plan size limit. The ASCII view is the one whose size grows with
 * the map's area: a crop over MAX_VIEW_CELLS (160 × 160, the largest level before the limit rose to 320) is drawn as
 * an overview of cell blocks, so no result costs more than the old worst case; a crop within it is drawn exactly as
 * before (outline, json and the preview are capped by element counts and their own budgets).
 *
 * The mechanism does not depend on the size, so these run on moderate plans with a small `maxCells`; the full-size
 * round trip (a level at the side limit through every tool) runs in the sweep (test/sweep/run.ts).
 */
import { describe, expect, it } from "vitest";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { MAX_VIEW_CELLS, asciiLevel, asciiView } from "../../../src/text";
import { largeOutdoorPlan } from "../../fixtures/largePlan";
import { viewBudgetRun } from "../../fixtures/viewBudget";

const pal = bundledPalettes();

describe("tool results stay within the view budget", () => {
  it("a moderate level through every tool: no block of any result is over the budget", async () => {
    const { problems, ascii } = await viewBudgetRun(largeOutdoorPlan(60));
    expect(problems).toEqual([]);
    expect(ascii).not.toMatch(/overview/);
  });

  it("a crop of more than maxCells cells is an overview no longer than the largest crop drawn cell by cell", () => {
    const level = resolvePlan(largeOutdoorPlan(60), pal).levels[0] as ResolvedLevel;
    const maxCells = 30 * 30;
    const full = asciiLevel(level, null, { maxCells, region: { x: 0, y: 0, w: 30, h: 30 } });
    expect(full).not.toMatch(/overview/);
    const over = asciiLevel(level, null, { maxCells });
    expect(over).toMatch(/overview: level crop is 60×60 cells.*1 char = 2×2 cells/);
    expect(over).toMatch(/region of at most 30×30 cells/);
    expect(over.length).toBeLessThan(full.length);
    // the block size grows with the crop, so the overview stays bounded whatever the level's size
    const wider = asciiLevel(level, null, { maxCells: 15 * 15 });
    expect(wider).toMatch(/1 char = 4×4 cells/);
  });

  it("an overview's legend lists only the characters its blocks show", () => {
    const level = resolvePlan(largeOutdoorPlan(60), pal).levels[0] as ResolvedLevel;
    for (const maxCells of [30 * 30, 15 * 15, 8 * 8, 3 * 3, 2 * 2]) {
      const lines = asciiLevel(level, null, { maxCells }).split("\n");
      const hint = lines.findIndex((l) => l.startsWith("(overview"));
      const drawn = lines.slice(1, hint).join("");
      const legend = lines.find((l) => l.startsWith("legend: "));
      for (const part of (legend ?? "legend: ")
        .slice(8)
        .split(", ")
        .filter((p) => p !== ""))
        for (const ch of part.split(" ")[0] ?? "")
          expect(drawn, `${String(maxCells)}: ${part}`).toContain(ch);
    }
  });

  it("a crop of at most MAX_VIEW_CELLS cells is drawn cell by cell, as before the limit rose", () => {
    const plan = largeOutdoorPlan(170);
    const resolved = resolvePlan(plan, pal);
    const full = asciiView(resolved, "g", { region: { x: 0, y: 0, w: 160, h: 160 } });
    expect(160 * 160).toBe(MAX_VIEW_CELLS);
    expect(full).not.toMatch(/overview/);
    expect(full).toMatch(/1 char per cell/);
    const over = asciiView(resolved, "g", { region: { x: 0, y: 0, w: 161, h: 160 } });
    expect(over).toMatch(/overview/);
    expect(over.length).toBeLessThan(full.length + 200);
  });
});
