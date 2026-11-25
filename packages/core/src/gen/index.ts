/**
 * WP2 generators (architecture §2.4–§2.5, generator version 1): shape rasterizers, blob, cave, value noise,
 * path jitter, route centerlines, scatter and dress (with the frozen preset table), and the feature catalog.
 * Pure TypeScript, arithmetic-only (bit-identical across engines).
 */
export * from "./mask";
export * from "./noise";
export * from "./shapes";
export * from "./catalog";
export * from "./placementGrid";
export * from "./place";
export * from "./setpieces";
export * from "./cliffband";
export * from "./cover";
// what pieces and opening kinds are (read by scene3d's scene checks)
export { frontSide, pieceFacts, type FrontAxis } from "./pieceFacts";
export { OPENING_KIND_INFO, isPassage } from "./openingKinds";
