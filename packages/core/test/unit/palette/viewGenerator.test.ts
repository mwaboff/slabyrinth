/**
 * The palette view is per catalog AND per generator (palette/view.ts paletteView): a plan never sees a role that starts
 * in a later generator (`minGenerator`), so adding a role for a new generator cannot move an older generator's resolve.
 */
import { describe, expect, it } from "vitest";
import { canonicalResolved, resolvePlan } from "../../../src/resolve";
import { bundledPalettes } from "../../../src/palette";
import type { ResolvePalettes } from "../../../src/palette/resolve";
import { paletteView } from "../../../src/palette/view";
import { loadPlan } from "../../fixtures";

/** The bundled catalog with a much taller table in wood_town that starts in generator `since`. */
function withLaterTable(since: number): ResolvePalettes {
  const base = bundledPalettes();
  const wood = base.palettes.wood_town;
  const table = base.palettes.generic?.roles["feature.table"];
  if (!wood || !table) throw new Error("bundled palettes lack wood_town or generic's table");
  const tall = {
    ...table,
    minGenerator: since,
    variants: table.variants.map((v) => ({ ...v, geom: { ...v.geom, size: { ...v.geom.size, y: 3 } } })),
  };
  return {
    ...base,
    palettes: { ...base.palettes, wood_town: { ...wood, roles: { ...wood.roles, "feature.table": tall } } },
  };
}

describe("the palette view is keyed by generator", () => {
  it("a generator does not see a role that starts after it", () => {
    const later = withLaterTable(4);
    expect(paletteView(later, 4).pieceSize("wood_town", "table", true)?.h).toBe(3);
    expect(paletteView(later, 3).pieceSize("wood_town", "table", true)?.h).toBeCloseTo(0.738, 3);
    expect(paletteView(later, 3)).not.toBe(paletteView(later, 4));
    expect(paletteView(later, 4)).toBe(paletteView(later, 4));
  });

  it("a formal place is asked of the view (code fallback by theme id until palettes carry it); no bundled theme is one", () => {
    const view = paletteView(bundledPalettes());
    expect(view.formalLayout("temple")).toBe(true);
    for (const theme of Object.keys(bundledPalettes().palettes))
      expect(view.formalLayout(theme), theme).toBe(false);
  });

  it("a role for generator 5 leaves a generator-4 resolve byte-identical", () => {
    const plan = loadPlan("inn-interior-v1");
    expect(plan.generator).toBe(4);
    expect(canonicalResolved(resolvePlan(plan, withLaterTable(5)))).toBe(
      canonicalResolved(resolvePlan(plan, bundledPalettes())),
    );
  });
});
