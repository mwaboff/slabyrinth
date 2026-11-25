/**
 * The scene turns a piece as realize and the slab do (core `worldTurn`: the stored rotation with the calibration's
 * rotSense): under either rotation sense, every piece's box in the scene of a build is the box realize placed it with,
 * and the same pieces through the slab encoder and decoder land in the same place.
 */
import {
  buildPaletteCatalog,
  decode,
  degreesToRot,
  encode,
  loadOrientation,
  loadPalettes,
  placementBox,
  realize,
  resolvePlan,
  storedPosition,
  toScaled,
  worldTurn,
  type Box3,
} from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import { boxMeshSource, pieceLookup, sceneFromBuild, sceneFromSlab } from "../src/index";
import { placedBox, placementOffset } from "../src/scene/place";
import type { PieceGeom } from "../src/types/index";
import { fixturePlan } from "./helpers";

const far = (a: Box3, b: Box3): number =>
  Math.max(
    ...(["x", "y", "z"] as const).flatMap((k) => [
      Math.abs(a.min[k] - b.min[k]),
      Math.abs(a.max[k] - b.max[k]),
    ]),
  );

describe("a turned tile is drawn by core's one storage rule (scene/place.ts placementOffset)", () => {
  // square and non-square footprints, with the collider's centre off the piece's origin as tiles have it
  const geoms: PieceGeom[] = [
    { size: { x: 1, y: 0.5, z: 1 }, boundsCenter: { x: 0.5, y: 0.25, z: 0.5 }, originAt: "minCorner" },
    { size: { x: 2, y: 0.25, z: 1 }, boundsCenter: { x: 1, y: 0.125, z: 0.5 }, originAt: "minCorner" },
    { size: { x: 3, y: 1, z: 0.5 }, boundsCenter: { x: 1.4, y: 0.5, z: 0.3 }, originAt: "minCorner" },
  ];
  it.each(geoms.map((g) => [`${String(g.size.x)}x${String(g.size.z)}`, g] as const))(
    "%s: at all 24 turns both senses, the drawn collider is core's placementBox, and storedPosition stores it back",
    (_, geom) => {
      const stored = { x: 7.25, y: 2, z: 3.5 };
      const local: Box3 = {
        min: {
          x: geom.boundsCenter.x - geom.size.x / 2,
          y: geom.boundsCenter.y - geom.size.y / 2,
          z: geom.boundsCenter.z - geom.size.z / 2,
        },
        max: {
          x: geom.boundsCenter.x + geom.size.x / 2,
          y: geom.boundsCenter.y + geom.size.y / 2,
          z: geom.boundsCenter.z + geom.size.z / 2,
        },
      };
      for (let step = 0; step < 24; step++)
        for (const sense of [1, -1]) {
          const deg = step * 15 * sense;
          const drawn = placedBox(local, deg, placementOffset(geom, stored, deg));
          const core = placementBox(geom, stored.x, stored.y, stored.z, deg);
          expect(far(drawn, core), `turn ${String(deg)}`).toBeLessThan(1e-9);
          const back = storedPosition(
            geom,
            (core.min.x + core.max.x) / 2,
            core.min.y,
            (core.min.z + core.max.z) / 2,
            deg,
          );
          expect(Math.hypot(back.x - stored.x, back.z - stored.z), `turn ${String(deg)}`).toBeLessThan(1e-9);
        }
    },
  );
});

describe("rotation sense", () => {
  it.each([1, -1] as const)(
    "draws every piece where realize and the slab put it (rotSense %i)",
    async (sense) => {
      const orientation = { ...loadOrientation().orientation, rotSense: sense };
      const palettes = buildPaletteCatalog([], null);
      const resolved = resolvePlan(fixturePlan("inn-interior-v1"), palettes);
      const set = realize(resolved, palettes, { orientation });
      const lookup = pieceLookup(loadPalettes().palettes, null);
      const scene = await sceneFromBuild(resolved, set, lookup, boxMeshSource(), { orientation });
      const placements = set.levels.flatMap((l) => l.placements);
      expect(scene.instances).toHaveLength(placements.length);
      // the build: every scene box is realize's own box of the placement
      let senseMatters = 0;
      placements.forEach((p, i) => {
        const placed = set.placed.get(p);
        const inst = scene.instances[i];
        if (!placed || !inst) throw new Error("placement without a scene piece");
        // (to the float32 of a mesh's vertices)
        expect(far(inst.aabb, placed.box), `${placed.name} at rot ${String(p.rot)}`).toBeLessThan(1e-3);
        // (the other sense would put this piece elsewhere: the test can tell the senses apart)
        if (far(placementBox(placed.geom, p.x, p.y, p.z, -worldTurn(p.rot, orientation)), placed.box) > 0.01)
          senseMatters++;
      });
      expect(senseMatters).toBeGreaterThan(0);
      // the slab: the same pieces encoded and decoded land on the build's boxes (to the slab's 0.01 tile)
      const assets = placements.map((p) => ({
        uuid: p.asset,
        sx: toScaled(p.x - scene.bounds.min.x + 1),
        sy: toScaled(p.y - scene.bounds.min.y + 1),
        sz: toScaled(p.z - scene.bounds.min.z + 1),
        rot: degreesToRot(p.rot),
      }));
      const slab = await sceneFromSlab(decode(encode(assets).slab).assets, lookup, boxMeshSource(), {
        orientation,
      });
      const shift = (b: Box3): Box3 => ({
        min: {
          x: b.min.x - scene.bounds.min.x + 1,
          y: b.min.y - scene.bounds.min.y + 1,
          z: b.min.z - scene.bounds.min.z + 1,
        },
        max: {
          x: b.max.x - scene.bounds.min.x + 1,
          y: b.max.y - scene.bounds.min.y + 1,
          z: b.max.z - scene.bounds.min.z + 1,
        },
      });
      const left = slab.instances.slice();
      for (const inst of scene.instances) {
        const want = shift(inst.aabb);
        const k = left.findIndex((s) => s.uuid === inst.uuid && far(s.aabb, want) < 0.02);
        expect(k, `${inst.name}: no slab piece in its place`).toBeGreaterThanOrEqual(0);
        left.splice(k, 1);
      }
    },
  );
});
