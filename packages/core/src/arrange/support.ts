/**
 * Pieces on, under and into other pieces, by their measured boxes: `rest` (on the top of what is under, or hung from the
 * underside of what is over with `under`) and `sink` (bedded by a share of its own height).
 */
import { maxOf, minOf } from "../util/lists";
import { bounds, placedBox, type Arrangement } from "./piece";
import { transform } from "./transform";

const EPS = 1e-9;

/** The pieces of `base` whose footprint holds (x, z). */
function holding(base: Arrangement, x: number, z: number): ReturnType<typeof placedBox>[] {
  return base
    .map(placedBox)
    .filter((b) => x >= b.min.x - EPS && x <= b.max.x + EPS && z >= b.min.z - EPS && z <= b.max.z + EPS);
}

/** The top of the highest piece of `base` whose footprint holds (x, z), or null. */
export function surfaceAt(base: Arrangement, x: number, z: number): number | null {
  const tops = holding(base, x, z).map((b) => b.max.y);
  return tops.length > 0 ? maxOf(tops) : null;
}

/** The underside of the lowest piece of `base` whose footprint holds (x, z), or null. */
export function undersideAt(base: Arrangement, x: number, z: number): number | null {
  const bottoms = holding(base, x, z).map((b) => b.min.y);
  return bottoms.length > 0 ? minOf(bottoms) : null;
}

export interface RestParams {
  /** Rest each piece on what is under its own centre (a scatter on rubble), instead of the arrangement as one. */
  readonly each?: boolean;
  /** Hang from the underside of `base` instead (a lamp from a beam): the top of the hung pieces meets it. */
  readonly under?: boolean;
}

/**
 * `top` set on `base`'s top surface (by the pieces' measured heights), returned with `base`. As one (default): the whole
 * of `top` is lifted until its lowest piece stands on the highest base piece under any of its pieces; with `each`, every
 * piece rests on what is under its own centre. With `under`, the same against the underside: the arrangement (or each
 * piece) hangs with its top at the lowest underside over it. A piece with nothing under (or over) it stays where it is.
 */
export function rest(top: Arrangement, base: Arrangement, p: RestParams = {}): Arrangement {
  const hang = p.under === true;
  const contact = hang ? undersideAt : surfaceAt;
  if (p.each === true) {
    return [
      ...base,
      ...top.map((q) => {
        const c = contact(base, q.x, q.z);
        return c === null ? q : { ...q, y: hang ? c - q.piece.variant.geom.size.y : c };
      }),
    ];
  }
  const contacts = top.map((q) => contact(base, q.x, q.z)).filter((s): s is number => s !== null);
  if (contacts.length === 0) return [...base, ...top];
  const b = bounds(top);
  const dy = hang ? minOf(contacts) - b.max.y : maxOf(contacts) - b.min.y;
  return [...base, ...transform(top, { dy })];
}

/**
 * Every piece lowered by a share of its own height: 0.25..0.6 beds a stone in the ground or a post in the floor it spans;
 * a negative share sets it proud.
 */
export function sink(a: Arrangement, p: { readonly fraction: number }): Arrangement {
  return a.map((q) => ({ ...q, y: q.y - p.fraction * q.piece.variant.geom.size.y }));
}
