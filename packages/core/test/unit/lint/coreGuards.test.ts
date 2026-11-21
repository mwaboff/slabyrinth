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
  });
});
