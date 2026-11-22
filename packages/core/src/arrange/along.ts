/**
 * Along a path: `run` (modules end to end, each turned to its stretch, overlapping, with a plug or extended stretches at
 * the corners) and `station` (a kit repeated every N tiles, turned to the path, optionally mirrored on the far side; a
 * helper until anchors hand out bays and paired frames).
 */
import { pushAll } from "../util/lists";
import { mirror } from "./copies";
import { pathLength, pointAlong, segments, type Path } from "./path";
import { centreOf, extent, type Arrangement, type Placed } from "./piece";
import { transform } from "./transform";

export interface RunParams {
  readonly path: Path;
  /** Share of a module's length each one overlaps the next (default 0.03; 0 for chained lines, up to 0.13 for plates). */
  readonly overlap?: number;
  /**
   * A plug at every inner corner (every facet joint of an arc; and at the ends of an open path with `fillEnds`), turned
   * with the stretch it ends: a post at a wall corner, the narrowest piece of the pool on an arc.
   */
  readonly filler?: Arrangement;
  readonly fillEnds?: boolean;
  /**
   * With no filler, the stretches at an inner corner each reach on by half the module's width, so the outer corner is
   * closed (default true).
   */
  readonly extendJoints?: boolean;
}

/**
 * Modules end to end along a path, each turned to its stretch: a rail, a kerb, a beam course, an arc of planks. The
 * module's local x is the direction of travel (`lengthwise(piece)`); its step is its own length along x less the
 * overlap, and each stretch gets the fewest modules that cover it at that step, spread evenly from end to end (so both
 * ends are flush and the overlap is at least the one asked for). A stretch shorter than one module gets one, centred.
 * On an arc (path.ts `arcPath`) each 15° facet is a stretch, so a facet of length 0.26 × radius takes
 * ceil(0.26 r / length) modules.
 */
export function run(module: Arrangement, p: RunParams): Arrangement {
  const len = extent(module, "x");
  const width = extent(module, "z");
  if (len <= 0) return [];
  const [mx, mz] = centreOf(module);
  const centred = transform(module, { dx: -mx, dz: -mz });
  const step = len * (1 - Math.min(0.9, Math.max(0, p.overlap ?? 0.03)));
  const segs = segments(p.path);
  const closed = p.path.closed === true;
  const extend = p.filler === undefined && p.extendJoints !== false ? width / 2 : 0;
  const out: Placed[] = [];
  segs.forEach((s, i) => {
    const before = closed || i > 0 ? extend : 0;
    const after = closed || i < segs.length - 1 ? extend : 0;
    const total = s.length + before + after;
    const n = total <= len ? 1 : Math.ceil((total - len) / step - 1e-9) + 1;
    const pitch = n > 1 ? (total - len) / (n - 1) : 0;
    const ux = (s.b[0] - s.a[0]) / s.length;
    const uz = (s.b[1] - s.a[1]) / s.length;
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? s.length / 2 : -before + len / 2 + k * pitch;
      pushAll(out, transform(centred, { turn: s.heading, dx: s.a[0] + ux * t, dz: s.a[1] + uz * t }));
    }
  });
  if (p.filler !== undefined) {
    const joints = closed ? segs.map((s) => s.a) : segs.slice(1).map((s) => s.a);
    const turns = closed
      ? segs.map((_, i) => segs.at(i - 1)?.heading ?? 0)
      : segs.slice(0, -1).map((s) => s.heading);
    const first = segs[0];
    const last = segs[segs.length - 1];
    if (p.fillEnds === true && !closed && first && last) {
      joints.unshift(first.a);
      turns.unshift(first.heading);
      joints.push(last.b);
      turns.push(last.heading);
    }
    const filler = p.filler;
    joints.forEach((j, i) => pushAll(out, transform(filler, { turn: turns[i] ?? 0, dx: j[0], dz: j[1] })));
  }
  return out;
}

export interface StationParams {
  readonly path: Path;
  /** Distance between stations along the path. */
  readonly every: number;
  /** Distance of the first station from the path's start (default: half of `every`). */
  readonly start?: number;
  /** How far to the left of travel (local +z when heading east) the arrangement stands (default 0). */
  readonly offset?: number;
  /** Also a mirrored copy on the other side (at −offset). */
  readonly mirrored?: boolean;
}

/**
 * A sub-arrangement repeated every `every` tiles along a path, turned to the path (its local x along travel): a kit
 * of pieces along an edge, mirrored on the far side when asked.
 */
export function station(a: Arrangement, p: StationParams): Arrangement {
  const total = pathLength(p.path);
  const out: Placed[] = [];
  const left = transform(a, { dz: p.offset ?? 0 });
  const right =
    p.mirrored === true ? transform(mirror(a, { axis: "z", keep: false }), { dz: -(p.offset ?? 0) }) : [];
  if (p.every <= 0) return out;
  for (let d = p.start ?? p.every / 2; d <= total + 1e-9; d += p.every) {
    const at = pointAlong(p.path, d);
    if (!at) break;
    const place = { turn: at.heading, dx: at.at[0], dz: at.at[1] };
    pushAll(out, transform(left, place), transform(right, place));
  }
  return out;
}
