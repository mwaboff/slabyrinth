/**
 * The plan rules tests pass to validatePlan, applyOps and the history functions: `BUNDLED_RULES` adds the resolver's
 * geometry and playability checks and the materialize generator for the bundled palettes (what the CLI and the core
 * entry used to register for the whole process); `STRUCTURAL_RULES` checks structure only.
 */
import { bundledPalettes } from "../../src/palette/load";
import { planRules } from "../../src/resolve/rules";

export { STRUCTURAL_RULES } from "../../src/ops/apply";
export { STRUCTURE_ONLY } from "../../src/plan/validate";

export const BUNDLED_RULES = planRules(bundledPalettes());
