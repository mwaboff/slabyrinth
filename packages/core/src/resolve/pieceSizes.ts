/**
 * Real piece sizes for generated pieces whose look depends on the palette (the rock band's cliff_face / cliff_crest),
 * for PlacementGrid.pieceSize. Undefined where the theme has no such role: then no band is generated and the built
 * face stays. Default provider: the bundled palettes (loaded once).
 */
import type { FeatureType, ThemeId } from "../contracts/plan";
import { loadPalettes } from "../palette/load";
import { createRoleResolver } from "../palette/resolve";

export type PieceSizeFn = (
  theme: ThemeId,
  type: FeatureType,
  /** True: the asset's real outline in tiles, not its footprint in cells. */
  real?: boolean,
  /** Only the variants of this name (a market stall's bare table: `stall` + "empty"). */
  variant?: string,
) => { w: number; d: number; h: number } | undefined;

/** Feature types whose size comes from a palette role. */
const ROLE_OF: Partial<Record<FeatureType, string>> = {
  cliff_face: "cliff.formation_face",
  cliff_crest: "cliff.formation_crest",
};

/**
 * Generator 3: pieces a small prop may rest on (gen/place.ts topper pass, `Part.on` in gen/setpieces.ts). Their real
 * outline is asked for with `real`; the height is the LOWEST of the role's variants, so a prop never floats over a
 * lower variant (one sunk into a taller variant is hidden inside it).
 */
const SUPPORT_ROLE: Partial<Record<FeatureType, string>> = {
  table: "feature.table",
  round_table: "feature.round_table",
  counter: "feature.counter",
  desk: "feature.desk",
  chest: "feature.chest",
  boulder: "feature.boulder",
  stall: "feature.stall",
};

let bundled: ReturnType<typeof createRoleResolver> | null = null;

/** Piece size from the bundled palettes: footprint in cells (w along x, d along y), height in tiles. */
export const bundledPieceSize: PieceSizeFn = (theme, type, real, variant) => {
  const support = SUPPORT_ROLE[type];
  if (support !== undefined && real === true) {
    bundled ??= createRoleResolver(loadPalettes());
    const vs = (bundled(theme, support).resolution?.variants ?? []).filter(
      (q) => q.weight > 0 && (variant === undefined || q.variant === variant),
    );
    if (vs.length === 0) return undefined;
    return {
      w: Math.min(...vs.map((q) => q.geom.size.x)),
      d: Math.min(...vs.map((q) => q.geom.size.z)),
      h: Math.min(...vs.map((q) => q.geom.size.y)),
    };
  }
  const role = ROLE_OF[type];
  if (role === undefined) return undefined;
  bundled ??= createRoleResolver(loadPalettes());
  const res = bundled(theme, role).resolution;
  const v = res?.variants.find((q) => q.weight > 0) ?? res?.variants[0];
  if (!v) return undefined;
  if (real === true) return { w: v.geom.size.x, d: v.geom.size.z, h: v.geom.size.y };
  return { w: v.footprint[0], d: v.footprint[1], h: v.geom.size.y };
};
