/**
 * WP2 resolver: resolvePlan (architecture §2.4–§2.7), geometric validation checks (§2.8) for WP1's
 * validatePlan hook, boundary tracing, theme defaults.
 * Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { resolvePlan, resolvedHash, canonicalResolved, type ResolveOptions } from "./resolvePlan";
export { geometryChecks, reachableCells, entryLevelId, type GeometryCheckContext } from "./validate";
export { traceRings, ringArea, type Ring } from "./trace";
export { BUILTIN_THEME_DEFAULTS, builtinThemeDefaults, type ThemeDefaults } from "./themes";
// Registration with WP1 hooks is explicit: call registerWp2Hooks() or import "./autoregister" (core index does).
export { registerWp2Hooks, materializeOp, GEOMETRY_CHECK_NAME } from "./register";
export {
  checkPlayability,
  walkReachability,
  WalkGraph,
  type PlayabilityOptions,
  type PlayabilityCheck,
  type WalkMode,
  type LevelCell,
} from "./playability";
