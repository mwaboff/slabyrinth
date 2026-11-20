/**
 * Chasm terrain op geometry (architecture §2.5 "chasm"): a meandering trench along a polyline of cell centres.
 *
 * Arithmetic only (+ − × ÷, floor, round, sqrt) and integer-lattice value noise, like every generator (§2.5), so the
 * cells are bit-identical on every engine. Frozen with generator version 2 (the op did not exist before).
 *
 *  1. The polyline (cell centres) is resampled every 0.5 cells along its length s.
 *  2. The course wanders sideways: offset(s) = clamp(1.6·(¾(n₁(s/k) − ½)·2 + ¼(n₂(s/3) − ½)·2), ±1)·A,
 *     A = meander·max(2.5, 1.2·width), k = clamp(length/3, 4, 9).
 *  3. Each bank wanders on its own: half-width(s) = width/2 · taper(s) · (1 + clamp(1.6·meander·(n(s/2.5) − ½)·2, ±0.8)),
 *     0.5..0.8·width, taper = min(1, 0.45 + 0.55·(distance to the nearer end)/5): the crack pinches out at its ends.
 *  4. Every cell whose centre lies within ½ cell along and inside both half-widths across a sample is cut.
 *  5. One closing pass adds cells with three or four cut 4-neighbours (no pinholes on tight bends).
 */
import type { Vec2 } from "../contracts/plan";
import { ValueNoise } from "../gen/noise";
import { subSeed } from "../util/hash";

export interface ChasmSample {
  /** Centre of the trench (cell-centre coordinates: cell (x,y) has centre x+0.5, y+0.5). */
  x: number;
  y: number;
  /** Unit tangent of the course. */
  tx: number;
  ty: number;
}

export interface ChasmGeometry {
  /** Cut cells, row-major, unique. */
  cells: Array<[number, number]>;
  samples: ChasmSample[];
}

export interface ChasmClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function chasmGeometry(
  points: readonly Vec2[],
  width: number,
  meander: number,
  seed: number,
  clip: ChasmClip,
): ChasmGeometry {
  const pts = points.map((p) => [p[0] + 0.5, p[1] + 0.5] as [number, number]);
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as [number, number];
    const b = pts[i] as [number, number];
    const d = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    segLen.push(d);
    total += d;
  }
  const course = new ValueNoise(subSeed(seed, "course"));
  const course2 = new ValueNoise(subSeed(seed, "course2"));
  const left = new ValueNoise(subSeed(seed, "bank-l"));
  const right = new ValueNoise(subSeed(seed, "bank-r"));
  const amp = meander * Math.max(2.5, 1.2 * width);
  // short chasms wander too: the course noise has at least three wavelengths over the length (4..9 cells)
  const courseScale = Math.min(9, Math.max(4, total / 3));
  const n = Math.max(1, Math.ceil(total / 0.5));
  const samples: ChasmSample[] = [];
  const halfL: number[] = [];
  const halfR: number[] = [];
  let seg = 0;
  let segStart = 0;
  for (let k = 0; k <= n; k++) {
    const s = total > 0 ? (total * k) / n : 0;
    while (seg < segLen.length - 1 && s > segStart + (segLen[seg] as number)) {
      segStart += segLen[seg] as number;
      seg++;
    }
    const a = pts[seg] as [number, number];
    const b = pts[seg + 1] ?? a;
    const len = segLen[seg] ?? 0;
    const f = len > 0 ? Math.min(1, (s - segStart) / len) : 0;
    const tx = len > 0 ? (b[0] - a[0]) / len : 1;
    const ty = len > 0 ? (b[1] - a[1]) / len : 0;
    // value noise clusters near ½: stretch it (×1.6, clamped) so the course really wanders; a second octave adds kinks
    const wobble =
      (course.sample(s / courseScale, 0.5) - 0.5) * 2 * 0.75 + (course2.sample(s / 3, 3.5) - 0.5) * 2 * 0.25;
    const off = Math.max(-1, Math.min(1, wobble * 1.6)) * amp;
    // perpendicular (screen: x east, y south) = (−ty, tx)
    samples.push({ x: a[0] + (b[0] - a[0]) * f - ty * off, y: a[1] + (b[1] - a[1]) * f + tx * off, tx, ty });
    // banks wander on their own (stretched noise) and the crack pinches out toward its ends
    const taper = Math.min(1, 0.45 + (0.55 * Math.min(s, total - s)) / 5);
    const bank = (v: number): number =>
      Math.min(
        width * 0.8,
        Math.max(
          0.5,
          (width / 2) * taper * (1 + Math.max(-0.8, Math.min(0.8, meander * 1.6 * (v - 0.5) * 2))),
        ),
      );
    halfL.push(bank(left.sample(s / 2.5, 2.5)));
    halfR.push(bank(right.sample(s / 2.5, 4.5)));
  }
  const cut = new Set<string>();
  samples.forEach((c, k) => {
    const hl = halfL[k] as number;
    const hr = halfR[k] as number;
    const r = Math.ceil(Math.max(hl, hr) + 1);
    const cx0 = Math.max(clip.x0, Math.floor(c.x) - r);
    const cx1 = Math.min(clip.x1, Math.floor(c.x) + r);
    const cy0 = Math.max(clip.y0, Math.floor(c.y) - r);
    const cy1 = Math.min(clip.y1, Math.floor(c.y) + r);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const dx = x + 0.5 - c.x;
        const dy = y + 0.5 - c.y;
        const along = dx * c.tx + dy * c.ty;
        if (along < -0.5 || along > 0.5) continue;
        const across = -dx * c.ty + dy * c.tx; // + = to the right of the course (perpendicular (−ty, tx))
        if (across >= -hl && across <= hr) cut.add(`${x},${y}`);
      }
    }
  });
  // closing pass: fill pinholes left between fanned slices on tight bends
  const add: string[] = [];
  const has = (x: number, y: number): boolean => cut.has(`${x},${y}`);
  for (const k of cut) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (has(nx, ny) || nx < clip.x0 || nx > clip.x1 || ny < clip.y0 || ny > clip.y1) continue;
      const m = +has(nx + 1, ny) + +has(nx - 1, ny) + +has(nx, ny + 1) + +has(nx, ny - 1);
      if (m >= 3) add.push(`${nx},${ny}`);
    }
  }
  for (const k of add) cut.add(k);
  const cells = [...cut]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { cells, samples };
}

/** Sample at fraction `at` (0..1) of the course. */
export function chasmSampleAt(g: ChasmGeometry, at: number): ChasmSample | null {
  if (g.samples.length === 0) return null;
  const k = Math.round(Math.min(1, Math.max(0, at)) * (g.samples.length - 1));
  return g.samples[k] ?? null;
}
