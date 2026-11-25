/**
 * The scene3d guards of eslint.config.js still hold: no Node built-in in scene3d's source (it runs in the app's
 * workers too), and imports follow SCENE3D_LAYERS. Each case lints a snippet as a file at a real path through the
 * repository's own config, with only the guard rules on.
 */
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: ROOT });
const linter = new Linter({ configType: "flat" });

const isGuard = (id: string): boolean => id === "no-restricted-imports" || id.startsWith("slabyrinth/");

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
  return messages.map((m) => `${m.ruleId ?? "?"}: ${m.message}`);
}

describe("scene3d guards", () => {
  it("refuses a node:* import in scene3d's source", async () => {
    const hits = await guardHits(
      "packages/scene3d/src/raster/x.ts",
      'import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
    );
    expect(hits.join("\n")).toContain("Node built-ins belong in packages/render-cli");
  });

  it("refuses a bare built-in name too", async () => {
    const hits = await guardHits(
      "packages/scene3d/src/scene/x.ts",
      'import fs from "fs";\nexport const f = fs;\n',
    );
    expect(hits.join("\n")).toContain("Node built-ins belong in packages/render-cli");
  });

  it("allows node:* in render-cli", async () => {
    const hits = await guardHits(
      "packages/render-cli/src/x.ts",
      'import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
    );
    expect(hits).toEqual([]);
  });

  it("refuses an import against the layer order", async () => {
    const hits = await guardHits(
      "packages/scene3d/src/raster/x.ts",
      'import { s } from "../shots/y";\nexport const f = s;\n',
    );
    expect(hits.join("\n")).toContain("SCENE3D_LAYERS");
  });
});
