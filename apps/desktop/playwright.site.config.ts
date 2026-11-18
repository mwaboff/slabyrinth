import { defineConfig } from "@playwright/test";

/**
 * Landing-page screenshots (e2e/site.capture.ts), kept out of `npm run test:e2e`.
 * Run `npm run capture:site` from the repo root; it builds the test bundle (out-test/) first.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.capture.ts",
  timeout: 240_000,
  workers: 1,
  reporter: "list",
});
