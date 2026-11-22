/**
 * Map size measurements: `npx tsx test/sweep/sizes.ts [side ...]` from packages/core (default 160 240 320).
 * For the largest stored fixtures and for the synthetic large plans (test/fixtures/largePlan.ts) at each side, times
 * every stage the app runs on a plan (validate with the plan rules, resolve, compile = realize + verify + chunk +
 * encode, the design review with the build, the 2D display list of each level), and prints the chunk
 * count, total slab bytes, the largest coordinate a chunk stores and the process's resident memory after the run.
 * The numbers behind PLAN_LIMITS.levelSide (docs/decisions.md 2026-11-21).
 */
import type { MapPlan } from "../../src/contracts/plan";
import { compileResolved, realize } from "../../src/compile";
import { loadPalettes } from "../../src/palette";
import { validatePlan } from "../../src/plan/validate";
import { buildPlanDisplayList } from "../../src/render";
import { planRules, resolvePlan } from "../../src/resolve/index";
import { reviewDesign } from "../../src/review";
import { SLAB_LIMITS, decodeDetailed, slabCodec } from "../../src/slab";
import { loadPlan, type StoredPlan } from "../fixtures";
import { largeDungeonPlan, largeOutdoorPlan } from "../fixtures/largePlan";

const sides = process.argv.slice(2).map(Number);
const SIDES = sides.length ? sides : [160, 240, 320];
const cat = loadPalettes();

function timed<T>(f: () => T): [T, number] {
  const t = performance.now();
  const r = f();
  return [r, Math.round(performance.now() - t)];
}

function measure(label: string, plan: MapPlan): void {
  const [v, tValidate] = timed(() => validatePlan(plan, planRules(cat)));
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
  const rss = Math.round(process.memoryUsage().rss / 2 ** 20);
  console.log(
    [
      label.padEnd(34),
      `validate ${tValidate}`.padStart(13),
      `resolve ${tResolve}`.padStart(13),
      `compile ${tCompile}`.padStart(14),
      `review ${tReview}`.padStart(12),
      `2d ${tDisplay}`.padStart(12),
      `assets ${bundle.stats.totalAssets}`.padStart(14),
      `chunks ${bundle.chunks.length}`.padStart(10),
      `${Math.round(bytes / 1024)} KB`.padStart(8),
      `maxCoord ${maxCoord}/${SLAB_LIMITS.maxCoord}`.padStart(22),
      `rss ${rss} MB`.padStart(12),
      errors.length ? `plan errors: ${[...new Set(errors.map((e) => e.code))].join(",")}` : "",
      buildErrors.length ? `build errors: ${[...new Set(buildErrors.map((e) => e.code))].join(",")}` : "",
    ].join(" "),
  );
}

console.log(
  "times in ms (validate, resolve, compile = realize+verify+chunk+encode, review, 2d = the display lists; painting them, not timed here, took 10-40 ms at 320 when measured)",
);
for (const name of [
  "keep-dungeon-v8",
  "market-street-v3",
  "smugglers-grotto-v3",
  "heartroot-rift-v7",
] as StoredPlan[])
  measure(`fixture ${name}`, loadPlan(name));
for (const side of SIDES) {
  measure(`outdoor ${side}`, largeOutdoorPlan(side));
  measure(`dungeon ${side} x1`, largeDungeonPlan(side, 1));
  measure(`dungeon ${side} x2`, largeDungeonPlan(side, 2));
  if (process.env.SIZES_LEVELS)
    measure(
      `dungeon ${side} x${process.env.SIZES_LEVELS}`,
      largeDungeonPlan(side, Number(process.env.SIZES_LEVELS)),
    );
}
