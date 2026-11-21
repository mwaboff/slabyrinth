/**
 * Review wiring for the generator-3 cave checks: the rock-mass notes need a build (ReviewOptions.placements), the
 * focal_unlit note works from the resolved level (a focal feature with no light source within a few cells), and the
 * dressing places a light by a generated landmark at generator 3.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MapPlan } from "../../../src/contracts/plan";
import { realize } from "../../../src/compile";
import { LIGHT_FEATURES } from "../../../src/gen/catalog";
import { loadPalettes } from "../../../src/palette";
import { reviewDesign } from "../../../src/review";
import { resolvePlan } from "../../../src/resolve/index";
import "../../../src/resolve/autoregister";

const fixture = JSON.parse(
  readFileSync(new URL("../gen/fixtures/sea-grotto.json", import.meta.url), "utf8"),
) as MapPlan;
const palettes = loadPalettes();

describe("cave rock mass notes in the review", () => {
  it("a built generator-3 cave passes the four mass checks; the notes need the build", () => {
    const r = resolvePlan(fixture);
    const set = realize(r, palettes, {});
    const codes = reviewDesign(fixture, r, { palettes, placements: set, limit: 99 }).map((n) => n.code);
    for (const c of ["cave_rock_uncovered", "cave_mass_gaps", "cave_rock_tones", "cave_wall_row"])
      expect(codes).not.toContain(c);
  });
});

describe("focal_unlit", () => {
  const withFeatures = (features: MapPlan["levels"][number]["features"]): MapPlan => ({
    ...fixture,
    // no dress ops: only the features given stand on the level
    levels: fixture.levels.map((l) => ({
      ...l,
      features,
      terrain: l.terrain.filter((t) => t.op !== "dress"),
    })),
  });
  const codes = (plan: MapPlan): string[] =>
    reviewDesign(plan, resolvePlan(plan), { palettes, limit: 99 }).map((n) => n.code);

  it("fires for a landmark in the dark and not when a lantern stands within four cells", () => {
    const dark = withFeatures([{ id: "stone", type: "landmark", at: [8, 24], label: "Standing stone" }]);
    expect(codes(dark)).toContain("focal_unlit");
    const lit = withFeatures([
      { id: "stone", type: "landmark", at: [8, 24], label: "Standing stone" },
      { id: "lamp", type: "lantern", at: [10, 24], label: "Lamp" },
    ]);
    expect(codes(lit)).not.toContain("focal_unlit");
  });

  it("is silent for generator 2 plans (their notes are frozen)", () => {
    const dark = {
      ...withFeatures([{ id: "stone", type: "landmark", at: [8, 24], label: "Standing stone" }]),
      generator: 2 as const,
    };
    expect(codes(dark)).not.toContain("focal_unlit");
  });
});

describe("a landmark is lit by the dressing at generator 3", () => {
  const glade = JSON.parse(
    readFileSync(new URL("../../fixtures/plans/old-stones-glade-v6.json", import.meta.url), "utf8"),
  ) as MapPlan;
  it("no generated landmark stands without a light within four cells", () => {
    const plan = { ...glade, generator: 3 as const };
    const r = resolvePlan(plan);
    const L = r.levels[0];
    if (!L) throw new Error("no level");
    const lights = L.features.filter((f) => LIGHT_FEATURES.has(f.type));
    for (const f of L.features.filter(
      (q) => q.type === "landmark" || q.type === "statue" || q.type === "altar",
    )) {
      const near = lights.some(
        (l) => Math.max(Math.abs(l.at[0] - f.at[0]), Math.abs(l.at[1] - f.at[1])) <= 5 + f.size[0],
      );
      expect(near, `${f.type} at ${f.at.join(",")}`).toBe(true);
    }
  });
});
