/**
 * A cliff's rock band keeps off a bridge's deck (generator 5, switch bandsClearBridges; found by the seed sweep once it
 * read playability). hillside-v5@2027808452: a cliff face of the plateau's band stood over the top of the plank walkway
 * climbing from the watchtower to the plateau, so the walkway and the tower were cut off. The band kept off links and
 * paths, not decks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CELL_FLAG } from "../../../src/contracts/resolved";
import { bundledPalettes } from "../../../src/palette";
import { GENERATOR_PROFILES, type GeneratorProfile } from "../../../src/plan/generator";
import { resolvePlan } from "../../../src/resolve";
import { sweepPlan } from "../../sweep/seeds";

const pal = bundledPalettes();
const P5 = GENERATOR_PROFILES[5] as { -readonly [K in keyof GeneratorProfile]: GeneratorProfile[K] };
const saved = { ...P5 };
afterEach(() => Object.assign(P5, saved));

/** The band pieces (cliff faces and crests) standing over a bridge deck's cell. */
function bandOnDecks(seed: number): string[] {
  const r = resolvePlan(sweepPlan("hillside-v5", seed, 5), pal);
  const out: string[] = [];
  for (const L of r.levels)
    for (const f of L.features) {
      if (f.type !== "cliff_face" && f.type !== "cliff_crest") continue;
      for (let dy = 0; dy < f.size[1]; dy++)
        for (let dx = 0; dx < f.size[0]; dx++) {
          const x = f.at[0] + dx - L.bounds.x;
          const y = f.at[1] + dy - L.bounds.y;
          if (x < 0 || y < 0 || x >= L.bounds.w || y >= L.bounds.h) continue;
          if (((L.cells.flags[y * L.bounds.w + x] ?? 0) & CELL_FLAG.BRIDGE) !== 0) out.push(f.id);
        }
    }
  return [...new Set(out)];
}

describe("a cliff's rock band keeps off a bridge's deck (bandsClearBridges)", () => {
  it("no band piece stands over the walkway (hillside-v5, a few seeds)", () => {
    for (const seed of [2027808452, 3028372918, 1]) expect(bandOnDecks(seed), String(seed)).toEqual([]);
  }, 30_000);

  it("without the switch a cliff face stands over the walkway's top", () => {
    P5.bandsClearBridges = false;
    expect(bandOnDecks(2027808452)).toContain("hill~bands1#9");
  }, 30_000);
});
