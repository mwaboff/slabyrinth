import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * One Vitest run for the whole monorepo (`npm test`). Vitest 4+ replaced vitest.workspace.ts
 * with `test.projects`. Run one project with `npx vitest run --project <name>` or
 * `npm test -w <workspace>`.
 */
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          environment: "node",
          include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "render-canvas",
          root: "./packages/render-canvas",
          environment: "node",
          include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        },
      },
      {
        // Main-process build flag (electron.vite.config.ts): tests may load test-only code.
        define: { __SLABYRINTH_TEST_BUILD__: "true" },
        test: {
          name: "desktop-main",
          root: "./apps/desktop",
          environment: "node",
          include: [
            "src/main/**/*.test.ts",
            "src/preload/**/*.test.ts",
            "src/shared/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "desktop-renderer",
          root: "./apps/desktop",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/renderer/test/setup.ts"],
          css: true,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/desktop/src/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
