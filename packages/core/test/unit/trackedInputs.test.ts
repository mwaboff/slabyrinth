/**
 * Tests read only files that are in the repository. `docs/internal/` is git-ignored: a test that reads a plan from there
 * passes on the machine that has it and fails on CI and every clean clone. Copy the plan to `test/fixtures/plans/` instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const roots = ["../../test", "../../src", "../../../../apps/desktop/src"].map((r) =>
  fileURLToPath(new URL(r, import.meta.url)),
);

function sources(dir: string): string[] {
  let out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(sources(p));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

/** A path inside a string literal (a comment that cites a document is fine). */
const IGNORED_PATH = /["'`][^"'`\n]*docs\/internal\//;

describe("tests and code read only tracked files", () => {
  it("no source or test names a path under the git-ignored internal docs", () => {
    const offenders = roots.flatMap(sources).filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some((line) => IGNORED_PATH.test(line) && !/^\s*(\*|\/\/)/.test(line)),
    );
    expect(offenders).toEqual([]);
  });
});
