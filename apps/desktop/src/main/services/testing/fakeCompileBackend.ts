import { createHash } from "node:crypto";
import type { MapPlan, SlabChunk } from "@slabyrinth/core";
import type { CompileBackend } from "../../ports/compile";

/** Test double for the compile worker: fast, deterministic, and its "slabs" say they are not real. */
const levelArea = (plan: MapPlan, id: string): number => {
  const l = plan.levels.find((x) => x.id === id);
  return l ? l.bounds.w * l.bounds.h : 0;
};

export const fakeCompileBackend: CompileBackend = {
  estimate(input, levels) {
    const ids = levels ?? input.plan.levels.map((l) => l.id);
    const perLevel = ids.map((levelId) => {
      const assets = Math.round(levelArea(input.plan, levelId) * 0.6);
      return { levelId, assets, estimatedChunks: Math.max(1, Math.ceil(assets / 1500)) };
    });
    const totalAssets = perLevel.reduce((n, l) => n + l.assets, 0);
    return {
      perLevel,
      totalAssets,
      estimatedChunks: totalAssets === 0 ? 0 : Math.max(1, Math.ceil(totalAssets / 1500)),
      diagnostics: [],
    };
  },
  compile(input, progress) {
    // like core's default: ONE slab holding every level; the chunk's levelId is the lowest level
    const plan = input.plan;
    const ids = input.options.levels ?? plan.levels.map((l) => l.id);
    progress("realize", 0, 1);
    const levels = plan.levels.filter((l) => ids.includes(l.id)).sort((a, b) => a.elevation - b.elevation);
    const chunks: SlabChunk[] = [];
    const first = levels[0];
    if (first) {
      const x = Math.min(...levels.map((l) => l.bounds.x));
      const y = Math.min(...levels.map((l) => l.bounds.y));
      const w = Math.max(...levels.map((l) => l.bounds.x + l.bounds.w)) - x;
      const h = Math.max(...levels.map((l) => l.bounds.y + l.bounds.h)) - y;
      const assets = levels.reduce((n, l) => n + Math.round(l.bounds.w * l.bounds.h * 0.6), 0);
      const slab = `NOT-A-REAL-SLAB:${plan.id}`;
      chunks.push({
        id: "build-01",
        levelId: first.id,
        levelIds: levels.map((l) => l.id),
        index: 1,
        countInLevel: 1,
        slab,
        compressedBytes: slab.length,
        base64Length: slab.length,
        assetCount: assets,
        bounds: {
          min: { x: 0, y: first.elevation, z: 0 },
          max: { x: w, y: Math.max(...levels.map((l) => l.elevation)) + 2, z: h },
        },
        cellRect: { x, y, w, h },
        pasteNote: "Fake build (test double).",
        hasAlignmentMarkers: false,
        label: "Whole map",
        columns: "",
        offsetFromFirst: { x: 0, y: 0, z: 0 },
        contentHash: createHash("sha256").update(JSON.stringify(levels)).digest("hex"),
      });
    }
    progress("encode", 1, 1);
    const sorted = [...plan.levels]
      .sort((a, b) => a.elevation - b.elevation)
      .filter((l) => ids.includes(l.id));
    return {
      planId: plan.id,
      planVersion: 0,
      resolvedHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16),
      createdAt: new Date().toISOString(),
      chunks,
      diagnostics: [],
      stats: {
        totalAssets: chunks.reduce((n, c) => n + c.assetCount, 0),
        totalChunks: chunks.length,
        perLevel: ids.map((levelId) => ({
          levelId,
          assets: Math.round(levelArea(plan, levelId) * 0.6),
          chunks: 1,
        })),
        droppedPlacements: 0,
      },
      instructions: "Fake build (test double).",
      assetSource: input.availability ? "install" : "builtin",
      substitutions: [],
      levelPlacement: sorted.map((l, idx) => ({
        levelId: l.id,
        pasteOrder: idx + 1,
        kind: idx === 0 ? "ground" : "storeys-up",
        storeys: idx,
      })),
    };
  },
};
