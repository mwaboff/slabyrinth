/**
 * The normative contracts in docs/contracts/ each name the file they are copied into ("Copy verbatim into <path>").
 * The copy must equal the contract apart from the paths of its imports (`./plan` in docs is `../contracts/plan` or
 * `@slabyrinth/core/contracts/plan` in the code). The copies are found from that line, so a new contract is covered as
 * soon as it names its copy. There are no exceptions: a contract holds only what is normative, so its copy is that
 * contract and nothing else (code that builds on it, such as the agent's model-facing tool definitions in
 * agent/tools.ts, lives in its own file and imports the copy).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url);
const CONTRACTS = new URL("docs/contracts/", ROOT);

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

  it.each(contracts.map((c) => [c.file, c.copy ?? "", c.text] as const))(
    "%s is copied verbatim into %s (import paths aside)",
    (_file, copy, text) => {
      const actual = read(new URL(copy, ROOT));
      expect(withoutImportPaths(actual), `${copy} differs from docs/contracts beyond its import paths`).toBe(
        withoutImportPaths(text),
      );
    },
  );
});
