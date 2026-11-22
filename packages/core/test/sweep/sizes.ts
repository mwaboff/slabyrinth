/**
 * Map size measurements, from packages/core:
 *   npx tsx test/sweep/sizes.ts                      the largest fixtures and the synthetic plans at 160, 240, 320
 *   npx tsx test/sweep/sizes.ts forest:1024 dungeon:320:2 mixed:768
 * A run is `kind:side[:levels]` with kind forest (sparse: ground, trail, scattered trees and rocks), mixed (forest
 * with a village of huts) or dungeon (every cell a dressed room) from test/fixtures/largePlan.ts; validation uses the
 * smallest size tier the plan fits (plan/sizeTiers.ts). Times every stage the app runs on a plan (validate with the
 * plan rules, resolve, compile = realize + verify + chunk + encode, the design review with the build, the 2D display
 * list of each level) and prints the chunk count, total slab bytes, the largest stored coordinate and the process's
 * peak resident memory so far (run one plan per process for its own peak). The numbers behind PLAN_LIMITS and the size
 * tiers (docs/decisions.md 2026-11-21 and 2026-11-22).
 */
import type { MapPlan } from "../../src/contracts/plan";
import { compileResolved, realize } from "../../src/compile";
import { loadPalettes } from "../../src/palette";
import { smallestTierFor } from "../../src/plan/sizeTiers";
import { validatePlan } from "../../src/plan/validate";
import { buildPlanDisplayList } from "../../src/render";
import { planRules, resolvePlan } from "../../src/resolve/index";
import { reviewDesign } from "../../src/review";
import { SLAB_LIMITS, decodeDetailed, slabCodec } from "../../src/slab";
import { loadPlan, type StoredPlan } from "../fixtures";
import { largeDungeonPlan, largeMixedPlan, largeOutdoorPlan } from "../fixtures/largePlan";

const cat = loadPalettes();

function timed<T>(f: () => T): [T, number] {
  const t = performance.now();
  const r = f();
  return [r, Math.round(performance.now() - t)];
}

function measure(label: string, plan: MapPlan): void {
  const tier = smallestTierFor(plan) ?? "large-1024";
  const [v, tValidate] = timed(() => validatePlan(plan, planRules(cat, { sizeTier: tier })));
  const errors = v.issues.filter((i) => i.severity === "error");
  const [resolved, tResolve] = timed(() => resolvePlan(plan, cat));
  const [bundle, tCompile] = timed(() => compileResolved(resolved, cat, slabCodec, { createdAt: "t", plan }));
  const [, tReview] = timed(() =>
    reviewDesign(plan, resolved, cat, {
      diagnostics: bundle.diagnostics,
      placements: realize(resolved, cat, {}),
    }),
  );
  const [, tDisplay] = timed(() => resolved.levels.map((l) => buildPlanDisplayList(resolved, l.id)));
  const bytes = bundle.chunks.reduce((s, c) => s + c.compressedBytes, 0);
  let maxCoord = 0;
  for (const c of bundle.chunks)
    for (const a of decodeDetailed(c.slab).assets) maxCoord = Math.max(maxCoord, a.sx, a.sy, a.sz);
  const buildErrors = bundle.diagnostics.filter((d) => d.severity === "error");
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(
    [
      label.padEnd(22),
      tier.padEnd(10),
      `validate ${tValidate}`.padStart(14),
      `resolve ${tResolve}`.padStart(14),
      `compile ${tCompile}`.padStart(14),
      `review ${tReview}`.padStart(13),
      `2d ${tDisplay}`.padStart(8),
      `assets ${bundle.stats.totalAssets}`.padStart(15),
      `chunks ${bundle.chunks.length}`.padStart(11),
      `${Math.round(bytes / 1024)} KB`.padStart(8),
      `maxCoord ${maxCoord}/${SLAB_LIMITS.maxCoord}`.padStart(23),
      `peak ${peak} MB`.padStart(13),
      `plan JSON ${JSON.stringify(plan).length}`,
      errors.length ? `plan errors: ${[...new Set(errors.map((e) => e.code))].join(",")}` : "",
      buildErrors.length ? `build errors: ${[...new Set(buildErrors.map((e) => e.code))].join(",")}` : "",
    ].join(" "),
  );
}

const PLANS: Record<string, (side: number, levels: number) => MapPlan> = {
  forest: (side) => largeOutdoorPlan(side),
  mixed: (side) => largeMixedPlan(side),
  dungeon: (side, levels) => largeDungeonPlan(side, levels),
};

const args = process.argv.slice(2);
console.log(
  "times in ms (validate, resolve, compile = realize+verify+chunk+encode, review, 2d = the display lists; painting them, not timed here, took 10-40 ms at 320 when measured)",
);
if (args.length === 0) {
  for (const name of [
    "keep-dungeon-v8",
    "market-street-v3",
    "smugglers-grotto-v3",
    "heartroot-rift-v7",
  ] as StoredPlan[])
    measure(`fixture ${name}`, loadPlan(name));
  for (const side of [160, 240, 320])
    for (const kind of ["forest", "mixed", "dungeon"]) args.push(`${kind}:${side}`);
}
for (const a of args) {
  const [kind = "", side = "320", levels = "1"] = a.split(":");
  const make = PLANS[kind];
  if (!make) throw new Error(`unknown kind "${kind}" (forest, mixed, dungeon)`);
  measure(a, make(Number(side), Number(levels)));
}
