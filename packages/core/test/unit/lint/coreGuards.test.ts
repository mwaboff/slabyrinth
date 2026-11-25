/**
 * The core guards of eslint.config.js (the `slabyrinth/*` rules and the `no-restricted-syntax` selectors) still catch
 * what they were written for, in the files they are meant for, and leave the owner's own file alone. Each case lints a
 * snippet as if it were a file at a real path, through the repository's own config (so the files blocks are tested
 * too), with only the guard rules on: no type information is needed.
 */
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const eslint = new ESLint({ cwd: ROOT });
const linter = new Linter({ configType: "flat" });

/** Rules a guard test runs (the type-checked rules of the config need a program and say nothing about guards). */
const isGuard = (id: string): boolean =>
  id === "no-restricted-syntax" || id === "no-restricted-imports" || id.startsWith("slabyrinth/");

/** The guard messages a snippet gets at `file` (a path relative to the repository root). */
async function guardHits(file: string, code: string): Promise<string[]> {
  const filePath = `${ROOT}${file}`;
  const config = (await eslint.calculateConfigForFile(filePath)) as Linter.Config;
  const rules = Object.fromEntries(Object.entries(config.rules ?? {}).filter(([id]) => isGuard(id)));
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser },
        plugins: config.plugins ?? {},
        rules,
      },
    ],
    { filename: filePath },
  );
  const fatal = messages.find((m) => m.fatal === true);
  if (fatal) throw new Error(`${file}: ${fatal.message}`);
  return messages.map((m) => `${m.ruleId ?? "?"}: ${m.message}`);
}

/**
 * The guard messages of a snippet linted WITH type information: the snippet is a virtual file at `file` in a
 * TypeScript program of its own (so it can import the real contracts), for the guards that ask types.
 */
async function typedGuardHits(file: string, code: string): Promise<string[]> {
  const filePath = `${ROOT}${file}`.split("\\").join("/");
  const config = (await eslint.calculateConfigForFile(filePath)) as Linter.Config;
  const rules = Object.fromEntries(Object.entries(config.rules ?? {}).filter(([id]) => isGuard(id)));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const real = ts.createCompilerHost(options, true);
  const same = (f: string): boolean => f.split("\\").join("/").toLowerCase() === filePath.toLowerCase();
  const host: ts.CompilerHost = {
    ...real,
    getSourceFile: (f, lang, onError, create) =>
      same(f) ? ts.createSourceFile(f, code, lang, true) : real.getSourceFile(f, lang, onError, create),
    fileExists: (f) => same(f) || real.fileExists(f),
    readFile: (f) => (same(f) ? code : real.readFile(f)),
  };
  const program = ts.createProgram([filePath], options, host);
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program] } },
        plugins: config.plugins ?? {},
        rules,
      },
    ],
    { filename: filePath },
  );
  const fatal = messages.find((m) => m.fatal === true);
  if (fatal) throw new Error(`${file}: ${fatal.message}`);
  return messages.map((m) => `${m.ruleId ?? "?"}: ${m.message}`);
}

beforeAll(async () => {
  // build the config once before the cases time out on it
  await eslint.calculateConfigForFile(`${ROOT}packages/core/src/index.ts`);
}, 30_000);

describe("core guards", () => {
  describe("slabyrinth/core-layers: a core directory imports only lower rows of CORE_LAYERS", () => {
    it("reports an import of a later row, of the same row, and from a directory not in the table", async () => {
      const cases: Array<[string, string]> = [
        ["packages/core/src/compile/x.ts", 'import { reviewDesign } from "../review";'],
        ["packages/core/src/compile/x.ts", 'import { buildDisplayList } from "../render/display";'],
        ["packages/core/src/gen/x.ts", 'import { resolvePlan } from "../resolve";'],
        ["packages/core/src/newdir/x.ts", 'import { h32 } from "../util/hash";'],
      ];
      for (const [file, code] of cases)
        expect(await guardHits(file, code), `${file}: ${code}`).toEqual([
          expect.stringContaining("slabyrinth/core-layers"),
        ]);
    });
    it("allows imports downwards and within a directory", async () => {
      const cases: Array<[string, string]> = [
        ["packages/core/src/compile/x.ts", 'import { LevelGrid } from "../resolve/levelGrid";'],
        ["packages/core/src/review/x.ts", 'import { realize } from "../compile";'],
        ["packages/core/src/compile/realize/x.ts", 'import { emit } from "./level";'],
      ];
      for (const [file, code] of cases) expect(await guardHits(file, code), `${file}: ${code}`).toEqual([]);
    });
  });

  describe("no-restricted-imports: core is pure TypeScript outside src/cli", () => {
    it("reports Node built-ins, electron and react in core", async () => {
      for (const code of [
        'import { readFileSync } from "node:fs";',
        'import path from "path";',
        'import { app } from "electron";',
        'import { useState } from "react";',
      ])
        expect(await guardHits("packages/core/src/resolve/x.ts", code), code).toEqual([
          expect.stringContaining("no-restricted-imports"),
        ]);
    });
    it("allows Node built-ins in the CLI", async () => {
      expect(
        await guardHits("packages/core/src/cli/x.ts", 'import { readFileSync } from "node:fs";'),
      ).toEqual([]);
    });
  });

  describe("no-restricted-syntax: edge kinds and flags are imported, not numbered", () => {
    it("reports a local EDGE_/FLAG_ constant with a number", async () => {
      for (const code of ["const EDGE_WALL = 1;", "const FLAG_WATER = 4;"])
        expect(await guardHits("packages/core/src/compile/x.ts", code), code).toEqual([
          expect.stringContaining("Import edge kinds and cell flags"),
        ]);
    });
    it("allows naming the contract's value", async () => {
      expect(await guardHits("packages/core/src/compile/x.ts", "const EDGE_WALL = EDGE.WALL;")).toEqual([]);
    });
  });

  describe("no-restricted-syntax: a level's edges are indexed by resolve/levelGrid.ts", () => {
    it("reports the vertical-edge stride written by hand", async () => {
      for (const code of ["const i = y * (w + 1) + x;", "const i = y * (L.bounds.w + 1) + x;"])
        expect(await guardHits("packages/core/src/resolve/x.ts", code), code).toEqual([
          expect.stringContaining("resolve/levelGrid.ts"),
        ]);
    });
    it("allows it in levelGrid.ts and allows the readers", async () => {
      expect(await guardHits("packages/core/src/resolve/levelGrid.ts", "const i = y * (w + 1) + x;")).toEqual(
        [],
      );
      expect(await guardHits("packages/core/src/resolve/x.ts", "const i = vEdgeIndex(b, x, y);")).toEqual([]);
    });
  });

  describe("slabyrinth/spread-args: no spread arguments in Math.min, Math.max or push", () => {
    it("reports a spread in core and in render-canvas", async () => {
      for (const [file, code] of [
        ["packages/core/src/resolve/level/x.ts", "const m = Math.max(...d.values());"] as const,
        ["packages/core/src/review/x.ts", "const m = Math.min(0, ...xs);"],
        ["packages/core/src/compile/x.ts", "out.push(...more);"],
        ["packages/render-canvas/src/x.ts", "const m = Math.max(...xs);"],
      ])
        expect(await guardHits(file, code), code).toEqual([expect.stringContaining("util/lists.ts")]);
    });
    it("allows the helpers and plain arguments", async () => {
      for (const code of ["const m = maxOf(d.values());", "pushAll(out, more);", "const m = Math.max(a, b);"])
        expect(await guardHits("packages/core/src/review/x.ts", code), code).toEqual([]);
    });
  });

  describe("no-restricted-syntax: no core module is imported for its side effects", () => {
    it("reports a bare import", async () => {
      expect(await guardHits("packages/core/src/agent/x.ts", 'import "./registerChecks";')).toEqual([
        expect.stringContaining("side effects"),
      ]);
    });
    it("allows imports with bindings and type-only imports", async () => {
      for (const code of ['import { check } from "./checks";', 'import type { Check } from "./checks";'])
        expect(await guardHits("packages/core/src/agent/x.ts", code), code).toEqual([]);
    });
  });

  describe("slabyrinth/cell-theme: a resolve stage asks ResolveGrid.themeAt", () => {
    const stage = "packages/core/src/resolve/level/dressing.ts";
    it("reports the level theme and an index into the theme table", async () => {
      expect(await guardHits(stage, "const t = work.levelTheme;")).toEqual([
        expect.stringContaining("slabyrinth/cell-theme"),
      ]);
      expect(await guardHits(stage, "const t = work.themes[work.theme[i]];")).toEqual([
        expect.stringContaining("slabyrinth/cell-theme"),
      ]);
    });
    it("leaves the reader itself, and the owner's files, alone", async () => {
      expect(await guardHits(stage, "const t = work.themeAt(i);")).toEqual([]);
      expect(
        await guardHits("packages/core/src/resolve/level/grid.ts", "const t = this.levelTheme;"),
      ).toEqual([]);
      expect(await guardHits("packages/core/src/resolve/structure.ts", "const t = x.levelTheme;")).toEqual(
        [],
      );
    });
  });

  describe("slabyrinth/cell-owner: a resolve stage asks ResolveGrid who owns a cell", () => {
    const stage = "packages/core/src/resolve/level/bridges.ts";
    it("reports a read of the ownership arrays", async () => {
      for (const code of [
        "if (work.struct[i] === info.index + 1) f();",
        "const o = (work.struct[j] as number) - 1;",
        "const d = work.disp[i];",
      ])
        expect(await guardHits(stage, code), code).toEqual([
          expect.stringContaining("slabyrinth/cell-owner"),
        ]);
    });
    it("leaves the accessors, writes, and the grid and area table alone", async () => {
      for (const code of [
        "if (work.ownerAt(i) === info) f();",
        "work.struct[i] = 0;",
        "work.disp[i] = work.shownRegionAt(a);",
      ])
        expect(await guardHits(stage, code), code).toEqual([]);
      expect(await guardHits("packages/core/src/resolve/level/grid.ts", "const s = this.struct[i];")).toEqual(
        [],
      );
      expect(
        await guardHits("packages/core/src/resolve/level/areas.ts", "if (work.struct[i] === 0) f();"),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/vocabulary: a closed vocabulary is asked of its trait table", () => {
    const stage = "packages/core/src/resolve/level/openings.ts";
    it("reports an opening kind, a link kind, a roof type or a wall style compared by name", async () => {
      for (const code of [
        'if (o.kind === "double_door") f();',
        'if ("pit_drop" !== link.kind) f();',
        'if (layer.type === "gable") f();',
        'if (area.wallStyle === "cave_rock") f();',
      ])
        expect(await guardHits(stage, code), code).toEqual([
          expect.stringContaining("slabyrinth/vocabulary"),
        ]);
    });
    it("leaves other vocabularies, the trait readers and the tables alone", async () => {
      for (const code of [
        'if (op.op === "stairs") f();',
        'if (st.condition === "ruined") f();',
        "if (isGap(o.kind)) f();",
      ])
        expect(await guardHits(stage, code), code).toEqual([]);
      expect(
        await guardHits("packages/core/src/gen/openingKinds.ts", 'const t = (k) => k.kind === "window";'),
      ).toEqual([]);
      expect(
        await guardHits("packages/core/src/resolve/roof.ts", 'if (layer.type === "gable") f();'),
      ).toEqual([]);
    });
    it("reports a material compared by name, in the build and the review too", async () => {
      for (const file of [
        stage,
        "packages/core/src/compile/verify/fidelity.ts",
        "packages/core/src/review/x.ts",
      ])
        expect(await guardHits(file, 'if (cell.material === "lava") f();'), file).toEqual([
          expect.stringContaining("resolve/materials.ts"),
        ]);
      expect(
        await guardHits("packages/core/src/compile/x.ts", "if (MATERIAL_INFO[cell.material].hazard) f();"),
      ).toEqual([]);
    });
    it("reports kinds and types in every stage, held in a variable or tested with includes", async () => {
      const cases: Array<[string, string]> = [
        ["packages/core/src/compile/realize/links.ts", 'if (lk.kind === "ladder") f();'],
        ["packages/core/src/review/x.ts", 'if (o.kind !== "open") f();'],
        ["packages/core/src/render/display/roofs.ts", 'if (layer.type === "spire") f();'],
        ["packages/core/src/text/outline.ts", 'const run = ["stairs", "ramp"].includes(rl.kind);'],
        ["packages/core/src/resolve/building/volumes.ts", 'if (type === "gable") f();'],
      ];
      for (const [file, code] of cases)
        expect(await guardHits(file, code), `${file}: ${code}`).toEqual([
          expect.stringContaining("slabyrinth/vocabulary"),
        ]);
    });
    it("allows a switch that dispatches per word only when it ends in exhaustive", async () => {
      const file = "packages/core/src/compile/realize/structures/roofs.ts";
      expect(
        await guardHits(file, 'switch (layer.type) { case "gable": f(); break; default: g(); }'),
      ).toEqual([expect.stringContaining("exhaustive")]);
      expect(
        await guardHits(
          file,
          'switch (layer.type) { case "gable": f(); break; default: exhaustive(layer.type, "roof type"); }',
        ),
      ).toEqual([]);
      expect(await guardHits(file, 'switch (op.op) { case "stairs": f(); break; default: g(); }')).toEqual(
        [],
      );
    });
  });

  describe("slabyrinth/generic-theme: the fallback theme is GENERIC_THEME", () => {
    it('reports "generic" written in a stage', async () => {
      expect(await guardHits("packages/core/src/review/x.ts", 'const t = theme ?? "generic";')).toEqual([
        expect.stringContaining("GENERIC_THEME"),
      ]);
    });
    it("leaves the owner, the calibration slab and the constant alone", async () => {
      expect(
        await guardHits("packages/core/src/palette/resolve.ts", 'export const GENERIC_THEME = "generic";'),
      ).toEqual([]);
      expect(
        await guardHits("packages/core/src/compile/calibration.ts", 'byName("generic", "feature.chest");'),
      ).toEqual([]);
      expect(await guardHits("packages/core/src/review/x.ts", "const t = theme ?? GENERIC_THEME;")).toEqual(
        [],
      );
    });
  });

  describe("slabyrinth/light-words: a place's light words have one reader", () => {
    const code = 'import { lightNamedBy } from "../gen/lightLevels";';
    it("reports a reader of the light words outside the character resolver", async () => {
      expect(await guardHits("packages/core/src/review/lights.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/light-words"),
      ]);
    });
    it("leaves the character resolver alone", async () => {
      expect(await guardHits("packages/core/src/resolve/character.ts", code)).toEqual([]);
    });
  });

  describe("slabyrinth/generator-switches: generator behaviour is a switch", () => {
    it("reports a generator compared with a version, and a switch on the generator", async () => {
      const cases: Array<[string, string]> = [
        ["packages/core/src/resolve/x.ts", "if (plan.generator >= 4) f();"],
        ["packages/core/src/compile/x.ts", "if (3 === resolved.generator) f();"],
        ["packages/core/src/review/x.ts", "if (generator < 3) f();"],
        ["apps/desktop/src/main/x.ts", "if (GENERATOR_VERSION === 4) f();"],
        ["packages/core/src/gen/x.ts", "switch (grid.generator) { case 4: f(); }"],
      ];
      for (const [file, code] of cases)
        expect(await guardHits(file, code), code).toEqual([expect.stringContaining("SWITCHES")]);
    });
    it("leaves switch reads, the switch table and tests alone", async () => {
      expect(
        await guardHits("packages/core/src/resolve/x.ts", "if (generatorProfile(plan).roads) f();"),
      ).toEqual([]);
      expect(
        await guardHits("packages/core/src/plan/generator.ts", "const upTo = (v) => v.generator <= 4;"),
      ).toEqual([]);
      expect(await guardHits("packages/core/src/resolve/x.test.ts", "if (plan.generator >= 4) f();")).toEqual(
        [],
      );
    });
  });

  describe("slabyrinth/review-weights: a note's weight lives in review/thresholds.ts", () => {
    it("reports a bare number as a note's score", async () => {
      expect(
        await guardHits("packages/core/src/review/x.ts", 'notes.push({ code: "c", score: 4 });'),
      ).toEqual([expect.stringContaining("review/thresholds.ts")]);
    });
    it("leaves weights read from REVIEW, and the table itself, alone", async () => {
      expect(
        await guardHits("packages/core/src/review/x.ts", 'notes.push({ code: "c", score: T.weight * 1.5 });'),
      ).toEqual([]);
      expect(await guardHits("packages/core/src/review/thresholds.ts", "const s = { score: 4 };")).toEqual(
        [],
      );
    });
  });

  describe("no-restricted-imports: core tests only read files", () => {
    it("reports a file write imported by a core test", async () => {
      for (const code of [
        'import { writeFileSync } from "node:fs";',
        'import { mkdir } from "node:fs/promises";',
      ])
        expect(await guardHits("packages/core/test/unit/x.test.ts", code), code).toEqual([
          expect.stringContaining("update script"),
        ]);
    });
    it("allows reads, the CLI test's temporary files and the golden update script", async () => {
      expect(
        await guardHits("packages/core/test/unit/x.test.ts", 'import { readFileSync } from "node:fs";'),
      ).toEqual([]);
      expect(
        await guardHits(
          "packages/core/test/unit/cli/cli.test.ts",
          'import { writeFileSync } from "node:fs";',
        ),
      ).toEqual([]);
      expect(
        await guardHits(
          "packages/core/test/golden/generator6/update.ts",
          'import { writeFileSync } from "node:fs";',
        ),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/feature-lists: a feature trait is a catalog field", () => {
    it("reports a hand list of feature types outside the catalog", async () => {
      const code = 'const BIG = new Set<FeatureType>(["tree", "landmark"]);';
      expect(await guardHits("packages/core/src/gen/setpieces.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/feature-lists"),
      ]);
      expect(await guardHits("packages/core/src/gen/catalog.ts", code)).toEqual([]);
      expect(
        await guardHits(
          "packages/core/src/gen/setpieces.ts",
          "const BIG = new Set(typesWith((f) => f.overhangs === true));",
        ),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/feature-compares: the room furnisher asks feature traits", () => {
    it("reports a feature type compared by name in the furnisher", async () => {
      const file = "packages/core/src/gen/rooms4/wall.ts";
      expect(await guardHits(file, 'if (spec.type === "bed") f();')).toEqual([
        expect.stringContaining("slabyrinth/feature-compares"),
      ]);
      expect(await guardHits(file, 'const lit = q.type !== "bar_counter";')).toHaveLength(1);
    });
    it("leaves a trait read and generator 4's light rule alone", async () => {
      expect(
        await guardHits(
          "packages/core/src/gen/rooms4/wall.ts",
          "if (featureInfo(spec.type).sleepsIn === true) f();",
        ),
      ).toEqual([]);
      expect(
        await guardHits("packages/core/src/gen/rooms4/lights.ts", 'const x = q.type !== "clutter";'),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/sides: sides and their opposites come from gen/gridGeometry.ts", () => {
    const file = "packages/core/src/resolve/structure.ts";
    it("reports the four sides written out and a ternary that turns a side round", async () => {
      expect(await guardHits(file, 'for (const s of ["N", "E", "S", "W"]) f(s);')).toEqual([
        expect.stringContaining("slabyrinth/sides"),
      ]);
      expect(await guardHits(file, 'const back = front === "N" ? "S" : "N";')).toHaveLength(1);
    });
    it("leaves other side logic, the geometry module and the schemas alone", async () => {
      expect(await guardHits(file, 'const face = f0 === "N" ? "N" : "S";')).toEqual([]);
      expect(
        await guardHits("packages/core/src/gen/gridGeometry.ts", 'const S = ["N", "E", "S", "W"];'),
      ).toEqual([]);
      expect(
        await guardHits("packages/core/src/plan/schema.ts", 'const S = z.enum(["N", "E", "S", "W"]);'),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/variant-filters: a variant filter is made in palette/filters.ts", () => {
    it("reports a { key, test } literal anywhere in core but the owner", async () => {
      const code = 'const one = { key: "1x1", test: (v) => v.footprint[0] === 1 };';
      expect(await guardHits("packages/core/src/compile/realize/floors.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/variant-filters"),
      ]);
      expect(await guardHits("packages/core/src/palette/filters.ts", code)).toEqual([]);
    });
    it("leaves other objects with a key alone", async () => {
      const file = "packages/core/src/compile/realize/floors.ts";
      expect(await guardHits(file, 'const k = { key: "a", value: 1 };')).toEqual([]);
      expect(await guardHits(file, "const r = lookup(t, roles, ONE_CELL);")).toEqual([]);
    });
  });

  describe("slabyrinth/element-theme: a resolved element's theme is read with elementTheme", () => {
    it("reports `x.theme || other` in a stage that reads a resolved plan", async () => {
      expect(
        await guardHits("packages/core/src/compile/realize/features.ts", "const t = f.theme || cell.theme;"),
      ).toEqual([expect.stringContaining("slabyrinth/element-theme")]);
      expect(await guardHits("packages/core/src/review/stalls.ts", 'const t = s.theme || "";')).toHaveLength(
        1,
      );
    });
    it("leaves the reader, other fallbacks and the resolver alone", async () => {
      const file = "packages/core/src/compile/realize/features.ts";
      expect(await guardHits(file, "const t = V.themeAt(f.theme, x, y);")).toEqual([]);
      expect(await guardHits(file, "const t = f.theme ?? fallback;")).toEqual([]);
      expect(
        await guardHits("packages/core/src/resolve/level/features.ts", "const t = f.theme || cell.theme;"),
      ).toEqual([]);
    });
    const typed = (body: string): string =>
      [
        'import type { ResolvedFeature, ResolvedLink, ResolvedStructure } from "../contracts/resolved";',
        "declare function themeAt(own: string, x: number, y: number): string;",
        "declare function elementThemeAt(own: string, l: unknown, at: readonly [number, number], d: string): string;",
        "declare const f: ResolvedFeature;",
        "declare const lk: ResolvedLink;",
        "declare const st: ResolvedStructure;",
        "declare function use(t: string): void;",
        body,
      ].join("\n");
    it("with types: reports a bare read of a feature's or a link's theme", async () => {
      for (const body of ["use(f.theme);", "const t = lk.theme;", "const g = { theme: f.theme };"])
        expect(await typedGuardHits("packages/core/src/compile/x.ts", typed(body)), body).toEqual([
          expect.stringContaining("slabyrinth/element-theme"),
        ]);
    }, 30_000); // type-aware lint of three snippets: about 2.5 s locally under a parallel run
    it("with types: leaves the readers' own argument, a structure's theme and a write alone", async () => {
      for (const body of [
        "use(themeAt(f.theme, 1, 2));",
        'use(elementThemeAt(lk.theme, null, [1, 2], "x"));',
        "use(st.theme);",
        'f.theme = "x";',
      ])
        expect(await typedGuardHits("packages/core/src/review/x.ts", typed(body)), body).toEqual([]);
    }, 30_000); // type-aware lint of four snippets: about 2.5 s locally under a parallel run
  });

  describe("slabyrinth/hash-unit: a draw from a hash goes through util/hash.ts", () => {
    it("reports 2^32 written by hand anywhere in core but util", async () => {
      const code = "const u = h32(`${seed}:k`) / 4294967296;";
      expect(await guardHits("packages/core/src/resolve/ruin.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/hash-unit"),
      ]);
      expect(await guardHits("packages/core/src/compile/shell.ts", code)).toHaveLength(1);
      expect(await guardHits("packages/core/src/util/hash.ts", "const TWO_32 = 4294967296;")).toEqual([]);
      expect(await guardHits("packages/core/src/resolve/ruin.ts", 'const u = hashUnit(seed, "k");')).toEqual(
        [],
      );
    });
    it("reports a second definition of a string hash outside util/hash.ts", async () => {
      const code = "export function h32(s: string): number { return s.length; }";
      expect(await guardHits("packages/core/src/compile/geometry.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/hash-unit"),
      ]);
      expect(
        await guardHits("packages/core/src/compile/geometry.ts", "const unitHash = (s: string) => s.length;"),
      ).toHaveLength(1);
      expect(await guardHits("packages/core/src/util/hash.ts", code)).toEqual([]);
      expect(await guardHits("packages/core/src/compile/geometry.ts", "const n = h32Utf16(k);")).toEqual([]);
    });
  });
});

/** The app guards of the same config (apps/desktop): one rule mechanism, run the same way. */
describe("app guards", () => {
  describe("slabyrinth/app-layers: shared below main / renderer / preload, which do not import each other", () => {
    it("reports shared importing main or the renderer, and the renderer, main and preload importing each other", async () => {
      const cases: Array<[string, string]> = [
        ["apps/desktop/src/shared/x.ts", 'import { a } from "../main/services/projectService";'],
        ["apps/desktop/src/shared/x.ts", 'import { a } from "../renderer/stores/app";'],
        ["apps/desktop/src/renderer/x.ts", 'import { a } from "../main/ipc/router";'],
        ["apps/desktop/src/main/x.ts", 'import { a } from "../renderer/bridge/client";'],
        ["apps/desktop/src/preload/x.ts", 'import { a } from "../main/ipc/router";'],
      ];
      for (const [file, code] of cases)
        expect(await guardHits(file, code), `${file}: ${code}`).toEqual([
          expect.stringContaining("slabyrinth/app-layers"),
        ]);
    });
    it("allows imports downwards, within a layer, the provider contract copy, and the conformance tests", async () => {
      const cases: Array<[string, string]> = [
        ["apps/desktop/src/main/x.ts", 'import { a } from "../shared/schemas/ipc";'],
        ["apps/desktop/src/renderer/x.ts", 'import { a } from "./stores/app";'],
        ["apps/desktop/src/renderer/x.ts", 'import type { A } from "../main/agent/provider/types";'],
        ["apps/desktop/src/shared/x.ts", 'import { EFFORT_LEVELS } from "../main/agent/provider/types";'],
        ["apps/desktop/src/conformance/x.ts", 'import { a } from "../renderer/bridge/fake/fakeBridge";'],
      ];
      for (const [file, code] of cases) expect(await guardHits(file, code), `${file}: ${code}`).toEqual([]);
    });
  });

  describe("slabyrinth/reported-calls: a renderer IPC call does not lose its failure", () => {
    const file = "apps/desktop/src/renderer/features/x.ts";
    it("reports void call(...) and void call(...).then(...)", async () => {
      for (const code of [
        'void call("plan:undo", undefined);',
        'void call("app:getInfo", undefined).then((i) => use(i));',
      ])
        expect(await guardHits(file, code), code).toEqual([
          expect.stringContaining("slabyrinth/reported-calls"),
        ]);
    });
    it("reports a catch that swallows the failure without a trace", async () => {
      for (const code of [
        "void load().catch(() => undefined);",
        "void load().catch(() => {});",
        "void load().catch(() => null);",
      ])
        expect(await guardHits(file, code), code).toEqual([
          expect.stringContaining("slabyrinth/reported-calls"),
        ]);
      expect(
        await guardHits(file, 'void load().catch((e: unknown) => { console.warn("load failed", e); });'),
      ).toEqual([]);
    });
    it("leaves run, tryCall and awaited calls alone", async () => {
      for (const code of [
        'void run("plan:undo", undefined, "Couldn\'t undo.");',
        'void tryCall("app:getInfo", undefined).then((r) => use(r));',
        'async function f() { await call("plan:undo", undefined); }',
      ])
        expect(await guardHits(file, code), code).toEqual([]);
    });
  });

  describe("slabyrinth/game-systems: a game system is asked of core's table", () => {
    it("reports a comparison with a system's id in the app", async () => {
      for (const code of ['if (sys === "dnd5e") f();', 'const own = "other" !== id;'])
        expect(await guardHits("apps/desktop/src/renderer/features/x.ts", code), code).toEqual([
          expect.stringContaining("slabyrinth/game-systems"),
        ]);
    });
    it("leaves table reads, the fake bridge and tests alone", async () => {
      const code = 'if (sys === "dnd5e") f();';
      expect(
        await guardHits(
          "apps/desktop/src/renderer/features/x.ts",
          'if (GAME_SYSTEM_PARTY_MEASURE[sys] === "level") f();',
        ),
      ).toEqual([]);
      expect(await guardHits("apps/desktop/src/renderer/bridge/fake/x.ts", code)).toEqual([]);
      expect(await guardHits("apps/desktop/src/renderer/features/x.test.ts", code)).toEqual([]);
    });
  });

  describe("slabyrinth/project-switch: view state follows its project", () => {
    const file = "apps/desktop/src/renderer/features/x.ts";
    it("reports view state sent past the store, and a project switch outside switchProject", async () => {
      for (const code of [
        'call("project:setUiState", { ui: { zoom: 2 } }).catch(warn);',
        'async function f() { await call("project:open", { path: p }); }',
        'async function f() { await tryCall("project:close", {}); }',
      ])
        expect(await guardHits(file, code), code).toEqual([
          expect.stringContaining("slabyrinth/project-switch"),
        ]);
    });
    it("leaves switches inside switchProject, the store itself and other channels alone", async () => {
      for (const code of [
        'async function f() { await switchProject(() => call("project:open", { path: p })); }',
        'async function f() { await switchProject(async () => { await call("project:close", {}); }); }',
        'async function f() { await call("project:rename", { name }); }',
      ])
        expect(await guardHits(file, code), code).toEqual([]);
      expect(
        await guardHits(
          "apps/desktop/src/renderer/stores/project.ts",
          'call("project:setUiState", { ui: {} }).catch(warn);',
        ),
      ).toEqual([]);
    });
  });

  describe("slabyrinth/parsed-json: JSON from outside is validated, not cast", () => {
    it("reports a cast of JSON.parse in the app and the CLI, not in tests", async () => {
      const code = "const p = JSON.parse(text) as MapPlan;";
      expect(await guardHits("apps/desktop/src/main/services/x.ts", code)).toEqual([
        expect.stringContaining("slabyrinth/parsed-json"),
      ]);
      expect(await guardHits("packages/core/src/cli/x.ts", code)).toHaveLength(1);
      expect(await guardHits("apps/desktop/src/main/services/x.test.ts", code)).toEqual([]);
    });
    it("allows parsing to unknown, and Partial<T> followed by field checks", async () => {
      for (const code of [
        "const p = JSON.parse(text) as unknown;",
        "const p: unknown = JSON.parse(text);",
        "const p = JSON.parse(text) as Partial<LockInfo>;",
      ])
        expect(await guardHits("apps/desktop/src/main/services/x.ts", code), code).toEqual([]);
    });
    it("reports a cast of a JSON-reading helper's result, awaited or through unknown", async () => {
      for (const code of [
        "const p = readJson(path, io) as MapPlan;",
        "const c = io.readCatalogJson(path) as AssetCatalog;",
        "async function f() { return (await readJsonFile(file)) as Palette; }",
        "const p = readJson(path, io) as unknown as MapPlan;",
        "const p = load(path) as unknown as MapPlan;",
      ])
        expect(await guardHits("packages/core/src/cli/x.ts", code), code).toEqual([
          expect.stringContaining("slabyrinth/parsed-json"),
        ]);
    });
    it("allows validating a helper's result, and double casts of values that are not read JSON", async () => {
      for (const code of [
        "const p = parsePlan(readJson(path, io));",
        "const raw: unknown = readJson(path, io);",
        "const v = readJson(path, io) as Unparsed;",
        "const api = (window as unknown as { api?: Api }).api;",
      ])
        expect(await guardHits("packages/core/src/cli/x.ts", code), code).toEqual([]);
    });
  });
});
