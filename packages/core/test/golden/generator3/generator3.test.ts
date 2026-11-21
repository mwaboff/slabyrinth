/**
 * GENERATOR 3 IS RELEASED (0.2.0) AND FROZEN. A saved plan with `generator: 3` must resolve and build to exactly
 * the same bytes in every later version of the app. This file pins a handful of engineer-written plans, each set to
 * `generator: 3` explicitly (terrain, dressing, buildings, a market street, stacked levels with a floor opening):
 * the resolved hash, the canonical resolved form, every compiled slab chunk and the diagnostics.
 *
 * The palettes the generator sees are pinned too: test/fixtures/released-palettes-0.2.0.json
 * (test/unit/palette/released.test.ts). The prompt, principles and tool texts that shipped with it (sp-1.12.0,
 * dp-1.2.0, tools-1.8.0) are pinned in test/unit/agent/tools.test.ts.
 *
 * If this test fails you changed what generator 3 produces. Do not update the golden, and never touch the
 * generator-2 golden either. Put the change behind a switch of the open generator's profile (src/plan/generator.ts),
 * off in the released profiles.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileResolved } from "../../../src/compile";
import type { CompileDiagnostic } from "../../../src/contracts/compiler";
import type { Building, MapPlan, Structure } from "../../../src/contracts/plan";
import { loadPalettes } from "../../../src/palette";
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
const stored = (rel: string): MapPlan =>
  JSON.parse(readFileSync(new URL(`../../fixtures/plans/${rel}.json`, import.meta.url), "utf8")) as MapPlan;
const gen3 = (plan: MapPlan, id: string): MapPlan => ({ ...structuredClone(plan), generator: 3, id });

function town(
  structures: Structure[],
  theme: string,
  material: "grass" | "concrete",
  seed: number,
  extra: Partial<MapPlan["levels"][number]> = {},
): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator: 3,
    id: "gen3-buildings",
    title: "gen3 buildings",
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
        ...extra,
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

/** Two levels 4 tiles apart; the upper room has an opening over the open floor of the hall below. */
function stackedOpening(): MapPlan {
  const plan = gen3(loadPlan("multi-level-stairs"), "g3-floor-opening");
  const [ground, study, roof] = plan.levels;
  if (!ground || !study || !roof) throw new Error("fixture changed");
  study.elevation = 4;
  roof.elevation = 8;
  study.terrain = [{ id: "hole", op: "floor_opening", shape: { type: "rect", x: 3, y: 3, w: 3, h: 3 }, kind: "collapse" }];
  return plan;
}

/** The pinned generator-3 plans: name → plan. Add plans; never edit or remove one. */
const PLANS: Array<[string, MapPlan]> = [
  // terrain and dressing
  ["hillside-v5", gen3(json("hillside-v5"), "g3-hillside")],
  ["dressed-forest-v4", gen3(json("dressed-forest-v4"), "g3-forest")],
  ["dressed-cave-v2", gen3(json("dressed-cave-v2"), "g3-cave")],
  ["terraced-hill", gen3(json("terraced-hill"), "g3-terraced-hill")],
  ["sea-grotto", gen3(json("sea-grotto"), "g3-sea-grotto")],
  ["example-b-outdoor", gen3(loadPlan("example-b"), "g3-example-b")],
  ["outdoor-scatter", gen3(loadPlan("outdoor-scatter"), "g3-scatter")],
  ["wp2-dress", gen3(EXTRA_FIXTURES["dress"] as MapPlan, "g3-dress")],
  ["wp2-outdoor-town", gen3(EXTRA_FIXTURES["outdoor_town"] as MapPlan, "g3-town")],
  // rifts, stepped rivers, landmarks
  ["heartroot-rift-v7", gen3(stored("heartroot-rift-v7"), "g3-rift")],
  ["three-step-glen-v1", gen3(stored("three-step-glen-v1"), "g3-glen")],
  ["old-stones-glade-v6", gen3(stored("old-stones-glade-v6"), "g3-glade")],
  // stacked levels with a floor opening
  ["floor-opening", stackedOpening()],
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
    "building-ruin-overgrown",
    town(
      [
        { ...keep, id: "chapel", condition: "ruined", growth: "heavy" },
        { id: "cot", style: "cottage", seed: 2, wings: [{ x: 26, y: 8, w: 6, h: 5 }], condition: "weathered" },
      ],
      "forest",
      "grass",
      77,
    ),
  ],
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
  // a market street: trade shop fronts, stalls and lines strung overhead
  [
    "market-street",
    town(
      [
        { id: "baker", style: "cottage", use: "baker", seed: 4, wings: [{ x: 3, y: 3, w: 7, h: 5 }] },
        { id: "smith", style: "cottage", use: "smith", seed: 5, wings: [{ x: 11, y: 3, w: 7, h: 5 }] },
        { id: "apoth", style: "cottage", use: "apothecary", seed: 6, wings: [{ x: 19, y: 3, w: 7, h: 5 }] },
        { id: "inn", style: "cottage", use: "inn", seed: 7, wings: [{ x: 27, y: 3, w: 9, h: 6 }] },
      ],
      "wood_town",
      "grass",
      909,
      {
        stalls: [
          { id: "row", area: { x: 4, y: 14, w: 22, h: 6 }, goods: ["fruit", "vegetables", "magic", "weapons"], aisle: 2 },
        ],
        lines: [
          { id: "lanterns", from: [4, 12], to: [26, 12], kind: "lanterns" },
          { id: "flags", from: [4, 22], to: [26, 22], kind: "flags" },
        ],
      },
    ),
  ],
];

/** One build of a plan: its golden line (name first) and its error diagnostics. */
function build(name: string, plan: MapPlan): { line: string; errors: CompileDiagnostic[] } {
  const resolved = resolvePlan(plan);
  const bundle = compileResolved(resolved, palettes, slabCodec, { createdAt: "t", plan });
  const sev = (s: string): number => bundle.diagnostics.filter((d) => d.severity === s).length;
  const line = [
    name,
    `resolved=${resolved.hash}`,
    `canonical=${h64hex(canonicalResolved(resolved))}`,
    `chunks=${String(bundle.chunks.length)}`,
    `slab=${h64hex(bundle.chunks.map((c) => c.slab).join("\n"))}`,
    `assets=${String(bundle.chunks.reduce((n, c) => n + c.assetCount, 0))}`,
    `diag=${String(sev("error"))}e/${String(sev("warning"))}w/${String(sev("info"))}i`,
  ].join(" ");
  return { line, errors: bundle.diagnostics.filter((d) => d.severity === "error") };
}

/**
 * The golden file holds one line per pinned plan, in PLANS order. It is read, never written: `vitest -u` cannot
 * rewrite a released golden. A new plan's line is added to the file by hand (the failing test prints it).
 */
const GOLDEN_LINES = readFileSync(new URL("__golden__/generator3.txt", import.meta.url), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const goldenLine = (name: string): string | undefined => GOLDEN_LINES.find((l) => l.split(" ")[0] === name);

describe("generator 3 is frozen", () => {
  it("every pinned plan is generator 3", () => {
    for (const [name, plan] of PLANS) expect(plan.generator, name).toBe(3);
  });

  it("the golden file lists exactly the pinned plans, in order", () => {
    expect(GOLDEN_LINES.map((l) => l.split(" ")[0])).toEqual(PLANS.map(([name]) => name));
  });

  // one test per plan, so a failure names the plan and one slow build cannot time out the others
  it.each(PLANS)(
    "%s: resolved hash, canonical form, slabs and diagnostics match the 0.2.0 release, no errors",
    (name, plan) => {
      const { line, errors } = build(name, plan);
      expect(line, `no golden line for ${name}: add this line to __golden__/generator3.txt`).toBe(
        goldenLine(name),
      );
      expect(errors, name).toEqual([]);
    },
  );

  it("the pinned plans really exercise stalls, overhead lines and a floor opening", () => {
    const get = (name: string): MapPlan => {
      const p = PLANS.find(([n]) => n === name)?.[1];
      if (!p) throw new Error(`no pinned plan ${name}`);
      return p;
    };
    const market = resolvePlan(get("market-street")).levels[0];
    expect(market?.lines?.length).toBeGreaterThan(0);
    expect(market?.features.filter((f) => f.type === "stall").length).toBeGreaterThan(0);
    const opening = resolvePlan(get("floor-opening")).levels.flatMap((l) => l.floorOpenings ?? []);
    expect(opening.length).toBe(1);
    expect(opening[0]?.floorBelow).toBeGreaterThan(0);
  });
});
