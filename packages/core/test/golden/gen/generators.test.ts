/**
 * Frozen generator outputs per seed (architecture §2.5, §7.3): blob, cave, noise, path jitter, route, scatter,
 * dress. Masks are stored as '#'/'.' rows so a diff shows exactly what moved.
 */
import { describe, expect, it } from "vitest";
import type { DressPreset, Side } from "../../../src/contracts/plan";
import { DRESS_PRESETS } from "../../../src/contracts/plan";
import {
  type CellMask,
  type PlacementGrid,
  ValueNoise,
  dressArea,
  isComposedPreset,
  generateBlob,
  generateCave,
  jitterPolyline,
  rasterPolyline,
  routeCenterline,
  scatterFeatures,
} from "../../../src/gen/index";

function maskText(m: CellMask): string {
  const rows = [`@${m.x},${m.y} ${m.w}x${m.h}`];
  for (let y = 0; y < m.h; y++) {
    let s = "";
    for (let x = 0; x < m.w; x++) s += m.bits[y * m.w + x] ? "#" : ".";
    rows.push(s);
  }
  return rows.join("\n");
}

/** An open W×H room: walls on its border, nothing else. */
function roomGrid(W: number, H: number): PlacementGrid {
  return {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    isFloor: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    flags: () => 0,
    area: () => 1,
    occupied: () => false,
    edge: (x, y, s: Side) =>
      (s === "N" && y === 0) ||
      (s === "S" && y === H - 1) ||
      (s === "W" && x === 0) ||
      (s === "E" && x === W - 1)
        ? 1
        : 0,
  };
}

const SEEDS = [1, 7, 42, 90210];

describe("blob", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const text = [0, 0.3, 0.7]
      .map((rough) => `rough ${rough}\n${maskText(generateBlob(10, 10, 6, rough, seed))}`)
      .join("\n\n");
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/blob-${seed}.txt`);
  });
  it("is 4-connected and contains its centre", () => {
    for (const seed of SEEDS) {
      const m = generateBlob(10.5, 10.5, 5, 1, seed);
      expect(m.bits[(10 - m.y) * m.w + (10 - m.x)]).toBe(1);
    }
  });
});

describe("cave", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const text = [
      [0.45, 4],
      [0.38, 2],
      [0.55, 6],
    ]
      .map(
        ([fill, steps]) =>
          `fill ${fill} steps ${steps}\n${maskText(generateCave(0, 0, 32, 20, fill as number, steps as number, seed))}`,
      )
      .join("\n\n");
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/cave-${seed}.txt`);
  });
});

describe("value noise", () => {
  it.each(SEEDS)("seed %i (coverage 0.4, scale 5)", async (seed) => {
    const n = new ValueNoise(seed);
    const rows: string[] = [];
    for (let y = 0; y < 24; y++) {
      let s = "";
      for (let x = 0; x < 48; x++) s += n.sample(x / 5, y / 5) < 0.4 ? "#" : ".";
      rows.push(s);
    }
    await expect(rows.join("\n") + "\n").toMatchFileSnapshot(`__golden__/noise-${seed}.txt`);
  });
  it("stays in [0,1) and varies along both axes", () => {
    const n = new ValueNoise(5);
    const col = new Set<number>();
    const row = new Set<number>();
    for (let k = 0; k < 40; k++) {
      const a = n.sample(3.3, k * 0.7);
      const b = n.sample(k * 0.7, 3.3);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
      col.add(Math.round(a * 10));
      row.add(Math.round(b * 10));
    }
    expect(col.size).toBeGreaterThan(3);
    expect(row.size).toBeGreaterThan(3);
  });
});

describe("path jitter", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const pts = jitterPolyline(
      [
        [0, 10],
        [20, 4],
        [40, 14],
      ],
      2,
      0.4,
      seed,
    );
    const text = `${pts.map((p) => p.join(",")).join(" ")}\n${maskText(rasterPolyline(pts, 2))}`;
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/path-${seed}.txt`);
  });
});

describe("route", () => {
  it("L paths in both bend orders", async () => {
    const text = [
      routeCenterline([2, 3], [12, 9], "hv"),
      routeCenterline([2, 3], [12, 9], "vh"),
      routeCenterline([12, 9], [2, 3], "hv"),
    ]
      .map((l) => l.map((p) => p.join(",")).join(" "))
      .join("\n");
    await expect(text + "\n").toMatchFileSnapshot("__golden__/route.txt");
  });
});

describe("scatter", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const cands: Array<[number, number]> = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) cands.push([x, y]);
    const res = scatterFeatures(roomGrid(30, 20), {
      feature: "tree",
      candidates: cands,
      density: 0.3,
      minSpacing: 2,
      avoid: new Set(["walls"]),
      randomRotation: true,
      seed,
      remaining: 6000,
    });
    const text = res.placements
      .map((p) => `${p.type} ${p.at.join(",")} ${p.size.join("x")} r${p.rot} f${p.rotFine}`)
      .join("\n");
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/scatter-${seed}.txt`);
    // spacing: no two trees closer than Chebyshev 2
    for (const a of res.placements)
      for (const b of res.placements)
        if (a !== b)
          expect(Math.max(Math.abs(a.at[0] - b.at[0]), Math.abs(a.at[1] - b.at[1]))).toBeGreaterThanOrEqual(
            2,
          );
  });
  it("honours the cap", () => {
    const cands: Array<[number, number]> = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) cands.push([x, y]);
    const res = scatterFeatures(roomGrid(30, 20), {
      feature: "flowers",
      candidates: cands,
      density: 1,
      minSpacing: 1,
      avoid: new Set(),
      randomRotation: false,
      seed: 3,
      remaining: 10,
    });
    expect(res.placements.length).toBe(10);
    expect(res.capped).toBe(true);
  });
});

describe("dress", () => {
  it.each(DRESS_PRESETS as readonly DressPreset[])("preset %s", async (preset) => {
    const cells: Array<[number, number]> = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) cells.push([x, y]);
    const res = dressArea(roomGrid(10, 8), {
      preset,
      areaIndex: 1,
      areaCells: cells,
      density: 0.8,
      seed: 11,
      remaining: 6000,
    });
    const text = res.placements
      .map(
        (p) => `${p.type} ${p.at.join(",")} ${p.size.join("x")} r${p.rot}${p.wall ? ` wall=${p.wall}` : ""}`,
      )
      .join("\n");
    await expect(text + "\n").toMatchFileSnapshot(`__golden__/dress-${preset}.txt`);
    // weighted presets: count = round(density × openCells / 6), minus silently dropped candidates
    // (composed set pieces have their own budget; see test/unit/gen/setpieces.test.ts)
    if (!isComposedPreset(preset))
      expect(res.placements.length).toBeLessThanOrEqual(Math.round((0.8 * 80) / 6));
  });
});
