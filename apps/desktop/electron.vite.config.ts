import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { CSP_DEV, CSP_PROD } from "./src/main/csp";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Replaces the %SLABYRINTH_CSP% placeholder in index.html with the policy for this mode. */
function cspPlugin(isDev: boolean): Plugin {
  return {
    name: "slabyrinth-csp",
    transformIndexHtml(html) {
      return html.replace("%SLABYRINTH_CSP%", isDev ? CSP_DEV : CSP_PROD);
    },
  };
}

/**
 * Workspace packages and all third-party code are bundled (externalizeDeps: false), so the
 * packaged app ships only out/** and needs no node_modules. Every dependency of this app is
 * therefore a devDependency, and electron-builder packages nothing from node_modules.
 */
/**
 * Test builds (`electron-vite build --mode test`, used by Playwright) go to out-test/ and are the only
 * builds where __SLABYRINTH_TEST_BUILD__ is true, so test-only main code (the scripted e2e provider)
 * is dead code, and never emitted, in out/ — the folder electron-builder packages.
 */
export default defineConfig(({ command, mode }) => {
  const isDev = command === "serve";
  const testBuild = mode === "test";
  const outRoot = testBuild ? "out-test" : "out";
  return {
    main: {
      define: { __SLABYRINTH_TEST_BUILD__: JSON.stringify(testBuild) },
      resolve: {
        // fflate's Node ESM build declares a top-level `require`, which collides with the CommonJS
        // shim electron-vite injects into ESM main chunks ("Identifier 'require' has already been
        // declared"). Its platform-neutral build has the same sync gzip API and no `require`.
        alias: { fflate: here("../../node_modules/fflate/esm/browser.js") },
      },
      build: {
        outDir: here(`./${outRoot}/main`),
        externalizeDeps: false,
        rolldownOptions: {
          // compile.worker runs core's compiler in a worker_thread (out/main/compile.worker.js).
          input: {
            index: here("./src/main/index.ts"),
            "compile.worker": here("./src/main/workers/compile.worker.ts"),
          },
        },
      },
    },
    preload: {
      build: {
        outDir: here(`./${outRoot}/preload`),
        // Sandboxed preloads cannot be ES modules or require npm packages: bundle to one CJS file.
        externalizeDeps: false,
        rolldownOptions: {
          input: { index: here("./src/preload/index.ts") },
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: here("./src/renderer"),
      plugins: [react(), cspPlugin(isDev)],
      build: {
        outDir: here(`./${outRoot}/renderer`),
        rolldownOptions: {
          input: { index: here("./src/renderer/index.html") },
        },
      },
      worker: { format: "es" },
    },
  };
});
