/**
 * Natural trail geometry (generator 2, path op style "natural"): a smooth, winding centreline through the
 * waypoints, a width that varies slowly, and small rounded widenings where the trail meets what it connects.
 *
 *  1. Corners are cut twice (Chaikin, ¼/¾), so a dogleg of waypoints becomes a curve.
 *  2. The curve is resampled every 0.35 cells; the course snakes sideways: control offsets every half wavelength
 *     alternate sides with seeded sizes (0.45..1), smoothstepped, plus a small octave (wavelength 3), amplitude =
 *     wander · clamp(length·0.08, 2.2, 4) + width/2 cells, wavelength clamp(length/3, 9, 16), tapered to nothing over 3 cells at
 *     the ends and at junctions so the trail still meets them. A closing pass fills pinholes.
 *  3. Width w(s) = clamp(width·(0.7 + 0.6·n(s/7)), 1, width + 0.5); every cell whose centre is within w/2 + 0.2 of a
 *     sample is on the trail.
 *  4. Junctions (the connect points) get a disc of radius width/2 + 0.5 (one cell wider): rounded, never a rectangle.
 *
 * Arithmetic and value noise only (bit-identical everywhere), like every generator (architecture §2.5).
 */
import type { Vec2 } from "../contracts/plan";
import { ValueNoise } from "../gen/noise";
import { subSeed } from "../util/hash";

export interface TrailClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function chaikin(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [pts[0] as [number, number]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    if (i > 0) out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    if (i + 2 < pts.length) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts[pts.length - 1] as [number, number]);
  return out;
}

export function trailCells(
  waypoints: readonly Vec2[],
  width: number,
  wander: number,
  seed: number,
  clip: TrailClip,
  junctions: readonly Vec2[] = [],
): Array<[number, number]> {
  let pts: Array<[number, number]> = waypoints.map((p) => [p[0] + 0.5, p[1] + 0.5]);
  pts = chaikin(chaikin(pts));
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as [number, number];
    const b = pts[i] as [number, number];
    const d = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    seg.push(d);
    total += d;
  }
  // arc length of every junction (nearest point on the curve) for tapering
  const jS: number[] = [];
  const course1 = new ValueNoise(subSeed(seed, "course1"));
  const course2 = new ValueNoise(subSeed(seed, "course2"));
  const widthN = new ValueNoise(subSeed(seed, "width"));
  const amp = wander * Math.min(4, Math.max(2.2, total * 0.08)) + 0.5 * width;
  const lambda = Math.min(16, Math.max(9, total / 3));
  const n = Math.max(1, Math.ceil(total / 0.35));
  const samples: Array<{ x: number; y: number; tx: number; ty: number; s: number }> = [];
  let k = 0;
  let k0 = 0;
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    while (k < seg.length - 1 && s > k0 + (seg[k] as number)) {
      k0 += seg[k] as number;
      k++;
    }
    const a = pts[k] as [number, number];
    const b = pts[k + 1] ?? a;
    const len = seg[k] ?? 0;
    const f = len > 0 ? Math.min(1, (s - k0) / len) : 0;
    samples.push({
      x: a[0] + (b[0] - a[0]) * f,
      y: a[1] + (b[1] - a[1]) * f,
      tx: len > 0 ? (b[0] - a[0]) / len : 1,
      ty: len > 0 ? (b[1] - a[1]) / len : 0,
      s,
    });
  }
  for (const j of junctions) {
    let best = 0;
    let bestD = Infinity;
    for (const p of samples) {
      const d = (p.x - j[0] - 0.5) * (p.x - j[0] - 0.5) + (p.y - j[1] - 0.5) * (p.y - j[1] - 0.5);
      if (d < bestD) [bestD, best] = [d, p.s];
    }
    jS.push(best);
  }
  const anchorsS = [0, total, ...jS];
  const cells = new Set<string>();
  const add = (x: number, y: number): void => {
    if (x >= clip.x0 && x <= clip.x1 && y >= clip.y0 && y <= clip.y1) cells.add(`${x},${y}`);
  };
  const disc = (cx: number, cy: number, r: number): void => {
    const rr = (r + 0.2) * (r + 0.2);
    for (let y = Math.floor(cy - r - 1); y <= Math.floor(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.floor(cx + r + 1); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= rr) add(x, y);
      }
  };
  for (const p of samples) {
    const near = Math.min(...anchorsS.map((a) => Math.abs(p.s - a)));
    const taper = Math.min(1, near / 3);
    // a snake: control points every half wavelength alternate sides with seeded amplitudes (so it always bends, never
    // runs straight for long), smoothstep between them, plus a small second octave for kinks
    const u = p.s / (lambda / 2);
    const k = Math.floor(u);
    const ctrl = (j: number): number =>
      (j % 2 === 0 ? 1 : -1) * (0.45 + 0.55 * course1.sample(j * 1.37, 0.5));
    const f = u - k;
    const sm = f * f * (3 - 2 * f);
    const snake = ctrl(k) + (ctrl(k + 1) - ctrl(k)) * sm;
    const off = amp * taper * (snake * 0.8 + (course2.sample(p.s / 3, 1.5) - 0.5) * 2 * 0.2);
    const cx = p.x - p.ty * off;
    const cy = p.y + p.tx * off;
    const w = Math.min(width + 0.5, Math.max(1, width * (0.7 + 0.6 * widthN.sample(p.s / 7, 2.5))));
    disc(cx, cy, w / 2);
  }
  // a junction widens the trail by at most one cell, as a rounded spot
  for (const j of junctions) disc(j[0] + 0.5, j[1] + 0.5, Math.max(0.5, width / 2) + 0.5);
  // close pinholes: a cell with three or four trail neighbours is trail
  const fill: string[] = [];
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      const key = `${nx},${ny}`;
      if (cells.has(key)) continue;
      const m =
        +cells.has(`${nx + 1},${ny}`) +
        +cells.has(`${nx - 1},${ny}`) +
        +cells.has(`${nx},${ny + 1}`) +
        +cells.has(`${nx},${ny - 1}`);
      if (m >= 3) fill.push(key);
    }
  }
  for (const k of fill) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    add(x, y);
  }
  return [...cells]
    .map((c) => c.split(",").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
