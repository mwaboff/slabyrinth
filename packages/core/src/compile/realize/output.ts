/**
 * Realize, output: the realized set's shape, and the last steps of a level and of the build.
 * Reads: a level's placements and box (finishLevel); the collected levels, diagnostics and substitutions
 * (finishRealize). Writes: the output accumulator; finishRealize adds the substitution diagnostics and returns the set.
 */
import type { Box3, PlacementRole, PlacementSet } from "../../contracts/compiler";
import type { LevelId } from "../../contracts/plan";
import { CELL, CELL_FLAG, type ResolvedLevel } from "../../contracts/resolved";
import type { ResolvedVariant } from "../../palette/resolve";
import { finiteBox, growBox } from "../geometry";
import type { BundleSubstitution, RealizeCtx } from "./context";
import type { LevelWork } from "./work";

export const ROLE_ORDER: readonly PlacementRole[] = [
  "floor",
  "fill",
  "wall",
  "wall_post",
  "opening",
  "link",
  "feature",
  "ledge",
  "marker",
];

/** PlacementSet plus what the chunk/bundle stage needs (structurally a PlacementSet). */
export interface RealizedSet extends PlacementSet {
  substitutions: BundleSubstitution[];
  assetSource: "install" | "builtin";
  /** Alignment marker asset (marker.alignment), null when the palettes have none. */
  marker: { uuid: string; geom: ResolvedVariant["geom"] } | null;
  levelInfo: Array<{
    levelId: LevelId;
    elevation: number;
    bounds: Box3;
    cellBounds: { x: number; y: number; w: number; h: number };
    /** Intended water surface (absolute tiles), when the level has water (ResolvedLevel.waterLevel). */
    waterLevel?: number;
    /** Range the surface may be set in: a quarter above the highest bed to a quarter below the lowest bank (absolute tiles). */
    waterRange?: [number, number];
  }>;
  resolvedHash: string;
}

/** What the levels hand on to the finished set, in level order. */
export interface RealizeOutput {
  readonly levels: PlacementSet["levels"];
  readonly levelInfo: RealizedSet["levelInfo"];
  /** World box of every level. */
  readonly allBox: Box3;
}

/** Water surface range of a level: a quarter tile above its highest water bed to a quarter below its lowest dry bank. */
function waterRangeOf(L: ResolvedLevel): [number, number] {
  const { w, h } = L.bounds;
  const top = (i: number): number => L.elevation + (L.cells.height[i] ?? 0) / 4 + 0.5;
  const floor = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0;
  const wet = (i: number): boolean => ((L.cells.flags[i] ?? 0) & CELL_FLAG.WATER) !== 0;
  let bed = -Infinity;
  let bank = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (!floor(i) || !wet(i)) continue;
    bed = Math.max(bed, top(i));
    const x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
      if (j >= 0 && j < w * h && floor(j) && !wet(j)) bank = Math.min(bank, top(j));
  }
  const lo = bed + 0.25;
  return [lo, Number.isFinite(bank) ? Math.max(lo, bank - 0.25) : lo];
}

/** Drops omitted layers, sorts the level's placements into their deterministic order and records the level. */
export function finishLevel(w: LevelWork, out: RealizeOutput): void {
  const { L, placements, levelBox, elev } = w;
  const { opts } = w.ctx;
  const { levels: outLevels, levelInfo, allBox } = out;
  if (opts.omitLayers?.length) {
    const drop = new Set(opts.omitLayers);
    for (let i = placements.length - 1; i >= 0; i--) {
      const ly = placements[i]?.layer;
      if (ly !== undefined && drop.has(ly)) placements.splice(i, 1);
    }
  }

  // deterministic order: role, then source cell (y, x), then emission order
  const order = new Map(ROLE_ORDER.map((r, i) => [r, i]));
  const indexed = placements.map((p, i) => ({ p, i }));
  indexed.sort(
    (a, b) =>
      (order.get(a.p.role) ?? 99) - (order.get(b.p.role) ?? 99) ||
      (a.p.source.cell?.[1] ?? 0) - (b.p.source.cell?.[1] ?? 0) ||
      (a.p.source.cell?.[0] ?? 0) - (b.p.source.cell?.[0] ?? 0) ||
      a.i - b.i,
  );
  outLevels.push({ levelId: L.id, placements: indexed.map((x) => x.p) });
  growBox(allBox, levelBox);
  levelInfo.push({
    levelId: L.id,
    elevation: elev,
    bounds: finiteBox(levelBox),
    cellBounds: { ...L.bounds },
    ...(L.waterLevel !== undefined
      ? { waterLevel: L.waterLevel, waterRange: L.waterRange ?? waterRangeOf(L) }
      : {}),
  });
}

/** The alignment marker, the statistics and the substitution diagnostics: the finished set. */
export function finishRealize(ctx: RealizeCtx, out: RealizeOutput): RealizedSet {
  const { resolved, palettes, defaultTheme, lookup, addDiag, diag, subs } = ctx;
  const { levels: outLevels, levelInfo, allBox } = out;
  // alignment marker asset
  const mres = lookup(resolved.levels[0]?.id ?? "", defaultTheme, ["marker.alignment"], undefined, true);
  const mv = mres?.variants[0];

  const byRole = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0])) as Record<PlacementRole, number>;
  const assets = new Set<string>();
  let total = 0;
  for (const l of outLevels) {
    for (const p of l.placements) {
      byRole[p.role]++;
      assets.add(p.asset);
      total++;
    }
  }
  for (const s of subs.values()) {
    addDiag(
      {
        severity: s.used ? "info" : "warning",
        code: s.used ? "asset_substituted" : "asset_unknown",
        message: s.used
          ? `"${s.wanted.name ?? s.wanted.uuid}" is not available in your TaleSpire; "${s.used.name ?? s.used.uuid}" used instead`
          : `"${s.wanted.name ?? s.wanted.uuid}" is not available in your TaleSpire and has no substitute`,
        role: s.role,
      },
      s.count,
    );
  }
  const diagnostics = [...diag.values()];
  return {
    planId: resolved.planId,
    planVersion: resolved.planVersion,
    levels: outLevels,
    bounds: finiteBox(allBox),
    diagnostics,
    stats: { byRole, total, distinctAssets: assets.size },
    substitutions: [...subs.values()],
    assetSource:
      palettes.availability.status("00000000-0000-0000-0000-000000000000") === null ? "builtin" : "install",
    marker: mv ? { uuid: mv.uuid, geom: mv.geom } : null,
    levelInfo,
    resolvedHash: resolved.hash,
  };
}
