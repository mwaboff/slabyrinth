import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SlabAsset, SlabChunk } from "../../../src/contracts/compiler";
import {
  calibrationAssetsFrom,
  calibrationSlabAssets,
  chunkAndEncode,
  compileResolved,
  estimate,
  realize,
} from "../../../src/compile";
import { loadPalettes } from "../../../src/palette";
import { decodeDetailed, encodeRaw, slabCodec, toHex } from "../../../src/slab";
import { handLevel, handPlan } from "./handResolved";

const cat = loadPalettes();
const marker = cat.palettes["generic"]?.roles["marker.alignment"]?.variants[0]?.asset ?? "";

function bigLevel(id: string, w: number, h: number, elevation = 0): ReturnType<typeof handLevel> {
  const rows = [
    "#".repeat(w + 2),
    ...Array.from(
      { length: h },
      (_, y) =>
        "#" + Array.from({ length: w }, (_, x) => ((x * 7 + y * 3) % 11 === 0 ? "2" : ".")).join("") + "#",
    ),
    "#".repeat(w + 2),
  ];
  const features = Array.from({ length: 40 }, (_, i) => ({
    id: `f${i}`,
    type: (["chest", "barrel", "crate", "statue"] as const)[i % 4] ?? "chest",
    at: [1 + ((i * 5) % w), 1 + ((i * 3) % h)] as [number, number],
    baseHeight: elevation + 0.5,
  }));
  return handLevel({ id, rows, elevation, features });
}

const box = (assets: SlabAsset[]): string => {
  const xs = assets.map((a) => a.sx),
    ys = assets.map((a) => a.sy),
    zs = assets.map((a) => a.sz);
  return JSON.stringify([
    Math.min(...xs),
    Math.min(...ys),
    Math.min(...zs),
    Math.max(...xs),
    Math.max(...ys),
    Math.max(...zs),
  ]);
};

describe("chunking and alignment markers", () => {
  it("a small single-level build is one chunk without markers (default multi-chunk)", () => {
    const b = compileResolved(handPlan([bigLevel("l1", 6, 5)]), cat, slabCodec, { createdAt: "t" });
    expect(b.chunks).toHaveLength(1);
    const c = b.chunks[0] as SlabChunk;
    expect(c.hasAlignmentMarkers).toBe(false);
    const d = decodeDetailed(c.slab);
    expect(d.assets.some((a) => a.uuid === marker)).toBe(false);
    // normalised by whole tiles only (keeps the grid): the west wall strip at x + 0.5 stays at 50
    expect(Math.min(...d.assets.map((a) => a.sx))).toBe(50);
    expect(Math.min(...d.assets.map((a) => a.sz))).toBe(50);
    expect(Math.min(...d.assets.map((a) => a.sy))).toBe(0);
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.instructions).toMatch(/Ctrl\+V/);
  });

  it('"always" adds the two markers even for one chunk', () => {
    const b = compileResolved(handPlan([bigLevel("l1", 6, 5)]), cat, slabCodec, { alignment: "always" });
    expect(decodeDetailed(b.chunks[0]?.slab ?? "").assets.filter((a) => a.uuid === marker)).toHaveLength(2);
  });

  it("splits by real gzip size into rectangular regions; every chunk has identical bounds and both markers", () => {
    const set = realize(handPlan([bigLevel("l1", 40, 30)]), cat);
    const b = chunkAndEncode(set, slabCodec, { fill: 0.05, createdAt: "t" }); // budget 1,536 bytes
    expect(b.chunks.length).toBeGreaterThan(2);
    const decoded = b.chunks.map((c) => decodeDetailed(c.slab).assets);
    const boxes = new Set(decoded.map(box));
    expect(boxes.size).toBe(1);
    for (const [i, c] of b.chunks.entries()) {
      expect(c.compressedBytes).toBeLessThanOrEqual(Math.floor(0.05 * 30720));
      expect(c.hasAlignmentMarkers).toBe(true);
      const ms = decoded[i]?.filter((a) => a.uuid === marker) ?? [];
      expect(ms).toHaveLength(2);
      expect(ms[0]).toMatchObject({ sx: 0, sy: 0, sz: 0 });
    }
    // all placements land in exactly one chunk, with one shared offset
    const content = decoded.flatMap((a) => a.filter((x) => x.uuid !== marker));
    expect(content).toHaveLength(set.stats.total);
    expect(b.stats.totalAssets).toBe(set.stats.total + 2 * b.chunks.length);
    expect(b.diagnostics.some((d) => d.code === "chunk_split")).toBe(true);
    // paste order is row-major; labels and ids are stable
    expect(b.chunks.map((c) => c.index)).toEqual(b.chunks.map((_, i) => i + 1));
    expect(b.chunks[0]?.offsetFromFirst).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("default: a small two-level build is ONE slab with both levels and no markers", () => {
    const b = compileResolved(handPlan([bigLevel("lo", 8, 6), bigLevel("up", 8, 6, 2.5)]), cat, slabCodec);
    expect(b.chunks).toHaveLength(1);
    const c = b.chunks[0] as SlabChunk;
    expect(c.levelIds).toEqual(["lo", "up"]);
    expect(c.label).toBe("Whole build");
    expect(c.hasAlignmentMarkers).toBe(false);
    expect(b.levelPlacement.map((l) => l.pasteOrder)).toEqual([1, 1]);
    expect(b.stats.perLevel.map((l) => l.chunks)).toEqual([1, 1]);
  });

  it("fewest: packs whole levels before cutting inside a level", () => {
    // three levels; budget fits two small levels together but not all three
    const lv = [bigLevel("a", 6, 4), bigLevel("b", 6, 4, 2.5), bigLevel("c", 6, 4, 5)];
    const size = (n: number): number =>
      compileResolved(handPlan(lv.slice(0, n)), cat, slabCodec, { alignment: "always" }).chunks[0]
        ?.compressedBytes ?? 0;
    const s2 = size(2);
    const s3 = size(3);
    expect(s3).toBeGreaterThan(s2);
    const fill = (s2 + s3) / 2 / 30720; // two levels fit, three do not
    const b = compileResolved(handPlan(lv), cat, slabCodec, { fill });
    expect(b.chunks.length).toBe(2);
    expect(b.chunks.map((c) => c.levelIds)).toEqual([["a", "b"], ["c"]]);
    expect(b.chunks.every((c) => c.hasAlignmentMarkers)).toBe(true);
    expect(new Set(b.chunks.map((c) => box(decodeDetailed(c.slab).assets))).size).toBe(1);
    expect(b.instructions).toMatch(/levels a, b/);
  });

  it("per-level grouping: two stacked levels → markers on both, same box including height (raised max marker)", () => {
    const b = compileResolved(handPlan([bigLevel("lo", 8, 6), bigLevel("up", 8, 6, 2.5)]), cat, slabCodec, {
      grouping: "per-level",
    });
    expect(b.chunks.map((c) => c.levelId)).toEqual(["lo", "up"]);
    const decoded = b.chunks.map((c) => decodeDetailed(c.slab).assets);
    expect(new Set(decoded.map(box)).size).toBe(1);
    const top = decoded[0]?.filter((a) => a.uuid === marker).map((a) => a.sy) ?? [];
    expect(top[0]).toBe(0);
    expect(top[1]).toBeGreaterThanOrEqual(250 + 50 + 200); // above the upper level's walls
    expect(b.levelPlacement).toEqual([
      { levelId: "lo", pasteOrder: 1, kind: "ground" },
      { levelId: "up", pasteOrder: 2, kind: "storeys-up", storeys: 1 },
    ]);
  });

  it("side_by_side lays levels at elevation 0, offset east by width + gap", () => {
    const b = compileResolved(handPlan([bigLevel("lo", 8, 6), bigLevel("up", 8, 6, 2.5)]), cat, slabCodec, {
      levelLayout: "side_by_side",
      sideBySideGap: 4,
      grouping: "per-level",
    });
    expect(b.levelPlacement[1]).toMatchObject({ kind: "side-by-side", offsetSq: 14 });
    const up = decodeDetailed(b.chunks[1]?.slab ?? "").assets.filter((a) => a.uuid !== marker);
    expect(Math.min(...up.map((a) => a.sy))).toBe(0);
  });

  it("is deterministic (same slab strings twice)", () => {
    const p = handPlan([bigLevel("l1", 20, 12)]);
    const a = compileResolved(p, cat, slabCodec, { fill: 0.1, createdAt: "t" });
    const b = compileResolved(p, cat, slabCodec, { fill: 0.1, createdAt: "t" });
    expect(a).toEqual(b);
  });

  it("refuses builds beyond the coordinate range", () => {
    const set = realize(handPlan([bigLevel("l1", 4, 4)]), cat);
    const far = {
      ...set,
      levels: set.levels.map((l) => ({
        ...l,
        placements: [
          ...l.placements,
          { ...(l.placements[0] as NonNullable<(typeof l.placements)[0]>), x: 5000 },
        ],
      })),
    };
    const b = chunkAndEncode(far, slabCodec);
    expect(b.chunks).toHaveLength(0);
    expect(b.diagnostics.some((d) => d.code === "coord_overflow" && d.severity === "error")).toBe(true);
  });

  it("estimate counts placements without gzip", () => {
    const e = estimate(handPlan([bigLevel("l1", 40, 30)]), cat);
    expect(e.totalAssets).toBeGreaterThan(300);
    expect(e.estimatedChunks).toBe(1);
  });

  it("estimate counts the whole build, not one chunk per level, under the default fewest grouping", () => {
    const plan = handPlan([bigLevel("l1", 20, 15), bigLevel("l2", 20, 15, 2.5)]);
    const fewest = estimate(plan, cat);
    expect(fewest.perLevel.map((l) => l.estimatedChunks)).toEqual([1, 1]);
    expect(fewest.estimatedChunks).toBe(1);
    expect(compileResolved(plan, cat, slabCodec).chunks).toHaveLength(1);
    expect(estimate(plan, cat, { grouping: "per-level" }).estimatedChunks).toBe(2);
  });
});

describe("calibration slab regenerated by the TypeScript pipeline", () => {
  it("decodes to the same layouts and instances as data/calibration-slab.txt (byte-exact raw payload)", () => {
    const file = fileURLToPath(new URL("../../../../../data/calibration-slab.txt", import.meta.url));
    const ref = decodeDetailed(readFileSync(file, "utf8"));
    const mine = calibrationSlabAssets(calibrationAssetsFrom(cat));
    expect(ref.assets).toHaveLength(130);
    expect(toHex(encodeRaw(mine))).toBe(toHex(ref.raw));
  });
});

describe("estimate is never more optimistic than compile (review finding)", () => {
  it("a build wider than the slab coordinate range: compile and estimate both report coord_overflow, 0 chunks", () => {
    const p = handPlan([
      bigLevel("l1", 6, 5),
      handLevel({ id: "far", x0: 3000, rows: ["#####", "#...#", "#####"] }),
    ]);
    const b = compileResolved(p, cat, slabCodec, { createdAt: "t" });
    expect(b.chunks).toHaveLength(0);
    expect(b.diagnostics.find((d) => d.code === "coord_overflow")?.severity).toBe("error");
    const e = estimate(p, cat);
    expect(e.estimatedChunks).toBe(0);
    expect(e.diagnostics[0]).toMatchObject({ code: "coord_overflow", severity: "error" });
    expect(e.diagnostics[0]?.hint).toMatch(/closer together/);
    // and a build that fits has no such error in either
    const ok = handPlan([bigLevel("l1", 6, 5)]);
    expect(estimate(ok, cat).diagnostics.some((d) => d.code === "coord_overflow")).toBe(false);
  });
});
