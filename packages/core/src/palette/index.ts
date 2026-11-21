/**
 * Palettes (WP3): load + merge (bundled defaults and user overrides), role resolution with the curated fallback
 * chain, and the orientation calibration data. Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { applyOverride, bundledPalettes, loadOrientation, loadPalettes, mergePalettes } from "./load";
export type { PaletteLoadIssue } from "./load";
export { GENERIC_THEME, createRoleResolver, footprintFromGeom, resolveRole, themeChain } from "./resolve";
export type {
  ResolveOutcome,
  ResolvePalettes,
  ResolvedVariant,
  RoleResolution,
  Substitution,
  VariantFilter,
} from "./resolve";
export { resolvePalettesData, resolvePalettesFromData } from "./transfer";
export type { ResolvePalettesData } from "./transfer";
export {
  facingSchema,
  geomSchema,
  orientationSchema,
  paletteOverrideSchema,
  paletteSchema,
  parseOrientation,
  parsePalette,
  parsePaletteOverride,
  roleSchema,
  variantSchema,
} from "./schema";
export type { ParseResult } from "./schema";
export { BUNDLED_ORIENTATION, BUNDLED_PALETTES } from "./bundled";
export { featureRoleFits, withAutoVariants } from "./auto";
export { createPaletteView, paletteView } from "./view";
export type { PaletteView, PieceSizeFn, RoomPieceFn, StallFormsFn } from "./view";
export { coveredStallForms, stallParts } from "./stallParts";
export type { RoleProbe, StallParts } from "./stallParts";
