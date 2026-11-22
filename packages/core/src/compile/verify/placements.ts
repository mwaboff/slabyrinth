/**
 * The build's placements: the repairs made before anything is measured, the spatial index every check measures in,
 * and the set's stats after the repairs.
 */
import type { CompileDiagnosticCode, Placement, PlacementSet } from "../../contracts/compiler";
import { featureInfo } from "../../gen/catalog";
import { placedBox, placedName } from "../placed";
import type { VerifyCtx } from "./context";
import { SolidIndex, type Solid } from "./grid";
import { ROTATION_STEP } from "./limits";
import { elementRef } from "./words";

/** The codes this file emits (VERIFY_CODES is the union of every check's list). */
export const PLACEMENT_CODES = [
  "verify_bad_coordinate",
  "verify_duplicate_removed",
] as const satisfies readonly CompileDiagnosticCode[];

/**
 * Drops placements with a bad position or rotation (error, `verify_bad_coordinate`) and, when repairing, exact
 * duplicates (info per asset and level, `verify_duplicate_removed`). Writes the set's placements.
 */
export function dropBadPlacements(ctx: VerifyCtx): void {
  const { set, report } = ctx;
  for (const lv of set.levels) {
    const seen = new Set<string>();
    const kept: Placement[] = [];
    const dups = new Map<string, number>();
    for (const p of lv.placements) {
      const name = placedName(set, p);
      if (
        ![p.x, p.y, p.z, p.rot].every(Number.isFinite) ||
        Math.abs(p.rot / ROTATION_STEP - Math.round(p.rot / ROTATION_STEP)) > 1e-6
      ) {
        report.add({
          severity: "error",
          code: "verify_bad_coordinate",
          levelId: lv.levelId,
          message: `"${name}" has an invalid position or rotation (${p.x}, ${p.y}, ${p.z}, ${p.rot}°) and was left out of the build.`,
          hint: "This is a compiler bug or a broken palette offset; report it with the plan.",
          assets: [name],
          ...elementRef(p.source.elementId),
          repaired: "placement dropped",
        });
        continue;
      }
      const k = `${p.asset}|${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.z.toFixed(2)}|${p.rot}`;
      if (seen.has(k) && ctx.repair) {
        dups.set(name, (dups.get(name) ?? 0) + 1);
        report.repairs++;
        continue;
      }
      seen.add(k);
      kept.push(p);
    }
    for (const [name, n] of dups) {
      report.add({
        severity: "info",
        code: "verify_duplicate_removed",
        levelId: lv.levelId,
        message: `Removed ${n} exact duplicate${n > 1 ? "s" : ""} of "${name}" (same position and rotation) on level ${lv.levelId}.`,
        assets: [name],
        count: n,
        repaired: `dropped ${n} duplicate placement${n > 1 ? "s" : ""}`,
      });
    }
    // (in place, without spreading: a large level has more placements than a call takes arguments)
    lv.placements.length = 0;
    for (const p of kept) lv.placements.push(p);
  }
}

/** Every placement of the set as a solid (its box and what verify needs to know about it), indexed by plan cell. */
export function indexSolids(ctx: VerifyCtx): SolidIndex {
  const { set, resolved } = ctx;
  // the plan's y axis runs south, the world's z north: with flipZ, world z = planHeight - plan y
  const planHeight = resolved.levels.reduce((m, l) => Math.max(m, l.bounds.y + l.bounds.h), 0);
  const index = new SolidIndex(planHeight, ctx.opts.flipZ ?? true);
  for (const lv of set.levels) {
    for (const p of lv.placements) {
      const f = p.role === "feature" ? ctx.featureOf(lv.levelId, p.source.elementId) : undefined;
      // generator 5: a piece of an arrangement instance blocks as its instance says
      const inst = p.role === "feature" && !f ? ctx.arrangementOf(lv.levelId, p.source.elementId) : undefined;
      const meta = set.placed?.get(p);
      const s: Solid = {
        p,
        box: placedBox(set, p),
        levelId: lv.levelId,
        role: p.role,
        name: placedName(set, p),
        blocking: p.role !== "feature" || (f?.blocking ?? inst?.blocking ?? true),
        // organic dressing (the feature table's trait): its overlaps are expected and reported as info only
        organic: f !== undefined && featureInfo(f.type).organic,
        wallMounted: f?.wall !== undefined,
        isTileFeature: p.role === "feature" && meta?.geom.originAt === "minCorner",
        arranged: inst !== undefined,
      };
      index.add(s);
    }
  }
  return index;
}

/** The set's stats (placements by role, total, distinct assets) after the repairs. */
export function recountStats(set: PlacementSet): void {
  const byRole = { ...set.stats.byRole };
  for (const k of Object.keys(byRole) as Array<keyof typeof byRole>) byRole[k] = 0;
  let total = 0;
  const assets = new Set<string>();
  for (const lv of set.levels)
    for (const p of lv.placements) {
      byRole[p.role]++;
      total++;
      assets.add(p.asset);
    }
  set.stats = { byRole, total, distinctAssets: assets.size };
}
