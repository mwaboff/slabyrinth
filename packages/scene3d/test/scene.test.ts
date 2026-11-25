import { createHash } from "node:crypto";
import type { PlacementRole } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import {
  COLOUR_CLASSES,
  boxMeshSource,
  colourClass,
  encodePng,
  levelShots,
  overviewShot,
  pieceLookup,
  renderScene,
  sceneFromSlab,
  topShot,
  viewBasis,
  type ColourClass,
  type MeshSource,
  type Scene,
  type ShotSpec,
} from "../src/index";
import { fixtureScene } from "./helpers";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const SIZE = { width: 256, height: 192 };

describe("colour classes", () => {
  const roles: Record<PlacementRole, ColourClass> = {
    floor: "floor",
    fill: "floor",
    wall: "wall",
    wall_post: "wall",
    opening: "opening",
    link: "stairs",
    feature: "prop",
    ledge: "floor",
    marker: "marker",
  };
  it.each(Object.entries(roles))("role %s is %s (built floor, no facts)", (role, cls) => {
    expect(
      colourClass({ role: role as PlacementRole, layer: "site", material: "flagstone", facts: null }),
    ).toBe(cls);
  });

  it("reads layer, material and catalog facts before the role's default", () => {
    const facts = (groupTag: string, tags: string[], name: string, height = 1) => ({
      kind: "prop" as const,
      groupTag,
      tags,
      name,
      height,
    });
    expect(colourClass({ role: "wall", layer: "roof", material: null, facts: null })).toBe("roof");
    expect(colourClass({ role: "floor", layer: "site", material: "grass", facts: null })).toBe("terrain");
    expect(colourClass({ role: "floor", layer: "site", material: "water_deep", facts: null })).toBe("water");
    expect(
      colourClass({ role: "feature", layer: "site", material: null, facts: facts("", [], "Wall Torch") }),
    ).toBe("light");
    expect(
      colourClass({ role: "feature", layer: "site", material: null, facts: facts("tree", [], "Oak") }),
    ).toBe("plant");
    expect(
      colourClass({ role: "feature", layer: "site", material: null, facts: facts("decor", [], "Statue", 3) }),
    ).toBe("tall_prop");
    // a bare slab piece with only catalog facts, and one nobody knows
    expect(
      colourClass({
        role: null,
        layer: "site",
        material: null,
        facts: { kind: "tile", groupTag: "Roof", tags: [], name: "x", height: 1 },
      }),
    ).toBe("roof");
    expect(colourClass({ role: null, layer: "site", material: null, facts: null })).toBe("unknown");
  });

  it("has a colour and a label for every class", () => {
    for (const c of Object.values(COLOUR_CLASSES)) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.rgb).toHaveLength(3);
    }
  });
});

/** Every corner of every drawn instance's box falls inside the picture. */
function framesAll(scene: Scene, shot: ShotSpec): boolean {
  const v = viewBasis(shot.camera);
  const s = shot.height / 2 / shot.camera.halfHeight;
  for (const i of scene.instances) {
    if (shot.cutaway.maxLevelIndex !== undefined && i.levelIndex > shot.cutaway.maxLevelIndex) continue;
    if (shot.cutaway.hideLayers?.includes(i.layer)) continue;
    for (let c = 0; c < 8; c++) {
      const p = {
        x: (c & 1 ? i.aabb.max.x : i.aabb.min.x) - v.eye.x,
        y: (c & 2 ? i.aabb.max.y : i.aabb.min.y) - v.eye.y,
        z: (c & 4 ? i.aabb.max.z : i.aabb.min.z) - v.eye.z,
      };
      const x = shot.width / 2 + (p.x * v.right.x + p.y * v.right.y + p.z * v.right.z) * s;
      const y = shot.height / 2 - (p.x * v.up.x + p.y * v.up.y + p.z * v.up.z) * s;
      if (x < -0.01 || y < -0.01 || x > shot.width + 0.01 || y > shot.height + 0.01) return false;
    }
  }
  return true;
}

describe("box scenes of fixtures", () => {
  it("places every placement, as a box, with the fallback report saying why", async () => {
    const scene = await fixtureScene("two-rooms-door");
    expect(scene.instances.length).toBeGreaterThan(50);
    expect(scene.instances.every((i) => i.stand === "box")).toBe(true);
    const counted = scene.fallbacks.reduce((n, f) => n + f.count, 0);
    expect(counted).toBe(scene.instances.length);
    expect(scene.fallbacks.every((f) => f.reason === "boxes-requested")).toBe(true);
  });

  it("frames the whole map in the overview and top shots, and each level in its cutaway", async () => {
    const scene = await fixtureScene("multi-level-stairs");
    expect(scene.levels.length).toBe(3);
    expect(framesAll(scene, overviewShot(scene, SIZE))).toBe(true);
    expect(framesAll(scene, topShot(scene, SIZE))).toBe(true);
    const levels = levelShots(scene, SIZE);
    expect(levels).toHaveLength(3);
    // a level shot frames its own level (the ones below may run past the edge)
    for (const shot of levels) {
      const own = { ...scene, instances: scene.instances.filter((i) => i.levelId === shot.targets[0]) };
      expect(framesAll(own, shot)).toBe(true);
    }
  });

  it("renders the same bytes twice, and pins the PNG of three fixtures", async () => {
    const hashes: Record<string, string> = {};
    for (const name of ["two-rooms-door", "multi-level-stairs", "market-street-v3"]) {
      const scene = await fixtureScene(name);
      const shot = overviewShot(scene, SIZE);
      const a = encodePng(renderScene(scene, shot));
      const b = encodePng(renderScene(await fixtureScene(name), shot));
      expect(sha(a)).toBe(sha(b));
      hashes[name] = sha(a);
    }
    expect(hashes).toMatchInlineSnapshot(`
      {
        "market-street-v3": "b61e9d05a01dbd7d",
        "multi-level-stairs": "3db33418ed922cd9",
        "two-rooms-door": "184771ae3d54c522",
      }
    `);
  });

  it("draws perspective shots too", async () => {
    const scene = await fixtureScene("two-rooms-door");
    const img = renderScene(scene, overviewShot(scene, { ...SIZE, projection: "persp" }));
    const drawn = img.idAt.filter((v) => v >= 0).length;
    expect(drawn).toBeGreaterThan(SIZE.width * SIZE.height * 0.1);
    expect(img.stats.instancesDrawn).toBe(scene.instances.length);
  });
});

describe("slab scenes", () => {
  it("reports pieces with no known size and still stands a small box for them", async () => {
    const unknown = "00000000-0000-4000-8000-000000000001";
    const scene = await sceneFromSlab(
      [
        { uuid: unknown, sx: 0, sy: 0, sz: 0, rot: 0 },
        { uuid: unknown, sx: 100, sy: 0, sz: 0, rot: 6 },
      ],
      pieceLookup({}, null),
      boxMeshSource(),
    );
    expect(scene.instances).toHaveLength(2);
    expect(scene.fallbacks).toEqual([{ uuid: unknown, name: unknown, reason: "no-geometry", count: 2 }]);
    expect(scene.instances[0]?.colourClass).toBe("unknown");
  });

  it("places a game mesh by the tile rule: turned, then moved to the stored min corner", async () => {
    const tile = "00000000-0000-4000-8000-000000000002";
    // a 2x1 tile whose mesh fills its collider: x 0..2, z 0..1
    const source: MeshSource = {
      label: "test",
      load: () =>
        Promise.resolve(
          new Map([
            [
              tile,
              {
                kind: "mesh" as const,
                mesh: {
                  positions: Float32Array.from([0, 0, 0, 2, 0, 0, 2, 0, 1, 0, 0, 1]),
                  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
                },
                geom: {
                  size: { x: 2, y: 0.1, z: 1 },
                  originAt: "minCorner" as const,
                  boundsCenter: { x: 1, y: 0.05, z: 0.5 },
                },
              },
            ],
          ]),
        ),
    };
    const scene = await sceneFromSlab(
      [{ uuid: tile, sx: 500, sy: 0, sz: 300, rot: 6 }],
      pieceLookup({}, null),
      source,
    );
    const box = scene.instances[0]?.aabb;
    // turned 90° clockwise it covers 1 x 2, from its stored corner (5, 3)
    expect(box?.min.x).toBeCloseTo(5);
    expect(box?.min.z).toBeCloseTo(3);
    expect(box?.max.x).toBeCloseTo(6);
    expect(box?.max.z).toBeCloseTo(5);
    expect(scene.fallbacks).toEqual([]);
  });
});
