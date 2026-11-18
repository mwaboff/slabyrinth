import { defineConfig } from "@playwright/test";

/** Electron end-to-end tests against the test build (out-test/; `npm run test:e2e` builds it first). */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
});
