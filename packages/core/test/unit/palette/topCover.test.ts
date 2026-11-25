/**
 * How floor pieces cover their cells (palette/topCover.ts, generator 6 `measuredFloorCover`): a floor is laid without
 * the pieces whose top leaves a hole, by that measure and not by name (the table's coverage and guards:
 * measuredTables.test.ts).
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { FLOOR_HOLE, coverPieces, floorHoleOf, leavesFloorHole, loadPalettes } from "../../../src/palette";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";

describe("the measured floor cover table (palette/coverHoles.ts)", () => {
  const pieces = coverPieces(loadPalettes().palettes);

  it("holds holes no larger than the piece's own outline", () => {
    for (const p of pieces) {
      const hole = floorHoleOf(p.asset, p.geom);
      if (hole === undefined) continue;
      expect(hole, p.name).toBeGreaterThanOrEqual(0);
      expect(hole, p.name).toBeLessThanOrEqual(p.geom.size.x * p.geom.size.z);
    }
  });

  it("a piece never measured counts as whole", () => {
    const any = pieces[0]?.geom;
    if (!any) throw new Error("fixture: the bundled palettes have floor pieces");
    expect(leavesFloorHole("00000000-0000-0000-0000-000000000000", any)).toBe(false);
  });
});

describe("floors are laid from whole pieces (generator 6, measuredFloorCover)", () => {
  const fixture = loadPlan("heartroot-rift-v7");
  const palettes = loadPalettes();
  /** Floor placements whose piece leaves a measured hole. */
  const holed = (generator: 5 | 6): string[] => {
    const set = realize(resolvePlan({ ...fixture, generator }, palettes), palettes, {});
    return set.levels
      .flatMap((l) => l.placements)
      .filter((p) => {
        const geom = set.placed.get(p)?.geom;
        return p.role === "floor" && geom !== undefined && leavesFloorHole(p.asset, geom);
      })
      .map((p) => `${p.asset} at ${String(p.x)},${String(p.z)}`);
  };

  it("the cave's floor role has a piece whose top leaves an open wedge", () => {
    const res = paletteHoles();
    expect(res.length).toBeGreaterThan(0);
  });

  it("generator 5 lays it mid-floor; generator 6 lays none", () => {
    expect(holed(5).length).toBeGreaterThan(0);
    expect(holed(6)).toEqual([]);
  });

  /** Pieces of the bundled palettes' floor roles whose measured hole is a floor hole. */
  function paletteHoles(): string[] {
    return coverPieces(palettes.palettes)
      .filter((p) => (floorHoleOf(p.asset, p.geom) ?? 0) >= FLOOR_HOLE)
      .map((p) => p.name);
  }
});
