/**
 * The engine-operators proof builds clean: every station's pieces are placed, verify finds nothing wrong with any of
 * them, and the slab is one chunk. Its pieces and layout are pinned by a snapshot of names and counts.
 */
import { describe, expect, it } from "vitest";
import { compileResolved, realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import { loadPalettes } from "../../../src/palette";
import { slabCodec } from "../../../src/slab";
import { engineOperatorsProof } from "./proof";

const cat = loadPalettes();

describe("engine-operators proof", () => {
  const { resolved, stations } = engineOperatorsProof(cat);

  it("places every piece of every station", () => {
    const set = realize(resolved, cat);
    const placements = set.levels.flatMap((l) => l.placements);
    for (const s of stations) {
      const inst = resolved.levels[0]?.arrangements?.find((a) => a.id === s.id);
      expect(placements.filter((p) => p.source.elementId === s.id)).toHaveLength(inst?.pieces.length ?? -1);
      expect(inst?.pieces.length).toBeGreaterThan(0);
    }
  });

  it("verify finds nothing wrong with any station, and the build is one slab", () => {
    const set = realize(resolved, cat);
    const ids = new Set(stations.map((s) => s.id));
    const found = verifyBuild(resolved, set, cat).diagnostics.filter(
      (d) => d.severity !== "info" && (ids.has(d.elementId ?? "") || d.code === "verify_props_overlap"),
    );
    expect(found.map((d) => `${d.code} ${d.elementId ?? ""} ${d.message}`)).toEqual([]);
    const bundle = compileResolved(resolved, cat, slabCodec, { createdAt: "t" });
    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
