/**
 * Every code the build and the review can emit is asserted somewhere: each verify diagnostic code (VERIFY_CODES) and
 * each design-review note code (review/review.ts DesignNoteCode) appears, quoted, in at least one test file under
 * packages/core/test. A new code without a test fails here; write a small fixture that triggers it (verify:
 * test/unit/compile/verify.test.ts "one fixture per code"; review: test/unit/review/).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERIFY_CODES } from "../../src/compile";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const THIS = fileURLToPath(import.meta.url);

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

/** The text of every test source (not this file, which lists no codes but names them through the scan). */
const TESTS = tsFiles(join(ROOT, "test"))
  .filter((f) => f !== THIS)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** The members of the DesignNoteCode union, read from its declaration. */
function noteCodes(): string[] {
  const src = readFileSync(join(ROOT, "src", "review", "review.ts"), "utf8");
  const decl = /export type DesignNoteCode =([^;]+);/.exec(src)?.[1];
  if (decl === undefined) throw new Error("review/review.ts: DesignNoteCode union not found");
  return [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

const untested = (codes: readonly string[]): string[] => codes.filter((c) => !TESTS.includes(`"${c}"`));

describe("every emitted code is asserted by a test", () => {
  it("every verify code", () => {
    expect(VERIFY_CODES.length).toBeGreaterThan(20);
    expect(untested(VERIFY_CODES), "verify codes no test names: add a fixture in verify.test.ts").toEqual([]);
  });

  it("every design-review note code", () => {
    const codes = noteCodes();
    expect(codes.length).toBeGreaterThan(50);
    expect(untested(codes), "note codes no test names: add a fixture under test/unit/review/").toEqual([]);
  });
});
