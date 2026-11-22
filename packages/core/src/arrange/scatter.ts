/**
 * `scatter`: an area filled with copies of candidate pieces, as builders strew flat pieces, rubble or leaves: a grid of
 * slots at the density's pitch, each moved by a jitter, kept or left empty by a hash draw weighted for clusters and for
 * the area's edge or middle, then thinned to a minimum spacing in slot order, each kept slot taking a candidate and a
 * turn off the grid. Every draw is `hashUnit(seed, "scatter", what, i, j)`, so the same parameters always give the same
 * arrangement.
 */
import { ValueNoise } from "../gen/noise";
import { h32, hashUnit } from "../util/hash";
import { maxOf, minOf } from "../util/lists";
import { snapYaw, type Arrangement, type Placed, type XZ } from "./piece";

export interface ScatterParams {
  /** A rectangle `w` (x) by `d` (z) centred on the origin, or a polygon. */
  readonly area: { readonly w: number; readonly d: number } | { readonly polygon: readonly XZ[] };
  /** Slots per square tile (before empty slots and spacing). */
  readonly density: number;
  /** Least distance between two pieces' centres (default 0: none). */
  readonly minSpacing?: number;
  /** 0..1: how strongly pieces gather in clumps of `clusterSize` tiles (default 0). */
  readonly cluster?: number;
  readonly clusterSize?: number;
  /** -1..1: above 0 favours slots near the area's edge, below 0 its middle (default 0). */
  readonly edgeBias?: number;
  /** 0..1: a slot moves up to this share of the pitch either way (default 0.8). */
  readonly jitter?: number;
  /** Largest turn either way from the candidate's own (degrees, in 15° steps; default 180: any turn). */
  readonly yawJitter?: number;
  /** 0..1: the share of slots left empty (default 0). */
  readonly empty?: number;
  /** Points kept clear (a lane between doors, a doorway's clearance), in the area's frame. */
  readonly exclude?: (x: number, z: number) => boolean;
  /** Names the draws: the same seed and parameters give the same scatter. */
  readonly seed: string | number;
}

type Region = {
  inside: (x: number, z: number) => boolean;
  edge: (x: number, z: number) => number;
  box: Box2;
};
interface Box2 {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Copies of `candidates`' pieces (each keeps its own height and turn as a base) strewn over the area. */
export function scatter(candidates: Arrangement, p: ScatterParams): Arrangement {
  if (candidates.length === 0 || p.density <= 0) return [];
  const region = regionOf(p.area);
  const pitch = 1 / Math.sqrt(p.density);
  const jitter = p.jitter ?? 0.8;
  const keepShare = 1 - Math.min(1, Math.max(0, p.empty ?? 0));
  const bias = Math.min(1, Math.max(-1, p.edgeBias ?? 0));
  const cluster = Math.min(1, Math.max(0, p.cluster ?? 0));
  const noise = new ValueNoise(h32(`${p.seed}:scatter:cluster`));
  const clusterSize = Math.max(0.5, p.clusterSize ?? 3);
  const span = Math.max(1e-9, Math.min(region.box.x1 - region.box.x0, region.box.z1 - region.box.z0) / 2);
  const yawSteps = Math.round(Math.min(180, Math.max(0, p.yawJitter ?? 180)) / 15);
  const draw = (what: string, i: number, j: number): number => hashUnit(p.seed, "scatter", what, i, j);

  const cols = Math.ceil((region.box.x1 - region.box.x0) / pitch);
  const rows = Math.ceil((region.box.z1 - region.box.z0) / pitch);
  const kept: Placed[] = [];
  const spacing = p.minSpacing ?? 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = region.box.x0 + (i + 0.5 + (draw("x", i, j) - 0.5) * jitter) * pitch;
      const z = region.box.z0 + (j + 0.5 + (draw("z", i, j) - 0.5) * jitter) * pitch;
      if (!region.inside(x, z) || p.exclude?.(x, z) === true) continue;
      // 0 on the edge, 1 at the middle (or deeper)
      const depth = Math.min(1, region.edge(x, z) / span);
      const edgeWeight = bias >= 0 ? 1 - bias * depth : 1 + bias * (1 - depth);
      const clumpWeight = 1 - cluster + cluster * 2 * noise.sample(x / clusterSize, z / clusterSize);
      if (draw("keep", i, j) >= keepShare * edgeWeight * clumpWeight) continue;
      if (spacing > 0 && kept.some((q) => Math.hypot(q.x - x, q.z - z) < spacing)) continue;
      const c = candidates[Math.floor(draw("pick", i, j) * candidates.length)] ?? candidates[0];
      if (!c) continue;
      const turn = (Math.floor(draw("turn", i, j) * (2 * yawSteps + 1)) - yawSteps) * 15;
      kept.push({ ...c, x: x + c.x, z: z + c.z, yaw: snapYaw(c.yaw + turn) });
    }
  }
  return kept;
}

function regionOf(area: ScatterParams["area"]): Region {
  if ("polygon" in area) {
    const pts = area.polygon;
    const xs = pts.map((q) => q[0]);
    const zs = pts.map((q) => q[1]);
    return {
      box: { x0: minOf(xs), z0: minOf(zs), x1: maxOf(xs), z1: maxOf(zs) },
      inside: (x, z) => inPolygon(pts, x, z),
      edge: (x, z) => edgeDistance(pts, x, z),
    };
  }
  const hw = area.w / 2;
  const hd = area.d / 2;
  return {
    box: { x0: -hw, z0: -hd, x1: hw, z1: hd },
    inside: (x, z) => Math.abs(x) <= hw && Math.abs(z) <= hd,
    edge: (x, z) => Math.min(hw - Math.abs(x), hd - Math.abs(z)),
  };
}

/** Even-odd test of a point against a polygon. */
function inPolygon(pts: readonly XZ[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
    const [xi, zi] = pts[i] ?? [0, 0];
    const [xk, zk] = pts[k] ?? [0, 0];
    if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the nearest side of a polygon. */
function edgeDistance(pts: readonly XZ[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
    const [ax, az] = pts[k] ?? [0, 0];
    const [bx, bz] = pts[i] ?? [0, 0];
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + vx * t), z - (az + vz * t)));
  }
  return best;
}
