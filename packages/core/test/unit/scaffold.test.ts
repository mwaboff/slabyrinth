import { describe, expect, it } from "vitest";
import * as core from "../../src/index";

// Scaffold smoke test: proves the runner and the contract re-exports work. Safe to delete
// once real tests exist.
describe("@slabyrinth/core scaffold", () => {
  it("re-exports runtime catalogs from the contracts", () => {
    expect(Array.isArray(core.MATERIALS)).toBe(true);
    expect(core.MATERIALS.length).toBeGreaterThan(0);
  });
});
