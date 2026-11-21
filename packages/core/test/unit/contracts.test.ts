/**
 * The normative contracts in docs/contracts/ each name the file they are copied into ("Copy verbatim into <path>").
 * The copy must equal the contract apart from the paths of its imports (`./plan` in docs is `../contracts/plan` or
 * `@slabyrinth/core/contracts/plan` in the code). The copies are found from that line, so a new contract is covered as
 * soon as it names its copy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url);
const CONTRACTS = new URL("docs/contracts/", ROOT);

/**
 * Copies that have drifted from their contract, with what drifted. A copy here is not compared; the list must stay
 * exactly the set of drifted copies, so bring a copy back in line (or the contract up to date, with the architect)
 * and take it off the list.
 */
const DRIFTED: Record<string, string> = {
  "tools.ts":
    "packages/core/src/agent/tools.ts grew far past the contract (model-facing texts, more input types); the contract was not kept up",
  "provider.ts":
    "apps/desktop/src/main/agent/provider/types.ts has ModelInfo.createdAt and a reworded guidance comment the contract lacks",
};

const read = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

/** The text with every module path in an import or export statement replaced by a placeholder. */
const withoutImportPaths = (text: string): string =>
  text.replace(/^((?:import|export)\b[^;]*?\bfrom\s*)(["'])[^"']+\2/gm, '$1"<path>"');

const contracts = readdirSync(CONTRACTS)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((file) => {
    const text = read(new URL(file, CONTRACTS));
    const copy = /Copy verbatim into (\S+?)\.?$/m.exec(text)?.[1];
    return { file, text, copy };
  });

describe("verbatim contract copies", () => {
  it("every contract names the file it is copied into", () => {
    expect(contracts.filter((c) => !c.copy).map((c) => c.file)).toEqual([]);
  });

  const compared = contracts.filter((c) => c.copy && !(c.file in DRIFTED));
  it.each(compared.map((c) => [c.file, c.copy ?? "", c.text] as const))(
    "%s is copied verbatim into %s (import paths aside)",
    (_file, copy, text) => {
      const actual = read(new URL(copy, ROOT));
      expect(withoutImportPaths(actual), `${copy} differs from docs/contracts beyond its import paths`).toBe(
        withoutImportPaths(text),
      );
    },
  );

  it("the drifted list names exactly the copies that differ", () => {
    const differ = contracts
      .filter((c) => c.copy && withoutImportPaths(read(new URL(c.copy, ROOT))) !== withoutImportPaths(c.text))
      .map((c) => c.file);
    expect(differ, `update DRIFTED in ${fileURLToPath(import.meta.url)}`).toEqual(
      Object.keys(DRIFTED).sort(),
    );
  });
});
