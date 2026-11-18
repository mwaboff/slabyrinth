/**
 * WP1 plan model: Zod schemas mirroring contracts/plan.ts, validatePlan (+ registration hook for WP2 geometric
 * checks), element addressing, link arithmetic, shape facts, migrations. Pure TypeScript.
 */
export * from "./schema";
export * from "./schemaTypes";
export * from "./elements";
export * from "./links";
export * from "./shapes";
export * from "./zodIssues";
export * from "./validate";
export * from "./migrate";
