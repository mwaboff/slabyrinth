/**
 * Where a thing set on a placed piece stands, read from the piece's measured rest grid (palette/restGrid.ts) at the
 * thing's point, turned into the piece's own frame with its final turn (util/turn.ts). Realize settles things on it
 * (compile/realize/settle.ts) and verify judges their support by it (compile/verify/props.ts), so both read one rule:
 * a thing stands on a part of the top that holds things under its centre, or one its own outline reaches.
 */
import type { Box3, PaletteVariant } from "../contracts/compiler";
import { gridCellAt, hangGridOf, restGridOf, restSpot } from "../palette/restGrid";
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
  const grid = restGridOf(q.asset, q.geom);
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

/** A thing's outline across the floor (world x and z). */
export interface Outline {
  readonly min: { readonly x: number; readonly z: number };
  readonly max: { readonly x: number; readonly z: number };
}

/**
 * The top a thing with outline `thing` (its centre the point asked about) stands on when set on `q`: with `grids`
 * (generator 6, `unevenTops`) the measured grid's height under its centre when that part holds things, else the
 * nearest part's that does when the thing's outline reaches it (the thing lies across it), else undefined (no part
 * the thing reaches holds it: it is not set on `q`); a piece with no grid, or before generator 6, its one rest height
 * (`measured`: `restSurfaces`) or its box top (palette/restSurface.ts restTop).
 */
export function surfaceTopAt(
  q: PlacedSupport,
  thing: Outline,
  measured: boolean,
  grids: boolean,
): number | undefined {
  if (grids) {
    const s = restSpotAt(q, (thing.min.x + thing.max.x) / 2, (thing.min.z + thing.max.z) / 2);
    if (s) return s.moved === 0 || reaches(thing, s) ? s.y : undefined;
  }
  return restTop(q.asset, q.geom, q.box, measured);
}

/** Does a thing's outline reach world point `p` (with a hair of slack for rounding)? */
export function reaches(thing: Outline, p: { readonly x: number; readonly z: number }): boolean {
  const e = 1e-3;
  return p.x >= thing.min.x - e && p.x <= thing.max.x + e && p.z >= thing.min.z - e && p.z <= thing.max.z + e;
}

/**
 * The underside of a cover piece `q` over world (x, z): its measured underside grid's lowest point over the cell the
 * point is under (palette/hangGrids.ts: a sloping cloth's low side there, a thick canopy's underside, not its top),
 * turned into the piece's frame with its turn; undefined when the piece was never measured from below, the point is past
 * its outline, or the cover does not reach over that cell.
 */
export function undersideAt(q: PlacedSupport, x: number, z: number): number | undefined {
  const grid = hangGridOf(q.asset, q.geom);
  if (!grid) return undefined;
  const cx = (q.box.min.x + q.box.max.x) / 2;
  const cz = (q.box.min.z + q.box.max.z) / 2;
  const local = rotateXZ(x - cx, z - cz, -q.cw);
  const h = gridCellAt(grid, q.geom.size.x, q.geom.size.z, local.x, local.z);
  return h === undefined ? undefined : q.box.min.y + h;
}
