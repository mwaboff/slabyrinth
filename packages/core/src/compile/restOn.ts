/**
 * Where a thing set on a placed piece stands, read from the piece's measured rest grid (palette/restGrid.ts) at the
 * thing's point, turned into the piece's own frame with its final turn (util/turn.ts). Realize settles things on it
 * (compile/realize/settle.ts) and verify judges their support by it (compile/verify/props.ts), so both read one rule.
 */
import type { Box3, PaletteVariant } from "../contracts/compiler";
import { restGridOf, restSpot } from "../palette/restGrid";
import { restTop } from "../palette/restSurface";
import { rotateXZ } from "../util/turn";

/** A placed piece a thing may be set on: its asset, collider, world box and turn (game degrees, rotSense applied). */
export interface PlacedSupport {
  readonly asset: string;
  readonly geom: PaletteVariant["geom"];
  readonly box: Box3;
  readonly cw: number;
}

/** A point on a support's top that holds a thing (world tiles), and how far it is from the point asked about. */
export interface WorldRestSpot {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly moved: number;
}

/**
 * Where a thing at world (x, z) set on `q` rests by its measured grid: the part of the top under the point when it holds
 * things, else the nearest part that does. Undefined when the piece was never measured or no part of its top holds.
 */
export function restSpotAt(q: PlacedSupport, x: number, z: number): WorldRestSpot | undefined {
  const grid = restGridOf(q.asset);
  if (!grid) return undefined;
  // the collider's centre is its world box's centre at every turn (the box is round the turned outline)
  const cx = (q.box.min.x + q.box.max.x) / 2;
  const cz = (q.box.min.z + q.box.max.z) / 2;
  const local = rotateXZ(x - cx, z - cz, -q.cw);
  const s = restSpot(grid, q.geom.size.x, q.geom.size.z, local.x, local.z);
  if (!s) return undefined;
  const w = rotateXZ(s.lx, s.lz, q.cw);
  return { x: cx + w.x, z: cz + w.z, y: q.box.min.y + s.rest, moved: s.moved };
}

/**
 * The top a thing at world (x, z) stands on when set on `q`: with `grids` (generator 6, `unevenTops`) the measured
 * grid's height there when that part holds things, else the nearest part's that does (the thing lies across it); a
 * piece with no grid, or before generator 6, its one rest height (`measured`: `restSurfaces`) or its box top
 * (palette/restSurface.ts restTop).
 */
export function surfaceTopAt(
  q: PlacedSupport,
  x: number,
  z: number,
  measured: boolean,
  grids: boolean,
): number {
  if (grids) {
    // over a part that does not hold things, the thing lies across the nearest part that does
    const s = restSpotAt(q, x, z);
    if (s) return s.y;
  }
  return restTop(q.asset, q.box, measured);
}
