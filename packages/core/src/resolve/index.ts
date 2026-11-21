/**
 * WP2 resolver: resolvePlan (architecture §2.4–§2.7), geometric validation checks (§2.8) that callers pass to
 * WP1's validatePlan and applyOps (`planRules`), boundary tracing, theme defaults.
 * Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { resolvePlan, resolvedHash, canonicalResolved, type ResolveOptions } from "./resolvePlan";
export { geometryChecks, reachableCells, type GeometryCheckContext } from "./validate";
export { traceRings, ringArea, type Ring } from "./trace";
export { BUILTIN_THEME_DEFAULTS, builtinThemeDefaults, type ThemeDefaults } from "./themes";
// The rules plan validation and applyOps take as an argument (geometry check, materialize generator).
export { planRules, geometryCheck, materializeOp, GEOMETRY_CHECK_NAME } from "./rules";
export {
  checkPlayability,
  walkReachability,
  WalkGraph,
  type PlayabilityOptions,
  type PlayabilityCheck,
  type WalkMode,
  type LevelCell,
} from "./playability";
export { cliffEdges, cliffRuns, type CliffEdge } from "./cliffs";
export {
  roofUnsupportedEdges,
  structureRuinMeasures,
  weatherMeasures,
  weatherSigns,
  WEATHER_MINIMUMS,
  type RuinMeasures,
  type WeatherMeasures,
} from "./ruin";
export { GROWTH_LEVELS, growthMeasures, type GrowthLevel, type GrowthMeasures } from "./growth";
export { mergeRoofs, roofOwners, roofProportion, type RoofProportion } from "./roof";
export {
  designSignature,
  structureSignature,
  structureSilhouette,
  structureTone,
  type BuildingDesign,
  type DesignSpace,
} from "./structureVariety";
