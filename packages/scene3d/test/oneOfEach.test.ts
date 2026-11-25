/**
 * One of each (a source scan): the checks decide by the numbers of checks/thresholds.ts only, boxes are made by
 * geom/box.ts (over core's emptyBox and growBox) only, and a GUID is formatted by core's slab/guid.ts only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE = fileURLToPath(new URL("../../core/src/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}
const code = (f: string): string =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("one of each", () => {
  it("decides findings by the thresholds table only", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "checks"))) {
      if (f.endsWith("thresholds.ts")) continue;
      // a comparison or a sum with a decimal literal is a threshold written in a check
      // (a half step to a centre, + 0.5, is geometry)
      for (const m of code(f).matchAll(/(?:[<>]=?|[+-])\s*\d*\.\d+\b/g))
        if (m[0] !== "+ 0.5") bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("makes boxes in one place", () => {
    const bad = files(SRC)
      .filter((f) => !f.endsWith(join("geom", "box.ts")))
      .filter((f) => /\{\s*x:\s*Infinity,\s*y:\s*Infinity|function\s+(grow|emptyBox)\b/.test(code(f)));
    expect(bad).toEqual([]);
  });

  it("formats a GUID in one place", () => {
    const bad = files(CORE)
      .filter((f) => !f.endsWith(join("slab", "guid.ts")))
      .filter((f) => /toString\(16\)\.padStart\(2/.test(code(f)));
    expect(bad).toEqual([]);
  });
});
