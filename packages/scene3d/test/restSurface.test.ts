import { describe, expect, it } from "vitest";
import { cuboid, readRestSurface, type MeshData, type PieceGeom } from "../src/index";

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
