/**
 * Placement of a piece's mesh in the world, by the game's rule (docs/talespire-slab-format.md §2.2; proved by the 3D
 * spike against in-game screenshots): turn the mesh `rot` degrees clockwise seen from above; a tile's stored position
 * is the min x/z corner of its turned collider box, a prop's is its origin. The y of the mesh is kept as it is.
 */
import { placementBox, rotateXZ } from "@slabyrinth/core";
import { cuboid } from "../geom/mesh";
import type { Box3, MeshData, PieceGeom, Vec3 } from "../types/index";

/**
 * The translation that, after turning the mesh by `rotDeg`, puts it where the game puts a piece stored at `stored`.
 * A tile's turned collider stands where core's one rule puts it (compile/geometry.ts placementBox, the box realize and
 * verify read): its centre is the box's, so the mesh moves by that centre less its own turned collider centre.
 */
export function placementOffset(geom: PieceGeom, stored: Vec3, rotDeg: number): Vec3 {
  if (geom.originAt !== "minCorner") return { x: stored.x, y: stored.y, z: stored.z };
  const box = placementBox(geom, stored.x, stored.y, stored.z, rotDeg);
  const c = rotateXZ(geom.boundsCenter.x, geom.boundsCenter.z, rotDeg);
  return { x: (box.min.x + box.max.x) / 2 - c.x, y: stored.y, z: (box.min.z + box.max.z) / 2 - c.z };
}

/** A box of the collider (12 triangles), in the piece's own frame: the stand-in when its mesh is not available. */
export function boxMesh(geom: PieceGeom): MeshData {
  const c = geom.boundsCenter;
  const h = { x: geom.size.x / 2, y: geom.size.y / 2, z: geom.size.z / 2 };
  return cuboid({ x: c.x - h.x, y: c.y - h.y, z: c.z - h.z }, { x: c.x + h.x, y: c.y + h.y, z: c.z + h.z });
}

/** The world box of a local box turned `rotDeg` and moved by `at`. */
export function placedBox(local: Box3, rotDeg: number, at: Vec3): Box3 {
  const out: Box3 = {
    min: { x: Infinity, y: local.min.y + at.y, z: Infinity },
    max: { x: -Infinity, y: local.max.y + at.y, z: -Infinity },
  };
  for (const x of [local.min.x, local.max.x])
    for (const z of [local.min.z, local.max.z]) {
      const r = rotateXZ(x, z, rotDeg);
      out.min.x = Math.min(out.min.x, r.x + at.x);
      out.max.x = Math.max(out.max.x, r.x + at.x);
      out.min.z = Math.min(out.min.z, r.z + at.z);
      out.max.z = Math.max(out.max.z, r.z + at.z);
    }
  return out;
}
