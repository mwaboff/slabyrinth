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
) => { w: number; d: number; h: number } | undefined;

/** Feature types whose size comes from a palette role. */
const ROLE_OF: Partial<Record<FeatureType, string>> = {
  cliff_face: "cliff.formation_face",
  cliff_crest: "cliff.formation_crest",
};

let bundled: ReturnType<typeof createRoleResolver> | null = null;

/** Piece size from the bundled palettes: footprint in cells (w along x, d along y), height in tiles. */
export const bundledPieceSize: PieceSizeFn = (theme, type) => {
  const role = ROLE_OF[type];
  if (role === undefined) return undefined;
  bundled ??= createRoleResolver(loadPalettes());
  const res = bundled(theme, role).resolution;
  const v = res?.variants.find((q) => q.weight > 0) ?? res?.variants[0];
  if (!v) return undefined;
  return { w: v.footprint[0], d: v.footprint[1], h: v.geom.size.y };
};
