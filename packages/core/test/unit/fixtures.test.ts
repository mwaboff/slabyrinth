/**
 * The stored plan fixtures are listed once (test/fixtures/index.ts) and each is stored once: a copy under a second name
 * looks like a second case and is not one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATOR_TEST_PLANS, STORED_PLANS, storedPlanFiles, storedPlanUrl } from "../fixtures";

describe("stored plan fixtures", () => {
  it("the lists name exactly the files in each directory", () => {
    const files = storedPlanFiles();
    expect(files.plans, "test/fixtures/plans: add the file's name to STORED_PLANS").toEqual(
      [...STORED_PLANS].sort(),
    );
    expect(
      files.generatorTests,
      "test/unit/gen/fixtures: add the file's name to GENERATOR_TEST_PLANS",
    ).toEqual([...GENERATOR_TEST_PLANS].sort());
  });

  it("no plan is stored twice under two names", () => {
    const byHash = new Map<string, string[]>();
    for (const name of [...STORED_PLANS, ...GENERATOR_TEST_PLANS]) {
      const hash = createHash("sha256")
        .update(readFileSync(storedPlanUrl(name)))
        .digest("hex");
      byHash.set(hash, [...(byHash.get(hash) ?? []), name]);
    }
    expect([...byHash.values()].filter((names) => names.length > 1)).toEqual([]);
  });
});
