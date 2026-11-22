/**
 * The arrangement operators: pure functions from an arrangement (and parameters) to an arrangement, so they compose
 * (`ring(twin(lengthwise(beam)), ...)`). Every operator takes the arrangement it works on first and returns a new one;
 * none reads anything but its arguments. `OPERATORS` lists them with what each is for: a new operator is one function
 * here (or in its own file, as `scatter` is) and one row there.
 *
 * Turns are clockwise seen from above (piece.ts); an operator that turns copies by an angle off the 15° grid (a ring of
 * 7) places them exactly and snaps each piece's yaw to the grid.
 */
import { maxOf, pushAll } from "../util/lists";
import { rotateXZ } from "../util/turn";
import { segments, pointAlong, pathLength, type Path } from "./path";
import {
  bounds,
  centreOf,
  extent,
  placedBox,
  snapYaw,
  type Arrangement,
  type Placed,
  type XZ,
} from "./piece";
import { scatter } from "./scatter";
import { thin } from "./budget";

// ── moving a whole arrangement ──

export interface TransformParams {
  /** Turn about `about` (degrees clockwise; positions turn exactly, yaws snap to 15°). */
  readonly turn?: number;
  readonly about?: XZ;
  readonly dx?: number;
  readonly dy?: number;
  readonly dz?: number;
}

/** Turns the arrangement about a point, then moves it. */
export function transform(a: Arrangement, t: TransformParams): Arrangement {
  const turn = t.turn ?? 0;
  const [ax, az] = t.about ?? [0, 0];
  const dx = t.dx ?? 0;
  const dy = t.dy ?? 0;
  const dz = t.dz ?? 0;
  return a.map((p) => {
    const r = rotateXZ(p.x - ax, p.z - az, turn);
    return { ...p, x: ax + r.x + dx, y: p.y + dy, z: az + r.z + dz, yaw: snapYaw(p.yaw + turn) };
  });
}

// ── copies at one place ──

export interface TwinParams {
  /** The copy's turn (default 180: a one-sided piece made two-sided). */
  readonly turn?: number;
  /** Turned about this point (default: the arrangement's footprint centre). */
  readonly about?: XZ;
  /** The copy is then moved by this much (back to back: a piece's thickness). */
  readonly offset?: XZ;
}

/** The arrangement and a turned copy of it. */
export function twin(a: Arrangement, p: TwinParams = {}): Arrangement {
  const [dx, dz] = p.offset ?? [0, 0];
  return [...a, ...transform(a, { turn: p.turn ?? 180, about: p.about ?? centreOf(a), dx, dz })];
}

export interface FanParams {
  readonly count: number;
  /** The turn between copies (default 15). */
  readonly step?: number;
  /** Default: the arrangement's footprint centre. */
  readonly about?: XZ;
}

/** `count` copies at one centre, each turned `step` further: a post rounded into a column, a slab into a disc. */
export function fan(a: Arrangement, p: FanParams): Arrangement {
  const about = p.about ?? centreOf(a);
  const step = p.step ?? 15;
  return Array.from({ length: Math.max(0, p.count) }, (_, i) =>
    transform(a, { turn: i * step, about }),
  ).flat();
}

/**
 * How many copies `fan` needs for a full round at `step`: an outline that repeats every quarter turn (a square
 * footprint, within 5%) needs 90/step, any other every half turn 180/step.
 */
export function roundCount(a: Arrangement, step = 15): number {
  const sx = extent(a, "x");
  const sz = extent(a, "z");
  const square = Math.abs(sx - sz) <= 0.05 * Math.max(sx, sz);
  return Math.max(1, Math.round((square ? 90 : 180) / step));
}

// ── repetition ──

export interface ArrayParams {
  readonly axis: "x" | "z";
  readonly count: number;
  /** Centre-to-centre distance (default: the arrangement's own extent along the axis plus `gap`, so members touch). */
  readonly pitch?: number;
  readonly gap?: number;
  /** Centre the row on the origin (default true); else it starts at the arrangement's place. */
  readonly centred?: boolean;
}

/** `count` copies in a row at a pitch: boards, a post-row wall, shelves, one direction of a lattice. */
export function array(a: Arrangement, p: ArrayParams): Arrangement {
  const pitch = p.pitch ?? extent(a, p.axis) + (p.gap ?? 0);
  const first = p.centred === false ? 0 : (-(p.count - 1) * pitch) / 2;
  return Array.from({ length: Math.max(0, p.count) }, (_, i) => {
    const d = first + i * pitch;
    return transform(a, p.axis === "x" ? { dx: d } : { dz: d });
  }).flat();
}

export interface StackParams {
  readonly count: number;
  /** Course height (default: the arrangement's own height). */
  readonly pitch?: number;
}

/** Vertical courses: `count` copies each one course higher. */
export function stack(a: Arrangement, p: StackParams): Arrangement {
  const pitch = p.pitch ?? extent(a, "y");
  return Array.from({ length: Math.max(0, p.count) }, (_, i) => transform(a, { dy: i * pitch })).flat();
}

export interface LayerParams {
  /** The local axis the second skin stands off along. */
  readonly normal: "x" | "z";
  /** How far proud of the first (negative: behind it), typically 0.01..0.25. */
  readonly proud: number;
  /** Along the other horizontal axis (half a module: half the first skin's extent that way). */
  readonly shift?: number;
  /** The second skin (default: a copy of the first). */
  readonly skin?: Arrangement;
}

/** A second skin just proud of (or behind) the first, shifted along it: depth and broken joints on a face. */
export function layer(a: Arrangement, p: LayerParams): Arrangement {
  const shift = p.shift ?? 0;
  const move = p.normal === "x" ? { dx: p.proud, dz: shift } : { dz: p.proud, dx: shift };
  return [...a, ...transform(p.skin ?? a, move)];
}

export interface RingParams {
  readonly count: number;
  /** From the centre to each copy's origin. */
  readonly radius: number;
  /** Angle of the first copy, clockwise from east (default 0). */
  readonly start?: number;
  readonly about?: XZ;
}

/** `count` copies round a point, each moved out by `radius` and turned to face out the way the first does. */
export function ring(a: Arrangement, p: RingParams): Arrangement {
  const [cx, cz] = p.about ?? [0, 0];
  const n = Math.max(0, p.count);
  const out: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const turn = (p.start ?? 0) + (i * 360) / n;
    for (const q of a) {
      const r = rotateXZ(q.x + p.radius, q.z, turn);
      out.push({ ...q, x: cx + r.x, z: cz + r.z, yaw: snapYaw(q.yaw + turn) });
    }
  }
  return out;
}

// ── along a path ──

export interface RunParams {
  readonly path: Path;
  /** Share of a module's length each one overlaps the next (default 0.08; skilled builders use 0.03..0.13). */
  readonly overlap?: number;
  /** Placed at every inner corner (and at the ends of an open path with `fillEnds`), turned with the stretch it ends. */
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
 * overlap, and each stretch gets the fewest modules that cover it at that step, spread evenly (so the overlap is at
 * least the one asked for). A stretch shorter than one module gets one, centred.
 */
export function run(module: Arrangement, p: RunParams): Arrangement {
  const len = extent(module, "x");
  const width = extent(module, "z");
  if (len <= 0) return [];
  const [mx, mz] = centreOf(module);
  const centred = transform(module, { dx: -mx, dz: -mz });
  const step = len * (1 - Math.min(0.9, Math.max(0, p.overlap ?? 0.08)));
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
    if (p.fillEnds === true && !closed && segs.length > 0) {
      const first = segs[0];
      const last = segs[segs.length - 1];
      if (first && last) {
        joints.unshift(first.a);
        turns.unshift(first.heading);
        joints.push(last.b);
        turns.push(last.heading);
      }
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

// ── on and into other pieces ──

export interface RestParams {
  /** Rest each piece on what is under its own centre (a scatter on rubble), instead of the arrangement as one. */
  readonly each?: boolean;
}

/** The top of the highest piece of `base` whose footprint holds (x, z), or null. */
export function surfaceAt(base: Arrangement, x: number, z: number): number | null {
  let top: number | null = null;
  for (const q of base) {
    const b = placedBox(q);
    if (x < b.min.x - 1e-9 || x > b.max.x + 1e-9 || z < b.min.z - 1e-9 || z > b.max.z + 1e-9) continue;
    top = top === null ? b.max.y : Math.max(top, b.max.y);
  }
  return top;
}

/**
 * `top` set on `base`'s top surface (by the pieces' measured heights), returned with `base`. As one (default): the whole
 * of `top` is lifted until its lowest piece stands on the highest base piece under any of its pieces; with `each`, every
 * piece rests on what is under its own centre. A piece with nothing under it stays where it is.
 */
export function rest(top: Arrangement, base: Arrangement, p: RestParams = {}): Arrangement {
  if (p.each === true) {
    return [...base, ...top.map((q) => ({ ...q, y: surfaceAt(base, q.x, q.z) ?? q.y }))];
  }
  const surfaces = top.map((q) => surfaceAt(base, q.x, q.z)).filter((s): s is number => s !== null);
  if (surfaces.length === 0) return [...base, ...top];
  return [...base, ...transform(top, { dy: maxOf(surfaces) - bounds(top).min.y })];
}

/** Every piece lowered by a share of its own height (0.25..0.6: a stone bedded in the ground or in another piece). */
export function sink(a: Arrangement, p: { readonly fraction: number }): Arrangement {
  return a.map((q) => ({ ...q, y: q.y - p.fraction * q.piece.variant.geom.size.y }));
}

export interface MirrorParams {
  /** The axis whose sign flips: "x" mirrors across the line x = at (east to west), "z" across z = at. */
  readonly axis: "x" | "z";
  readonly at?: number;
  /** Keep the original beside the mirrored copy (default true). */
  readonly keep?: boolean;
}

/**
 * The arrangement reflected across a line. Pieces cannot be scaled in TaleSpire, so each is turned to the yaw that
 * mirrors its footprint and its front (a left-handed piece stays left-handed).
 */
export function mirror(a: Arrangement, p: MirrorParams): Arrangement {
  const at = p.at ?? 0;
  const m = a.map((q) =>
    p.axis === "x"
      ? { ...q, x: 2 * at - q.x, yaw: snapYaw(180 - q.yaw) }
      : { ...q, z: 2 * at - q.z, yaw: snapYaw(-q.yaw) },
  );
  return p.keep === false ? m : [...a, ...m];
}

// ── the table ──

/** One operator: what it is for, and the function. */
interface OperatorRow {
  readonly doc: string;
  readonly apply: (a: Arrangement, params: never) => Arrangement;
}

/**
 * Every operator by name, with what it is for: the set a recipe composes from. Each is `(arrangement, params) =>
 * arrangement`; `rest` also takes the base it rests on.
 */
export const OPERATORS = {
  transform: { doc: "turn about a point and move the whole arrangement", apply: transform },
  twin: {
    doc: "the arrangement and a copy turned 180° at the same centre (a one-sided piece made two-sided)",
    apply: twin,
  },
  fan: {
    doc: "N copies at one centre in 15° steps (a square post rounded into a column, a slab into a disc)",
    apply: fan,
  },
  array: {
    doc: "copies in a row at a pitch equal to their own width (boards, post rows, shelves; crossed: a mesh)",
    apply: array,
  },
  run: {
    doc: "modules end to end along a polyline or arc, overlapping 3-13%, a filler at the joints",
    apply: run,
  },
  stack: { doc: "vertical courses", apply: stack },
  layer: { doc: "a second skin 0.01-0.25 proud of or behind the first, shifted half a module", apply: layer },
  ring: { doc: "copies round a point (stones round a fire)", apply: ring },
  scatter: {
    doc: "an area filled at a density, with spacing, clusters, edge bias, jitter and empty slots",
    apply: scatter,
  },
  rest: { doc: "set on top of another arrangement's top surface", apply: rest },
  sink: { doc: "lowered by a share of its height into what it stands on", apply: sink },
  mirror: { doc: "reflected across a line (each piece re-turned, never scaled)", apply: mirror },
  station: { doc: "a kit repeated every N tiles along a path, mirrored on the far side", apply: station },
  thin: { doc: "thinned deterministically to a piece budget", apply: thin },
} as const satisfies Record<string, OperatorRow>;

export type OperatorName = keyof typeof OPERATORS;
