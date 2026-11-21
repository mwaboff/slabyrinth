// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { builtinModules } from "node:module";

/**
 * Import boundaries (architecture §7.2): @slabyrinth/core is pure TypeScript. electron, react
 * and Node built-ins (node:* or bare "fs", "path", …) are forbidden in packages/core/src/**,
 * except src/cli/**.
 */
const coreBoundary = {
  paths: [
    { name: "electron", message: "@slabyrinth/core must not depend on Electron (architecture §7.2)." },
    { name: "react", message: "@slabyrinth/core must not depend on React (architecture §7.2)." },
    { name: "react-dom", message: "@slabyrinth/core must not depend on React (architecture §7.2)." },
    ...builtinModules.map((name) => ({
      name,
      message: "Node built-ins are only allowed in packages/core/src/cli (architecture §7.2).",
    })),
  ],
  patterns: [
    {
      group: ["node:*"],
      message: "Node built-ins are only allowed in packages/core/src/cli (architecture §7.2).",
    },
    { group: ["electron/*", "react/*", "react-dom/*"], message: "Not allowed in @slabyrinth/core." },
  ],
};

/**
 * Layer direction inside @slabyrinth/core: plan and palette data, then gen, resolve, compile, review. The design
 * review reads what the build produced (it may import compile), so nothing below it may import review, and nothing
 * below compile may import compile; a cycle between them starts with such an import.
 */
/** @param {string} layer */
const layerImport = (layer) => ({
  regex: `(^|/)${layer}(/|$)`,
  message: `This layer must not import ${layer}/ (core layer direction: plan, palette, gen, resolve, compile, review).`,
});
/** @type {import("eslint").Linter.Config[]} */
const coreLayers = [
  { files: ["plan", "palette", "gen", "resolve"], forbidden: ["compile", "review"] },
  { files: ["compile"], forbidden: ["review"] },
].map(({ files, forbidden }) => ({
  files: files.map((dir) => `packages/core/src/${dir}/**/*.ts`),
  rules: {
    "no-restricted-imports": [
      "error",
      { paths: coreBoundary.paths, patterns: [...coreBoundary.patterns, ...forbidden.map(layerImport)] },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/out-test/**",
      "**/release/**",
      "**/coverage/**",
      "**/.tsbuild/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "docs/**",
      "data/**",
      "tools/**",
      // Static landing page: plain browser JS, not part of any TypeScript project.
      "site/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
  {
    // Contract copies are verbatim from docs/contracts (normative; tsc-checked). These rules flag
    // deliberate documentation-style unions (`"auto" | string`, `void` request payloads). Do not
    // edit the copies to satisfy lint: contract changes go through the lead.
    files: [
      "packages/core/src/contracts/**",
      "packages/core/src/agent/tools.ts",
      "apps/desktop/src/shared/ipc.ts",
      "apps/desktop/src/shared/project.ts",
      "apps/desktop/src/main/agent/provider/types.ts",
    ],
    rules: {
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/cli/**"],
    rules: { "no-restricted-imports": ["error", coreBoundary] },
  },
  ...coreLayers,
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "packages/render-canvas/src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat["recommended-latest"],
  },
  prettier,
);
