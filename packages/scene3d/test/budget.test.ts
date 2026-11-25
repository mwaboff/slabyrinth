/**
 * Time and memory on a large synthetic scene (box stand-ins): 2 levels of 384 x 384 floor tiles plus a wall every
 * fourth cell, 368,640 instances. Measured on the dev machine (2026-11-24): scene build ~0.5 s and +175 MB of heap; a
 * 1024 x 768 overview ~0.35 s (4.4 M triangles set up). The limits are those with about 3-10x slack, so the test
 * catches a change that makes either far worse, not a slow CI runner.
 */
import { describe, expect, it } from "vitest";
import {
  assembleScene,
  boxMeshSource,
  overviewShot,
  renderScene,
  type PieceLookup,
  type ScenePiece,
} from "../src/index";

const SIDE = 384;
const FLOOR = "10000000-0000-4000-8000-000000000001";
const WALL = "10000000-0000-4000-8000-000000000002";

const lookup: PieceLookup = {
  info: (uuid) =>
    uuid === WALL
      ? {
          name: "wall",
          geom: {
            size: { x: 1, y: 2, z: 0.25 },
            originAt: "minCorner",
            boundsCenter: { x: 0.5, y: 1, z: 0.125 },
          },
          facts: { kind: "tile", groupTag: "wall", tags: [], name: "wall", height: 2 },
        }
      : {
          name: "floor",
          geom: {
            size: { x: 1, y: 0.1, z: 1 },
            originAt: "minCorner",
            boundsCenter: { x: 0.5, y: 0.05, z: 0.5 },
          },
          facts: { kind: "tile", groupTag: "floor", tags: [], name: "floor", height: 0.1 },
        },
};

function pieces(): ScenePiece[] {
  const out: ScenePiece[] = [];
  for (let level = 0; level < 2; level++)
    for (let z = 0; z < SIDE; z++)
      for (let x = 0; x < SIDE; x++) {
        const base = {
          rotDeg: 0,
          levelId: `l${level}`,
          layer: "site",
          elementId: null,
          cell: null,
          material: null,
          geom: null,
          name: null,
        };
        out.push({ ...base, uuid: FLOOR, stored: { x, y: level * 4, z }, role: "floor" });
        if (x % 4 === 0) out.push({ ...base, uuid: WALL, stored: { x, y: level * 4, z }, role: "wall" });
      }
  return out;
}

describe("budget on a large synthetic scene", () => {
  it("builds and renders within its limits", async () => {
    const list = pieces();
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const scene = await assembleScene(
      "build",
      list,
      [
        { id: "l0", name: "Ground" },
        { id: "l1", name: "Upper" },
      ],
      lookup,
      boxMeshSource(),
    );
    const buildMs = performance.now() - t0;
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
    const t1 = performance.now();
    const img = renderScene(scene, overviewShot(scene, { width: 1024, height: 768 }));
    const renderMs = performance.now() - t1;
    console.log(
      `synthetic scene: ${scene.instances.length} instances, build ${buildMs.toFixed(0)} ms, heap +${heapMb.toFixed(0)} MB, overview 1024x768 ${renderMs.toFixed(0)} ms, ${img.stats.trianglesDrawn} triangles`,
    );
    expect(scene.instances.length).toBe(list.length);
    expect(buildMs).toBeLessThan(3000);
    expect(heapMb).toBeLessThan(600);
    expect(renderMs).toBeLessThan(5000);
    expect(img.stats.instancesDrawn).toBe(scene.instances.length);
  }, 60_000);
});
