// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

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
 * The layer order of packages/core/src, lowest row first. A module may import its own directory and any directory in
 * an earlier row; directories in one row are independent and may not import each other. Every directory is listed:
 * a new one fails lint until it is placed here. The root `index.ts` (the public entry) sits above every row, so no
 * layer imports it. The `core-layers` rule below checks every relative import against this table.
 */
const CORE_LAYERS = [
  ["contracts"], // the normative types (verbatim copies of docs/contracts) and build constants
  ["util", "slab"], // hashing, PRNG, canonical JSON, own-property lookups; the TaleSpire slab codec
  ["catalog", "plan"], // the game's asset catalog (reads slab layouts); the plan model, schema and validation
  ["gen"], // generation tables and algorithms: feature catalog, wall styles, room purpose, caves, rooms, noise
  ["palette", "ops"], // asset palettes per theme and role (read gen's feature and wall-style tables); plan edits
  ["history", "resolve"], // plan versions (replay ops); the resolver: plan + palettes -> resolved grid
  ["render", "text", "compile"], // what reads a resolved plan: 2D display lists, text views, the slab compiler
  ["review"], // the design review (reads what the build produced)
  ["agent"], // the model's tools, prompts and checks
  ["cli"], // the command line
];
const CORE_SRC = path.join(import.meta.dirname, "packages", "core", "src");
const CORE_ENTRY = "index.ts";
/** @type {Map<string, number>} */
const coreRank = new Map(
  CORE_LAYERS.flatMap((row, i) => row.map((dir) => /** @type {[string, number]} */ ([dir, i]))),
);
coreRank.set(CORE_ENTRY, CORE_LAYERS.length);

/** The core layer of an absolute path (a directory under src, or the entry), or null outside packages/core/src. */
function coreLayerOf(/** @type {string} */ file) {
  const rel = path.relative(CORE_SRC, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length > 1 || coreRank.has(parts[0] ?? "")) return parts[0] ?? "";
  return parts[0] === "" || /^index(\.ts)?$/.test(parts[0] ?? "") ? CORE_ENTRY : (parts[0] ?? "");
}

/** @type {import("eslint").Rule.RuleModule} */
const coreLayersRule = {
  meta: {
    type: "problem",
    schema: [],
    docs: { description: "Core imports follow CORE_LAYERS (eslint.config.js)." },
  },
  create(context) {
    const from = coreLayerOf(context.filename);
    if (from === null) return {};
    const fromRank = coreRank.get(from);
    /** @param {any} node */
    const check = (node) => {
      const spec = node.source?.value;
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const to = coreLayerOf(path.resolve(path.dirname(context.filename), spec));
      if (to === null || to === from) return;
      const toRank = coreRank.get(to);
      if (fromRank === undefined || toRank === undefined) {
        const missing = fromRank === undefined ? from : to;
        context.report({
          node,
          message: `packages/core/src/${missing} is not in CORE_LAYERS (eslint.config.js): place it in the layer order.`,
        });
      } else if (toRank >= fromRank) {
        const target = to === CORE_ENTRY ? "the core entry (index.ts)" : `${to}/`;
        const why =
          to === CORE_ENTRY
            ? "it sits above every row"
            : toRank === fromRank
              ? "they are in the same row"
              : "it is in a later row";
        context.report({
          node,
          message: `Core layers: ${from}/ may not import ${target}; ${why} of CORE_LAYERS (eslint.config.js).`,
        });
      }
    };
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
    };
  },
};

/**
 * Edge kinds and cell flags come from the resolved contract (EDGE, CELL_FLAG; gen/gridGeometry.ts re-exports them by
 * name). A local `const EDGE_WALL = 1` silently drifts when the contract changes.
 */
const numberedEdgeKinds = {
  selector: "VariableDeclarator[id.name=/^(EDGE|FLAG)_[A-Z_]+$/][init.type='Literal']",
  message:
    "Import edge kinds and cell flags (gen/gridGeometry.ts or EDGE/CELL_FLAG in contracts/resolved) instead of redeclaring them by number.",
};
/**
 * A level's edges are indexed in one place, resolve/levelGrid.ts. The vertical-edge stride `(w + 1)` is the mark of an
 * edge index written by hand (a horizontal edge index looks like a cell index, so the stride is what can be seen).
 */
const handEdgeIndex = {
  selector:
    "BinaryExpression[operator=/^[*%/]$/] > BinaryExpression[operator='+'][right.value=1]:matches([left.name=/^[wW]$/], [left.property.name='w'])",
  message:
    "Index a level's edges with resolve/levelGrid.ts (hEdgeIndex, vEdgeIndex, sideEdgeIndex, edgeOnLine, edgeCol/edgeRow, LevelGrid) instead of by hand.",
};

/**
 * No core module is imported for its side effects. A module that changes what other functions do when it is
 * imported (registering checks or generators process-wide) makes their results depend on who imported what; pass
 * what a function needs as an argument instead (validatePlan's `checks`, applyOps' `PlanRules`).
 */
const sideEffectImport = {
  selector: "ImportDeclaration[specifiers.length=0][importKind!='type']",
  message:
    "Do not import a core module for its side effects: pass what a function needs as an argument (e.g. resolve's planRules).",
};

/**
 * A rule that reports AST selectors, for a guard that holds in part of core only (its own files block, so it never
 * replaces the `no-restricted-syntax` list above). Each guard names the owner the code should ask instead.
 * test/unit/lint/coreGuards.test.ts lints a snippet with each guard through this config, so a guard cannot rot.
 * @param {string} description
 * @param {Array<{ selector: string; message: string }>} selectors
 * @returns {import("eslint").Rule.RuleModule}
 */
function selectorRule(description, selectors) {
  return {
    meta: { type: "problem", schema: [], docs: { description } },
    create(context) {
      return Object.fromEntries(
        selectors.map(({ selector, message }) => [
          selector,
          (/** @type {import("estree").Node} */ node) => context.report({ node, message }),
        ]),
      );
    },
  };
}

/**
 * The theme of a cell has one reader while a level resolves, ResolveGrid.themeAt (and pieceTheme for what a piece is
 * sized in). A stage that reads the level's theme or indexes the theme table works the cell's theme out again, and
 * asks the wrong owner the day the cell's area has a theme of its own.
 */
const cellThemeRule = selectorRule("Resolve stages ask a cell's theme of ResolveGrid.themeAt.", [
  {
    selector: "MemberExpression[property.name='levelTheme']",
    message:
      "Ask the theme of the cell (ResolveGrid.themeAt, or pieceTheme for a piece's size), not the level's theme.",
  },
  {
    selector: "MemberExpression[computed=true][object.property.name='themes']",
    message: "Ask the theme of a cell with ResolveGrid.themeAt instead of indexing the theme table.",
  },
]);

/**
 * A draw in [0, 1) from a hash is util/hash.ts hashUnit (or TWO_32 beside a hash of its own), never 2^32 by hand; and
 * the string hashes are defined once, in util/hash.ts (h32 over UTF-8 bytes, the frozen h32Utf16 the compiler's
 * released draws use), so which one a file gets is its call's name, not its import line.
 */
const hashUnitRule = selectorRule("Draws from a hash go through util/hash.ts.", [
  {
    selector: "Literal[value=4294967296]",
    message: "Draw from a hash with util/hash.ts hashUnit(seed, ...parts) (or divide by its TWO_32).",
  },
  {
    selector:
      ":matches(FunctionDeclaration, VariableDeclarator)[id.name=/^(h32|h32Utf16|hashUnit|hashUnitUtf16|unitHash)$/]",
    message: "The string hashes live in util/hash.ts (h32, h32Utf16, hashUnit, hashUnitUtf16): import them.",
  },
]);

/** The words of a closed vocabulary of the plan contract (`export const NAME = [...] as const;` in contracts/plan.ts). */
function contractWords(/** @type {string} */ name) {
  const src = readFileSync(path.join(CORE_SRC, "contracts", "plan.ts"), "utf8");
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(src);
  if (!m) throw new Error(`eslint.config.js: ${name} is not a list in contracts/plan.ts`);
  return [...(m[1] ?? "").replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((w) => w[1] ?? "");
}

/**
 * A closed vocabulary (opening kinds, link kinds, roof types, wall styles) is answered by its table's traits
 * (gen/openingKinds.ts, plan/links.ts, resolve/roofTypes.ts, gen/wallStyles.ts), never by comparing the field with one
 * of its words: a new word then needs a row, not a hunt through the stages. The field a word is compared on is named,
 * so the same word in another vocabulary (a ruined condition, a stairs op) is not caught. A frozen generator's rule
 * that named kinds lives once, in the table module (gen/openingKinds.ts openingTests).
 * @param {string} field
 * @param {string[]} words
 * @param {string} table
 */
const vocabularyCompare = (field, words, table) => {
  const re = `/^(${words.join("|")})$/`;
  const message = `Ask ${table} for the trait you mean instead of comparing \`${field}\` with one of its words.`;
  return [
    {
      selector: `BinaryExpression[operator=/^[!=]==$/][left.property.name='${field}'][right.value=${re}]`,
      message,
    },
    {
      selector: `BinaryExpression[operator=/^[!=]==$/][right.property.name='${field}'][left.value=${re}]`,
      message,
    },
  ];
};
const vocabularyRule = selectorRule("Closed vocabularies are asked of their trait tables.", [
  ...vocabularyCompare(
    "kind",
    [...contractWords("OPENING_KINDS"), ...contractWords("LINK_KINDS")],
    "gen/openingKinds.ts (OPENING_KIND_INFO, openingTests) or plan/links.ts (LINK_KIND_INFO)",
  ),
  ...vocabularyCompare("type", contractWords("ROOF_TYPES"), "resolve/roofTypes.ts (ROOF_TYPE_INFO)"),
  ...vocabularyCompare("wallStyle", contractWords("WALL_STYLES"), "gen/wallStyles.ts (WALL_STYLE_INFO)"),
]);

/**
 * A trait of a feature type is a field of gen/catalog.ts FEATURE_INFO, read where it is needed (`typesWith`), never a
 * hand list of types beside the code that reads it. A list a frozen generator read is the trait plus a named delta
 * (catalog.ts traitWithDelta).
 */
const featureListRule = selectorRule("Feature traits are fields of gen/catalog.ts.", [
  {
    selector:
      "NewExpression[callee.name='Set'][typeArguments.params.0.typeName.name='FeatureType'] > ArrayExpression",
    message:
      "Give the types a trait in gen/catalog.ts FEATURE_INFO and read it (typesWith, featureInfo) instead of listing them here.",
  },
]);

/** The four sides, their order and their opposites are gen/gridGeometry.ts SIDES and OPPOSITE. */
const sidesRule = selectorRule("Sides come from gen/gridGeometry.ts.", [
  {
    selector:
      "ArrayExpression[elements.length=4][elements.0.value='N'][elements.1.value='E'][elements.2.value='S'][elements.3.value='W']",
    message: "Use gen/gridGeometry.ts SIDES instead of writing the four sides out.",
  },
  ...[
    ["N", "S"],
    ["S", "N"],
    ["E", "W"],
    ["W", "E"],
  ].map(([side, opposite]) => ({
    selector: `ConditionalExpression[test.operator='==='][test.right.value='${side}'][consequent.value='${opposite}']`,
    message: "Use gen/gridGeometry.ts OPPOSITE instead of a ternary that turns a side round.",
  })),
]);

/**
 * A resolved element's theme ("" = inherit) has one reader, resolve/levelGrid.ts elementTheme / LevelGrid.themeAt: a
 * `x.theme || other` at the reader works it out again, and the day one reader picks another `other`, two stages build
 * the same element in two themes.
 */
const elementThemeRule = selectorRule("A resolved element's theme is read with elementTheme.", [
  {
    selector: "LogicalExpression[operator='||'][left.type='MemberExpression'][left.property.name='theme']",
    message:
      "Ask resolve/levelGrid.ts elementTheme(own, inherited) or LevelGrid.themeAt(own, x, y) instead of `x.theme || ...`.",
  },
]);

const slabyrinthPlugin = {
  rules: {
    "element-theme": elementThemeRule,
    "core-layers": coreLayersRule,
    "cell-theme": cellThemeRule,
    "hash-unit": hashUnitRule,
    vocabulary: vocabularyRule,
    "feature-lists": featureListRule,
    sides: sidesRule,
  },
};

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
      "packages/core/src/agent/toolContract.ts",
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
  {
    files: ["packages/core/src/**/*.ts"],
    plugins: { slabyrinth: slabyrinthPlugin },
    rules: { "slabyrinth/core-layers": "error" },
  },
  {
    // the grid owns the cell's theme; the area table builds the theme table
    files: ["packages/core/src/resolve/level/**/*.ts"],
    ignores: ["packages/core/src/resolve/level/grid.ts", "packages/core/src/resolve/level/areas.ts"],
    rules: { "slabyrinth/cell-theme": "error" },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    // util owns the hashes; the slab codec's SHA-256 splits a 64-bit length, it draws nothing
    ignores: ["packages/core/src/util/**", "packages/core/src/slab/**"],
    rules: { "slabyrinth/hash-unit": "error" },
  },
  {
    // the generation side; the tables themselves and the roof geometry (each type's shape is its own case) are exempt
    files: ["packages/core/src/{gen,resolve,plan}/**/*.ts"],
    ignores: [
      "packages/core/src/gen/openingKinds.ts",
      "packages/core/src/gen/wallStyles.ts",
      "packages/core/src/plan/links.ts",
      "packages/core/src/resolve/roofTypes.ts",
      "packages/core/src/resolve/roof.ts",
    ],
    rules: { "slabyrinth/vocabulary": "error" },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/gen/catalog.ts"],
    rules: { "slabyrinth/feature-lists": "error" },
  },
  {
    // the stages that read a resolved plan (the resolver writes the themes)
    files: ["packages/core/src/{compile,review,render,text}/**/*.ts"],
    rules: { "slabyrinth/element-theme": "error" },
  },
  {
    // the generation side (schemas and tool definitions elsewhere spell the enum out on purpose)
    files: ["packages/core/src/{gen,resolve}/**/*.ts"],
    ignores: ["packages/core/src/gen/gridGeometry.ts"],
    rules: { "slabyrinth/sides": "error" },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", numberedEdgeKinds, handEdgeIndex, sideEffectImport] },
  },
  {
    // the one module that owns the edge layout
    files: ["packages/core/src/resolve/levelGrid.ts"],
    rules: { "no-restricted-syntax": ["error", numberedEdgeKinds, sideEffectImport] },
  },
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
