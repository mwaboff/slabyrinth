/**
 * How floor pieces cover their cells (palette/topCover.ts, generator 6 `measuredFloorCover`): the measured table covers
 * the pieces the bundled palettes lay as floors and nothing else, and a floor is laid without the pieces whose top
 * leaves a hole, by that measure and not by name.
 */
import { describe, expect, it } from "vitest";
import { realize } from "../../../src/compile";
import { FLOOR_HOLE, coverPieces, floorHoleOf, leavesFloorHole, loadPalettes } from "../../../src/palette";
import { MEASURED_HOLES, UNREAD_HOLES } from "../../../src/palette/coverHoles";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan } from "../../fixtures";

const RERUN =
  "run `npm run render -- rests` on a machine with TaleSpire installed (it rewrites palette/coverHoles.ts)";

describe("the measured floor cover table (palette/coverHoles.ts)", () => {
  const pieces = coverPieces(loadPalettes().palettes);
  const ids = new Set(pieces.map((p) => p.asset));

  it("lists every piece of the bundled palettes' floor roles, measured or unread", () => {
    const missing = pieces
      .filter((p) => !Object.hasOwn(MEASURED_HOLES, p.asset) && !UNREAD_HOLES.includes(p.asset))
      .map((p) => `${p.name} (${p.asset})`);
    expect(missing, `pieces never measured: ${RERUN}`).toEqual([]);
  });

  it("names no piece the bundled palettes do not (numbers for the palettes' own pieces only)", () => {
    const stale = [...Object.keys(MEASURED_HOLES), ...UNREAD_HOLES].filter((id) => !ids.has(id));
    expect(stale, `ids no bundled palette names: ${RERUN}`).toEqual([]);
  });

  it("holds holes no larger than the piece's own outline", () => {
    for (const p of pieces) {
      const hole = floorHoleOf(p.asset);
      if (hole === undefined) continue;
      expect(hole, p.name).toBeGreaterThanOrEqual(0);
      expect(hole, p.name).toBeLessThanOrEqual(p.geom.size.x * p.geom.size.z);
    }
  });

  it("a piece never measured counts as whole", () => {
    expect(leavesFloorHole("00000000-0000-0000-0000-000000000000")).toBe(false);
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
      .filter((p) => p.role === "floor" && leavesFloorHole(p.asset))
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
      .filter((p) => (floorHoleOf(p.asset) ?? 0) >= FLOOR_HOLE)
      .map((p) => p.name);
  }
});
