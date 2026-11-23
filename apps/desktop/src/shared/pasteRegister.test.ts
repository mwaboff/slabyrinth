import { MARKER_ROLE } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import type { BuildRecord } from "./project";
import { outOfLineCause, outOfLineMessage, pastesOutOfLine } from "./pasteRegister";

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

  it("says why: a build made without pillars can be built again; palettes with no pillar piece cannot", () => {
    expect(outOfLineCause(rec(18, "none"))).toBe("turnedOff");
    expect(outOfLineMessage(rec(18, "none"))).toMatch(/Build again to add the pillars/);
    expect(outOfLineCause(rec(2, "multi-chunk", [MARKER_ROLE]))).toBe("noPiece");
    expect(outOfLineMessage(rec(2, "multi-chunk", [MARKER_ROLE]))).toMatch(/Building again will not fix it/);
    expect(outOfLineCause(rec(18, "multi-chunk"))).toBeNull();
    expect(outOfLineMessage(rec(1, "none"))).toBe("");
  });

  it("a split build with pillars, or a single slab, can", () => {
    expect(pastesOutOfLine(rec(18, "multi-chunk"))).toBe(false);
    expect(pastesOutOfLine(rec(18, "always", ["tree.oak"]))).toBe(false);
    expect(pastesOutOfLine(rec(1, "none"))).toBe(false);
  });
});
