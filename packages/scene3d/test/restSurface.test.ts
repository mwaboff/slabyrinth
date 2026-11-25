import { describe, expect, it } from "vitest";
import {
  cuboid,
  readRestGrid,
  readRestSurface,
  readTopCover,
  type MeshData,
  type PieceGeom,
} from "../src/index";

/** Several meshes as one. */
function merge(...ms: MeshData[]): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of ms) {
    const base = positions.length / 3;
    positions.push(...m.positions);
    indices.push(...[...m.indices].map((i) => i + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A collider round the box from (x0, 0, z0) to (x1, h, z1). */
const geom = (x0: number, x1: number, z0: number, z1: number, h: number): PieceGeom => ({
  size: { x: x1 - x0, y: h, z: z1 - z0 },
  originAt: "center",
  boundsCenter: { x: (x0 + x1) / 2, y: h / 2, z: (z0 + z1) / 2 },
  lengthAxis: "x",
});

describe("readRestSurface: where a thing set on a piece rests", () => {
  it("a bench's work top, not the box top its raised back reaches", () => {
    // a 1.4 × 1 top at 0.75 with a 0.2-deep back rising to 1.1
    const bench = merge(
      cuboid({ x: -0.7, y: 0.65, z: -0.5 }, { x: 0.7, y: 0.75, z: 0.5 }),
      cuboid({ x: -0.7, y: 0.75, z: 0.3 }, { x: 0.7, y: 1.1, z: 0.5 }),
    );
    const r = readRestSurface(bench, geom(-0.7, 0.7, -0.5, 0.5, 1.1));
    expect(r?.rest).toBeCloseTo(0.75, 3);
    expect(r?.boxTop).toBe(1.1);
    expect(r?.share).toBeGreaterThan(0.5);
  });

  it("heights are above the collider's bottom, wherever the mesh's origin is", () => {
    const raised = cuboid({ x: -0.5, y: 2, z: -0.5 }, { x: 0.5, y: 2.6, z: 0.5 });
    const g: PieceGeom = { ...geom(-0.5, 0.5, -0.5, 0.5, 0.6), boundsCenter: { x: 0, y: 2.3, z: 0 } };
    expect(readRestSurface(raised, g)?.rest).toBeCloseTo(0.6, 3);
  });

  it("a top with no surface broad enough to set things on (a rounded lid) keeps the box top", () => {
    // ten steps of 0.1 each over a tenth of the width: no height holds 30 % of the top
    const steps = Array.from({ length: 10 }, (_, k) =>
      cuboid({ x: -0.5 + k * 0.1, y: 0, z: -0.5 }, { x: -0.4 + k * 0.1, y: 0.2 + k * 0.1, z: 0.5 }),
    );
    const r = readRestSurface(merge(...steps), geom(-0.5, 0.5, -0.5, 0.5, 1.1));
    expect(r).toEqual({ rest: 1.1, share: 0, boxTop: 1.1 });
  });

  it("nothing over the outline: no reading", () => {
    const aside = cuboid({ x: 3, y: 0, z: 3 }, { x: 4, y: 1, z: 4 });
    expect(readRestSurface(aside, geom(-0.5, 0.5, -0.5, 0.5, 1))).toBeNull();
  });
});

describe("readRestGrid: where things rest, part by part over a top", () => {
  it("the bench's work top holds things at its height; its raised back is higher, the edge between holds none", () => {
    const bench = merge(
      cuboid({ x: -0.7, y: 0.65, z: -0.5 }, { x: 0.7, y: 0.75, z: 0.5 }),
      cuboid({ x: -0.7, y: 0.75, z: 0.3 }, { x: 0.7, y: 1.1, z: 0.5 }),
    );
    const g = readRestGrid(bench, geom(-0.7, 0.7, -0.5, 0.5, 1.1));
    expect(g.nx * g.nz).toBe(g.heights.length);
    // the front row (min z) is the work top, the back row the raised back
    expect(g.heights[0]).toBeCloseTo(0.75, 2);
    expect(g.heights[(g.nz - 1) * g.nx]).toBeCloseTo(1.1, 2);
  });

  it("a cell over nothing, or over a slope, holds no thing", () => {
    const half = cuboid({ x: -0.5, y: 0, z: -0.5 }, { x: 0, y: 0.5, z: 0.5 });
    const g = readRestGrid(half, geom(-0.5, 0.5, -0.5, 0.5, 0.5));
    expect(g.heights[0]).toBeCloseTo(0.5, 2);
    expect(g.heights[g.nx - 1]).toBeNull();
    const steps = Array.from({ length: 10 }, (_, k) =>
      cuboid({ x: -0.5 + k * 0.1, y: 0, z: -0.5 }, { x: -0.4 + k * 0.1, y: 0.2 + k * 0.1, z: 0.5 }),
    );
    const s = readRestGrid(merge(...steps), geom(-0.5, 0.5, -0.5, 0.5, 1.1));
    // each cell spans a step and a half: no one height holds most of it
    expect(s.heights.filter((h) => h === null).length).toBeGreaterThan(0);
  });
});

describe("readTopCover: how a floor piece covers its outline", () => {
  it("a whole tile covers all of it", () => {
    const tile = cuboid({ x: 0, y: 0, z: 0 }, { x: 2, y: 0.5, z: 2 });
    expect(readTopCover(tile, geom(0, 2, 0, 2, 0.5))).toEqual({ share: 1, hole: 0 });
  });

  it("a tile with a corner cut away leaves one open patch the size of the cut", () => {
    // an L of three 1 x 1 quarters: the fourth quarter (x 1..2, z 1..2) is open
    const ell = merge(
      cuboid({ x: 0, y: 0, z: 0 }, { x: 2, y: 0.5, z: 1 }),
      cuboid({ x: 0, y: 0, z: 1 }, { x: 1, y: 0.5, z: 2 }),
    );
    const c = readTopCover(ell, geom(0, 2, 0, 2, 0.5));
    expect(c?.share).toBeGreaterThan(0.7);
    expect(c?.share).toBeLessThan(0.8);
    expect(c?.hole).toBeGreaterThan(0.85);
    expect(c?.hole).toBeLessThan(1.05);
  });

  it("small slots are open but each patch is small (a grate)", () => {
    const bars = Array.from({ length: 5 }, (_, k) =>
      cuboid({ x: k * 0.2, y: 0, z: 0 }, { x: k * 0.2 + 0.14, y: 0.25, z: 1 }),
    );
    const c = readTopCover(merge(...bars), geom(0, 1, 0, 1, 0.25));
    expect(c?.share).toBeLessThan(0.9);
    expect(c?.hole).toBeLessThan(0.1);
  });
});
