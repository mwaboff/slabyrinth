/**
 * The core guards of eslint.config.js (the `slabyrinth/*` rules and the `no-restricted-syntax` selectors) still catch
 * what they were written for, in the files they are meant for, and leave the owner's own file alone. Each case lints a
 * snippet as if it were a file at a real path, through the repository's own config (so the files blocks are tested
 * too), with only the guard rules on: no type information is needed.
 */
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const eslint = new ESLint({ cwd: ROOT });
const linter = new Linter({ configType: "flat" });

/** Rules a guard test runs (the type-checked rules of the config need a program and say nothing about guards). */
const isGuard = (id: string): boolean => id === "no-restricted-syntax" || id.startsWith("slabyrinth/");

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

beforeAll(async () => {
  // build the config once before the cases time out on it
  await eslint.calculateConfigForFile(`${ROOT}packages/core/src/index.ts`);
}, 30_000);

describe("core guards", () => {
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
