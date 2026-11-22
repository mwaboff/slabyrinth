/**
 * ASCII row labels (text/asciiMap/grid.ts): the label column is as wide as the widest label in the view, so a row
 * whose coordinate has four or more characters (y ≥ 1000 or ≤ −100, reachable at the 1024 tier) starts its cells in
 * the same column as every other row. A view whose labels fit three characters is drawn as before (the text goldens
 * pin those byte for byte).
 */
import { describe, expect, it } from "vitest";
import type { ResolvedLevel } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { asciiLevel } from "../../../src/text";
import { largeOutdoorPlan } from "../../fixtures/largePlan";

const level = resolvePlan(largeOutdoorPlan(24), bundledPalettes()).levels[0] as ResolvedLevel;
/** The same level with its bounds moved to start at row y0 (the cells are bound-relative). */
const at = (y0: number): ResolvedLevel => ({ ...level, bounds: { ...level.bounds, y: y0 } });

/** The map rows of a view (after its column header, up to the first blank line or hint). */
const mapRows = (text: string): string[] => {
  const lines = text.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && (l === "" || l.startsWith("(")));
  return lines.slice(1, end < 0 ? lines.length : end);
};
const LABEL = /^ *-?\d+ /;
const MODES = [{}, { maxDoubleWidth: 10 }, { maxCells: 100 }] as const;

describe("ASCII row labels", () => {
  it.each([990, -115])("rows from %i: every row starts its cells in one column", (y0) => {
    for (const opts of MODES) {
      const rows = mapRows(asciiLevel(at(y0), null, { ...opts, legend: false }));
      const labels = rows.map((l) => LABEL.exec(l)?.[0]).filter((m) => m !== undefined);
      expect(
        labels.some((m) => m.trim().length === 4),
        JSON.stringify(opts),
      ).toBe(true);
      for (const m of labels) expect(m.length, JSON.stringify(opts)).toBe(5);
      for (const l of rows) if (!LABEL.test(l)) expect(l.startsWith("     ") || l.trim() === "").toBe(true);
    }
  });

  it("a view whose labels fit three characters keeps its four-character label column", () => {
    for (const y0 of [0, 500, -95])
      for (const opts of MODES) {
        const labels = mapRows(asciiLevel(at(y0), null, { ...opts, legend: false }))
          .map((l) => LABEL.exec(l)?.[0])
          .filter((m) => m !== undefined);
        expect(labels.length).toBeGreaterThan(0);
        for (const m of labels) expect(m.length, `${y0} ${JSON.stringify(opts)}`).toBe(4);
      }
  });
});
