/**
 * A plinth runs under its building's porches (generator 5, switch plinthUnderPorch): a north-facing cottage of the
 * two-quarters street drew a plinth and a porch; the porch stood at the building's floor two tiles above the ground,
 * past the plinth's edge, and the build warned verify_cliff_gap. Without the switch it still does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { slabCodec } from "../../../src/slab";
import { loadPlan } from "../../fixtures";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

describe("plinthUnderPorch", () => {
  const plan = { ...loadPlan("two-quarters-v1"), seed: 2654435761 };
  const gaps = () =>
    compileResolved(resolvePlan(plan, pal), pal, slabCodec, { createdAt: "t" }).diagnostics.filter(
      (d) => d.code === "verify_cliff_gap",
    ).length;

  it("a porch stands on the plinth: no cliff gap; without the switch the porch stands past its edge", () => {
    // (the street as it was drawn when the fault was found: the later draw rules pick other designs for hovel2)
    P5.readableNeighbours = false;
    P5.themeOwnRange = false;
    const hovel = resolvePlan(plan, pal).levels[0]?.structures?.find((s) => s.id === "hovel2");
    expect(hovel?.plinth).toBeDefined();
    expect((hovel?.porches.length ?? 0) > 0).toBe(true);
    const plinth = new Set((hovel?.plinth?.cells ?? []).map(([x, y]) => `${x},${y}`));
    for (const p of hovel?.porches ?? [])
      for (const [x, y] of p.cells) expect(plinth.has(`${x},${y}`)).toBe(true);
    const L0 = resolvePlan(plan, pal).levels[0];
    const tall = (L0?.cliffs ?? []).flatMap((r) => r.edges).filter((e) => e.high - e.low >= 8);
    expect(gaps(), JSON.stringify(tall)).toBe(0);
    P5.plinthUnderPorch = false;
    expect(gaps()).toBeGreaterThan(0);
  });
});
