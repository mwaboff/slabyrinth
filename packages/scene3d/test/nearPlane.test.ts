/**
 * The software raster cuts a triangle at the near plane instead of dropping it: a wall that runs past the camera (an
 * interior shot standing beside it) is drawn up to the edge of the picture, not left as a hole.
 */
import { describe, expect, it } from "vitest";
import { cuboid, renderScene, type Scene } from "../src/index";

/** One piece: a wall 0.2 thick along z from -10 to 10, at x 1..1.2, 3 tall. */
function wallScene(): Scene {
  const aabb = { min: { x: 1, y: 0, z: -10 }, max: { x: 1.2, y: 3, z: 10 } };
  return {
    origin: "build",
    instances: [
      {
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "wall",
        meshKey: "w",
        rotDeg: 0,
        at: { x: 0, y: 0, z: 0 },
        aabb,
        colourClass: "wall",
        colour: [200, 180, 160],
        levelId: "L0",
        levelIndex: 0,
        layer: "site",
        role: "wall",
        elementId: "w",
        cell: null,
        stand: "mesh",
      },
    ],
    meshes: new Map([["w", cuboid(aabb.min, aabb.max)]]),
    levels: [{ id: "L0", name: "Ground", index: 0, bounds: aabb }],
    bounds: aabb,
    fallbacks: [],
    meshSource: "test",
  };
}

describe("near plane", () => {
  it("draws a wall that crosses the near plane up to the picture's edge", () => {
    // the camera stands beside the wall's middle, looking along it: every face of the wall reaches behind it
    const img = renderScene(wallScene(), {
      camera: {
        projection: "persp",
        eye: { x: 0.5, y: 1.5, z: 0 },
        target: { x: 0.9, y: 1.5, z: 5 },
        fovDeg: 70,
        halfHeight: 1,
      },
      cutaway: {},
      width: 160,
      height: 120,
    });
    // the wall fills the right side of the picture, to its right edge (it passes beside the camera)
    let right = 0;
    for (let y = 0; y < 120; y++) if ((img.idAt[y * 160 + 159] ?? -1) === 0) right++;
    expect(right).toBeGreaterThan(60);
    expect(img.stats.trianglesDrawn).toBeGreaterThan(0);
  });
});
