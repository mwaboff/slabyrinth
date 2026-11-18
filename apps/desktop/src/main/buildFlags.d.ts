/**
 * Build-time constant (electron.vite.config.ts `define`): true only in test builds
 * (`electron-vite build --mode test` → out-test/) and in Vitest. Production bundles (out/, packaged)
 * have it false, so code behind it is removed at build time.
 */
declare const __SLABYRINTH_TEST_BUILD__: boolean;
