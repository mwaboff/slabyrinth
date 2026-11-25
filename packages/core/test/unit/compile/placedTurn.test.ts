/**
 * One world turn per placed piece: realize decides it once when it places the piece (compile/realize/level.ts `emit`,
 * with the build's orientation) and settle, the stall canopies and verify read that one (RealizedSet.turns), so a user
 * orientation override of the other turn direction never has verify read a support's top mirrored.
 */
import { describe, expect, it } from "vitest";
import type { OrientationCalibration } from "../../../src/contracts/compiler";
import { realize } from "../../../src/compile";
import { worldTurn } from "../../../src/compile/geometry";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { bundledPalettes } from "../../../src/palette";
import { loadOrientation } from "../../../src/palette/load";
import { resolvePlan } from "../../../src/resolve";
import { loadPlan, type StoredPlan } from "../../fixtures";

const pal = bundledPalettes();
const bundled = loadOrientation().orientation;
const other: OrientationCalibration = { ...bundled, rotSense: bundled.rotSense === 1 ? -1 : 1 };

/** The `verify_prop_floating` warnings of a plan built at generator 6 with `orientation`. */
const floating = (name: StoredPlan, orientation: OrientationCalibration): string[] => {
  const plan = { ...loadPlan(name), generator: 6 as const };
  const r = resolvePlan(plan, pal);
  const set = realize(r, pal, { orientation });
  return verifyBuild(r, set, pal, { plan, flipZ: orientation.flipZ })
    .diagnostics.filter((d) => d.code === "verify_prop_floating")
    .map((d) => d.message);
};

describe("a placed piece's world turn is decided once (RealizedSet.turns)", () => {
  it("realize records the turn it placed each piece with", () => {
    const r = resolvePlan({ ...loadPlan("inn-interior-v1"), generator: 6 }, pal);
    const set = realize(r, pal, { orientation: other });
    for (const l of set.levels)
      for (const p of l.placements) expect(set.turns.get(p)).toBe(worldTurn(p.rot, other));
  });

  it("with an override of the other turn direction, verify judges things on furniture as realize set them", () => {
    // with the bundled calibration nothing on these plans floats; built the other way round, nothing may either
    for (const name of ["inn-interior-v1", "interiors-lineup-v1", "stated-character-v1"] as const) {
      expect(floating(name, bundled), name).toEqual([]);
      expect(floating(name, other), name).toEqual([]);
    }
  });
});
