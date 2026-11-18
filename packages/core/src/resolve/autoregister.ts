/**
 * Side-effect module: registers WP2's geometric plan check and the `materialize` generator with WP1's hooks.
 * packages/core/src/index.ts imports it so every consumer of @slabyrinth/core gets full validation.
 */
import { registerWp2Hooks } from "./register";

registerWp2Hooks();
