import { MARKER_ROLE } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import type { BuildRecord } from "./project";
import { pastesOutOfLine } from "./pasteRegister";

function rec(
  slabs: number,
  markers: BuildRecord["settings"]["markers"],
  unmatched: string[] = [],
): Pick<BuildRecord, "settings" | "levels" | "unmatchedAssets"> {
  return {
    settings: { markers } as BuildRecord["settings"],
    levels: [{ chunks: Array.from({ length: slabs }, () => ({})) }] as unknown as BuildRecord["levels"],
    unmatchedAssets: unmatched.map((role) => ({ role, count: 1 })),
  };
}

describe("pastesOutOfLine", () => {
  it("a split build without pillars cannot be pasted in line", () => {
    expect(pastesOutOfLine(rec(18, "none"))).toBe(true);
    expect(pastesOutOfLine(rec(2, "multi-chunk", [MARKER_ROLE]))).toBe(true);
  });

  it("a split build with pillars, or a single slab, can", () => {
    expect(pastesOutOfLine(rec(18, "multi-chunk"))).toBe(false);
    expect(pastesOutOfLine(rec(18, "always", ["tree.oak"]))).toBe(false);
    expect(pastesOutOfLine(rec(1, "none"))).toBe(false);
  });
});
