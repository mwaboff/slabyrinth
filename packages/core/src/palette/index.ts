/**
 * Palettes (WP3): load + merge (bundled defaults and user overrides), role resolution with the curated fallback
 * chain, and the orientation calibration data. Pure TypeScript: no electron, DOM or node:* imports here.
 */
export {
  applyOverride,
  buildPaletteCatalog,
  bundledPalettes,
  loadOrientation,
  loadPalettes,
  mergePalettes,
} from "./load";
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
/** The alignment pillar's role (the app asks whether a split build's slabs carry it: shared/pasteRegister.ts). */
export { MARKER_ROLE, roleFamily } from "./roles";
export type { PaletteView, PieceSizeFn, RoomPieceFn, StallFormsFn } from "./view";
export { TRAITS, TRAIT_IDS, borrowRisk, fitsShape, hasTrait, measurePiece, traitsOf } from "./traits";
export type { BorrowRisk, MeasureId, MeasureRange, PieceMeasures, TraitId, TraitShape } from "./traits";
export { pickFromPool, traitPool, traitQueryKey } from "./traitPools";
export type { TraitPiece, TraitPool, TraitQuery } from "./traitPools";
export { REST_ROLE_PREFIXES, measuredRest, restHeight, restPieces, restTop } from "./restSurface";
export type { RestPiece } from "./restSurface";
export { parseRestGrid, restGridOf, restSpot } from "./restGrid";
export type { RestGrid, RestSpot } from "./restGrid";
export { COVER_ROLE_PREFIXES, FLOOR_HOLE, coverPieces, floorHoleOf, leavesFloorHole } from "./topCover";
export { coveredStallForms, stallParts } from "./stallParts";
export type { RoleProbe, StallParts } from "./stallParts";
