/**
 * `repeat`: copies of an arrangement along an axis at a pitch, a count of them or as many as fill a length (the last one
 * pulled back so its far end is flush with the length: the overlap grows, never a gap). `array` (across, centred on the
 * origin) and `stack` (up) are its presets; a vector step (`axis: [dx, dy, dz]`) makes a stair of copies.
 */
import { extent, type Arrangement } from "./piece";
import { transform } from "./transform";

type Axis = "x" | "y" | "z";

export interface RepeatParams {
  /** A local axis, or the step from one copy to the next (tiles). */
  readonly axis: Axis | readonly [dx: number, dy: number, dz: number];
  /** Distance between copies along an axis (default: the arrangement's own extent along it, so copies touch). */
  readonly pitch?: number;
  /** How many copies. */
  readonly count?: number;
  /** Or fill this length along the axis from the arrangement's near side: ceil((length − size) / pitch) + 1 copies. */
  readonly length?: number;
  /** Centre the copies on the arrangement's place instead of starting there (default false). */
  readonly centred?: boolean;
}

const unit: Readonly<Record<Axis, readonly [number, number, number]>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Copies along an axis (see the file header). With neither `count` nor `length`, one copy. */
export function repeat(a: Arrangement, p: RepeatParams): Arrangement {
  if (typeof p.axis !== "string") {
    const [sx, sy, sz] = p.axis;
    const n = Math.max(0, p.count ?? 1);
    const first = p.centred === true ? -(n - 1) / 2 : 0;
    return Array.from({ length: n }, (_, i) =>
      transform(a, { dx: (first + i) * sx, dy: (first + i) * sy, dz: (first + i) * sz }),
    ).flat();
  }
  const size = extent(a, p.axis);
  const pitch = p.pitch ?? size;
  const offsets = repeatOffsets(size, pitch, p);
  const [ux, uy, uz] = unit[p.axis];
  return offsets.map((d) => transform(a, { dx: d * ux, dy: d * uy, dz: d * uz })).flat();
}

/** Where each copy goes along the axis, from the arrangement's place. */
function repeatOffsets(size: number, pitch: number, p: RepeatParams): number[] {
  const fill = p.length;
  if (fill !== undefined) {
    if (pitch <= 0 || fill <= size) return [0];
    const n = Math.ceil((fill - size) / pitch - 1e-9) + 1;
    // the last copy pulled back flush with the far end
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? fill - size : i * pitch));
  }
  const n = Math.max(0, p.count ?? 1);
  const first = p.centred === true ? (-(n - 1) * pitch) / 2 : 0;
  return Array.from({ length: n }, (_, i) => first + i * pitch);
}

export interface ArrayParams {
  readonly axis: "x" | "z";
  readonly count: number;
  /** Centre-to-centre distance (default: the arrangement's own extent along the axis plus `gap`, so members touch). */
  readonly pitch?: number;
  readonly gap?: number;
  /** Centre the row on the origin (default true); else it starts at the arrangement's place. */
  readonly centred?: boolean;
}

/** `repeat` across, centred: boards, a post-row wall, shelves, one direction of a lattice (crossed: a mesh). */
export function array(a: Arrangement, p: ArrayParams): Arrangement {
  const pitch = p.pitch ?? extent(a, p.axis) + (p.gap ?? 0);
  return repeat(a, { axis: p.axis, count: p.count, pitch, centred: p.centred !== false });
}

export interface StackParams {
  readonly count: number;
  /** Course height (default: the arrangement's own height). */
  readonly pitch?: number;
}

/** `repeat` up: vertical courses, each one course higher. */
export function stack(a: Arrangement, p: StackParams): Arrangement {
  return repeat(a, { axis: "y", count: p.count, pitch: p.pitch ?? extent(a, "y") });
}
