/**
 * Things a room recipe lifts onto furniture or a shelf in a building's ground storey stay under its wall top, where the
 * floor of the storey above begins (generator 6, `storeyHeadroom`, resolve/level/grid.ts headroomAt).
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, type StoredPlan } from "../../fixtures";

/** Lifted things in a ground storey that rise past its wall top (into the floor of the storey above). */
function throughCeiling(name: StoredPlan, generator: 5 | 6): string[] {
  const palettes = loadPalettes();
  const r = resolvePlan({ ...loadPlan(name), generator }, palettes);
  const set = realize(r, palettes, {});
  const out: string[] = [];
  for (const L of r.levels) {
    const lv = set.levels.find((l) => l.levelId === L.id);
    if (!lv) continue;
    const lifted = new Map(L.features.map((f) => [f.id, f]));
    for (const s of L.structures ?? []) {
      const ground = s.storeys[0];
      if (s.kind !== "building" || !ground || s.storeys.length < 2) continue;
      const cells = new Set(s.cells.map(([x, y]) => `${String(x)},${String(y)}`));
      const ceiling = ground.floorTop + ground.wallHeight;
      for (const p of lv.placements) {
        const f = lifted.get(p.source.elementId ?? "");
        if (!f || f.baseHeight <= ground.floorTop + 0.1 || !cells.has(`${String(f.at[0])},${String(f.at[1])}`))
          continue;
        const top = set.placed?.get(p)?.box.max.y ?? -Infinity;
        if (top > ceiling + 0.01) out.push(`${set.placed?.get(p)?.name ?? p.asset} (${f.id}) top ${top.toFixed(2)}`);
      }
    }
  }
  return out;
}

describe("things lifted in a ground storey stay under the storey above (generator 6, storeyHeadroom)", () => {
  it("at generator 5 jars on a tall shelf rise into the upper storey's floor", () => {
    expect(throughCeiling("two-quarters-v1", 5).length).toBeGreaterThan(0);
  });

  it("at generator 6 none does", () => {
    expect(throughCeiling("two-quarters-v1", 6)).toEqual([]);
    expect(throughCeiling("market-street-v3", 6)).toEqual([]);
    expect(throughCeiling("varied-street-v1", 6)).toEqual([]);
  });
});
