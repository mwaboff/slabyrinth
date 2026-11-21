/**
 * GENERATOR 2 IS RELEASED (0.1.2) AND FROZEN. A saved plan with `generator: 2` must resolve and build to exactly
 * the same bytes in every later version of the app. This file pins a handful of engineer-written plans, each set to
 * `generator: 2` explicitly (terrain, dressing, buildings): the resolved hash, the canonical resolved form, every
 * compiled slab chunk and the diagnostics.
 *
 * If this test fails you changed what generator 2 produces. Do not update the golden. Put the change behind a switch
 * of the open generator's profile (src/plan/generator.ts), off in the released profiles.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import { bundledPalettes, loadPalettes } from "../../../src/palette";
import { canonicalResolved, resolvePlan } from "../../../src/resolve/index";
import { slabCodec } from "../../../src/slab";
import { h64hex } from "../../../src/util";
import { loadPlan } from "../../fixtures";
import { EXTRA_FIXTURES } from "../resolve/extraFixtures";

const palettes = loadPalettes();

const json = (rel: string): MapPlan =>
  JSON.parse(
    readFileSync(new URL(`../../unit/gen/fixtures/${rel}.json`, import.meta.url), "utf8"),
  ) as MapPlan;
const gen2 = (plan: MapPlan, id: string): MapPlan => ({ ...structuredClone(plan), generator: 2, id });

function town(structures: Structure[], theme: string, material: "grass" | "concrete", seed: number): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 2,
    id: "gen2-buildings",
    title: "gen2 buildings",
    kind: "outdoor",
    seed,
    theme,
    links: [],
    levels: [
      {
        id: "g",
        name: "g",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 40, h: 30 },
        base: { type: "ground", material },
        outline: "rect",
        areas: [{ id: "land", kind: "zone", shape: { type: "rect", x: 0, y: 0, w: 40, h: 30 } }],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        structures,
      },
    ],
  };
}

const tower: Building = {
  id: "tower",
  style: "wizard_tower",
  wings: [{ x: 12, y: 8, w: 10, h: 10 }],
  openings: [{ kind: "door", side: "S" }],
};
const block: Building = {
  id: "block",
  style: "modern_block",
  wings: [{ x: 4, y: 6, w: 8, h: 10 }],
  volumes: [
    { id: "tall", x: 4, y: 6, w: 8, h: 10, storeys: 5 },
    { id: "low", x: 12, y: 8, w: 12, h: 8, storeys: 1, storeyHeight: 4 },
  ],
  openings: [{ kind: "double_door", side: "S", position: 0.3, width: 2 }],
};
const keep: Building = {
  id: "hall",
  style: "keep",
  wings: [{ x: 8, y: 8, w: 10, h: 8 }],
  volumes: [
    { id: "hall", x: 8, y: 8, w: 10, h: 8, storeys: 1 },
    { id: "top", x: 10, y: 10, w: 4, h: 4, storeys: 2, on: "hall" },
  ],
  openings: [{ kind: "door", side: "S" }],
};

/** The pinned generator-2 plans: name → plan. Add plans; never edit or remove one. */
const PLANS: Array<[string, MapPlan]> = [
  // terrain and dressing
  ["hillside-v5", gen2(json("hillside-v5"), "g2-hillside")],
  ["dressed-forest-v4", gen2(json("dressed-forest-v4"), "g2-forest")],
  ["dressed-cave-v2", gen2(json("dressed-cave-v2"), "g2-cave")],
  ["example-b-outdoor", gen2(loadPlan("example-b"), "g2-example-b")],
  ["outdoor-scatter", gen2(loadPlan("outdoor-scatter"), "g2-scatter")],
  ["wp2-dress", gen2(EXTRA_FIXTURES["dress"] as MapPlan, "g2-dress")],
  ["wp2-outdoor-town", gen2(EXTRA_FIXTURES["outdoor_town"] as MapPlan, "g2-town")],
  // buildings (resolve/structure.ts, compile/structure.ts)
  [
    "building-wizard-tower-ruined",
    town(
      [
        { ...tower, condition: "ruined" },
        { ...tower, id: "tower2", style: "tower", wings: [{ x: 28, y: 10, w: 5, h: 5 }] },
      ],
      "forest",
      "grass",
      31,
    ),
  ],
  ["building-modern-block", town([block], "city", "concrete", 5)],
  ["building-keep-stacked", town([keep], "outdoor", "grass", 17)],
  [
    "building-cottages-yard",
    town(
      [
        {
          id: "yard",
          kind: "enclosure",
          name: "Yard",
          shape: { type: "rect", x: 2, y: 2, w: 18, h: 14 },
          wall: "fence",
          gates: [{ side: "S", position: 0.5, width: 2 }],
        },
        {
          id: "cottage",
          name: "Cottage",
          key: "1",
          style: "cottage",
          wings: [{ x: 7, y: 5, w: 6, h: 4 }],
          openings: [{ kind: "door", side: "S", position: 0.5 }],
          chimneys: [{ side: "W" }],
          attachments: [{ type: "porch", side: "S", width: 4, depth: 2 }],
        },
        { id: "shed", style: "cottage", seed: 9, wings: [{ x: 24, y: 6, w: 6, h: 5 }] },
        {
          id: "inn",
          style: "cottage",
          seed: 3,
          wings: [{ x: 24, y: 16, w: 9, h: 7 }],
          condition: "weathered",
        },
      ],
      "forest",
      "grass",
      4242,
    ),
  ],
];

function build(plan: MapPlan): string {
  const resolved = resolvePlan(plan, bundledPalettes());
  const bundle = compileResolved(resolved, palettes, slabCodec, { createdAt: "t", plan });
  const sev = (s: string): number => bundle.diagnostics.filter((d) => d.severity === s).length;
  return [
    `resolved=${resolved.hash}`,
    `canonical=${h64hex(canonicalResolved(resolved))}`,
    `chunks=${String(bundle.chunks.length)}`,
    `slab=${h64hex(bundle.chunks.map((c) => c.slab).join("\n"))}`,
    `assets=${String(bundle.chunks.reduce((n, c) => n + c.assetCount, 0))}`,
    `diag=${String(sev("error"))}e/${String(sev("warning"))}w/${String(sev("info"))}i`,
  ].join(" ");
}

describe("generator 2 is frozen", () => {
  it("every pinned plan is generator 2", () => {
    for (const [name, plan] of PLANS) expect(plan.generator, name).toBe(2);
  });

  it("resolved hash, canonical form, slabs and diagnostics match the 0.1.2 release", async () => {
    const lines = PLANS.map(([name, plan]) => `${name} ${build(plan)}`);
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("__golden__/generator2.txt");
  });

  it("each plan builds without errors", () => {
    for (const [name, plan] of PLANS) {
      const bundle = compileResolved(resolvePlan(plan, bundledPalettes()), palettes, slabCodec, { createdAt: "t", plan });
      expect(
        bundle.diagnostics.filter((d) => d.severity === "error"),
        name,
      ).toEqual([]);
    }
  });
});
