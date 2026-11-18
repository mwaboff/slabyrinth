import { describe, expect, it } from "vitest";
import { slabEstimate } from "./format";

describe("slabEstimate", () => {
  it("words the pre-build count as an estimate", () => {
    expect(slabEstimate(0)).toBe("about one slab");
    expect(slabEstimate(1)).toBe("about one slab");
    expect(slabEstimate(3)).toBe("about 3 slab parts");
  });
});
