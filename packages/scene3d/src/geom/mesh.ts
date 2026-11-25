/** Small mesh helpers every layer shares: a cuboid and the box round a mesh. */
import type { Box3, MeshData, Vec3 } from "../types/index";
import { emptyBox } from "./box";

/** A cuboid's 12 triangles (faces -x, +x, -y, +y, -z, +z, outward) over its 8 corners (bit 1 x, 2 y, 4 z = max). */
const CUBOID_INDICES: readonly number[] = [
  0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6,
];

/** A cuboid between two corners. */
export function cuboid(min: Vec3, max: Vec3): MeshData {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max.x : min.x;
    positions[i * 3 + 1] = i & 2 ? max.y : min.y;
    positions[i * 3 + 2] = i & 4 ? max.z : min.z;
  }
  return { positions, indices: Uint32Array.from(CUBOID_INDICES) };
}

/** The box of a mesh's vertices in its own frame. */
export function meshBox(m: MeshData): Box3 {
  const box = emptyBox();
  const { min, max } = box;
  const p = m.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i] ?? 0;
    const y = p[i + 1] ?? 0;
    const z = p[i + 2] ?? 0;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return box;
}
