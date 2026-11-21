/**
 * Side-effect module: registers WP2's geometric plan check and the `materialize` generator with WP1's hooks, on the
 * bundled palettes. packages/core/src/index.ts imports it so every consumer of @slabyrinth/core gets full
 * validation; a process that builds with other palettes (the app: user palettes, the game's assets) registers those
 * itself with `registerWp2Hooks`, which replaces this registration.
 */
import { bundledPalettes } from "../palette/load";
import { registerWp2Hooks } from "./register";

registerWp2Hooks(bundledPalettes);
