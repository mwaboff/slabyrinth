/**
 * Generator 3 ground patches (a chapel on a knoll): red-brown earth and litter tiles lay as
 * hard-edged single squares all over the grass, mostly along every half-tile step of the knoll. A rise under a tile is
 * not a cause; a patch is a ragged blob of several cells round a real cause; all patches stay a few percent of the
 * open ground.
 */
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
import { createRoleResolver } from "../../../src/palette/resolve";
import { PATCH, familiesOfVariants, patchStats } from "../../../src/resolve/floorFamilies";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";

const knoll = (tier: number, extra: object[] = []): MapPlan =>
  ({
    schema: "slabyrinth/plan@1",
    generator: 3,
    id: "9b1c0d52-7a3e-4f10-8c64-2d5e8a7f3b19",
    title: "Knoll",
    kind: "outdoor",
    seed: 31,
    theme: "outdoor",
    summary: "A low grassy knoll.",
    levels: [
      {
        id: "l1",
        name: "Knoll",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 48, h: 40 },
        base: { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        labels: [],
        features: [],
        terrain: [
          {
            id: "knoll",
            op: "platform",
            shape: { type: "circle", cx: 24, cy: 20, r: 13 },
            tiers: 4,
            rise: tier,
            inset: 3,
            material: "grass",
            edge: "clean",
          },
          ...extra,
        ],
      },
    ],
    links: [],
  }) as unknown as MapPlan;

function stats(plan: MapPlan) {
  const r = resolvePlan(plan);
  const L = r.levels[0];
  if (!L) throw new Error("no level");
  const res = createRoleResolver(loadPalettes())("outdoor", "floor.grass").resolution;
  const fams = familiesOfVariants(res?.variants ?? []);
  return { L, fams, s: patchStats(L, 31, fams) };
}

describe("generator 3 ground patches", () => {
  it("the grass has a second, caused family to patch with", () => {
    const { fams } = stats(knoll(0.5));
    expect(fams.length).toBeGreaterThanOrEqual(2);
  });

  it("lays no patches along half-tile steps: a rise under a tile is not a cause", () => {
    const { s } = stats(knoll(0.5));
    expect(s.cells).toBe(0);
  });

  it("lays patches as blobs, never single squares, and only a few percent of the ground", () => {
    // trees are a real cause
    const trees = Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`,
      type: "tree",
      at: [8 + ((i * 7) % 30), 6 + ((i * 11) % 26)],
    }));
    const r = stats({
      ...knoll(0.5),
      levels: [{ ...knoll(0.5).levels[0], features: trees }],
    } as unknown as MapPlan);
    expect(r.s.cells).toBeGreaterThanOrEqual(8);
    expect(r.s.share).toBeLessThanOrEqual(PATCH.maxShare + 0.001);
    expect(r.s.lonely).toBe(0);
  });

  it("is deterministic", () => {
    expect(stats(knoll(0.5)).s).toEqual(stats(knoll(0.5)).s);
  });
});
