/**
 * The one set of box helpers every layer of scene3d uses, over core's own (compile/geometry.ts `emptyBox`, `growBox`),
 * and the one reading of a piece's paste layer.
 */
import { emptyBox, growBox } from "@slabyrinth/core";
import type { Box3, Scene } from "../types/index";

export { emptyBox, growBox };

export const copyBox = (b: Box3): Box3 => ({ min: { ...b.min }, max: { ...b.max } });

/** The box of some of a scene's pieces (by index; empty when none). */
export function boxOfPieces(scene: Scene, idx: Iterable<number>): Box3 {
  const b = emptyBox();
  for (const i of idx) {
    const a = scene.instances[i]?.aabb;
    if (a) growBox(b, a);
  }
  return b;
}

/** Do two boxes come within `d` of each other? */
export function boxesNear(a: Box3, b: Box3, d: number): boolean {
  return (
    a.max.x + d >= b.min.x &&
    b.max.x + d >= a.min.x &&
    a.max.y + d >= b.min.y &&
    b.max.y + d >= a.min.y &&
    a.max.z + d >= b.min.z &&
    b.max.z + d >= a.min.z
  );
}

/** The storey of a paste layer ("storey:<n>"), or null for any other layer. */
export function storeyOf(layer: string): number | null {
  if (!layer.startsWith("storey:")) return null;
  const n = Number(layer.slice("storey:".length));
  return Number.isFinite(n) ? n : null;
}
