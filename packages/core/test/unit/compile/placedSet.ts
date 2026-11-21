/**
 * Test helpers for changing a realized set by hand: every placement a test adds or moves keeps its entry in the set's
 * `placed` map (name, geometry, world box), so verify and chunking see it as they see a realized one.
 */
import type { Box3, Placement, PlacementSet } from "../../../src/contracts/compiler";

type Known = Pick<PlacementSet, "placed">;

const shifted = (b: Box3, dx: number, dy: number, dz: number): Box3 => ({
  min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
  max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
});

/** Copy of a placement moved by (dx, dy, dz), with its name, geometry and moved box (not added to a level). */
export function clonePlaced(
  set: Known,
  p: Placement,
  dx = 0,
  dy = 0,
  dz = 0,
  patch: Partial<Placement> = {},
): Placement {
  const q: Placement = { ...p, source: { ...p.source }, x: p.x + dx, y: p.y + dy, z: p.z + dz, ...patch };
  const known = set.placed?.get(p);
  if (known) set.placed?.set(q, { ...known, box: shifted(known.box, dx, dy, dz) });
  return q;
}

/** Moves a placement by (dx, dy, dz), with its box. */
export function movePlaced(set: Known, p: Placement, dx = 0, dy = 0, dz = 0): void {
  p.x += dx;
  p.y += dy;
  p.z += dz;
  const known = set.placed?.get(p);
  if (known) known.box = shifted(known.box, dx, dy, dz);
}

/** Gives a placement that already has an entry another world box. */
export function setPlacedBox(set: Known, p: Placement, box: Box3): void {
  const known = set.placed?.get(p);
  if (!known) throw new Error("setPlacedBox: the set does not know this placement");
  known.box = box;
}
