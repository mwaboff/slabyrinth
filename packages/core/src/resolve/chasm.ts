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
import { h32, subSeed } from "../util/hash";

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
  /** Cut width across the course at each sample (cells). */
  widths: number[];
}

export interface ChasmClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Course widths and the straightness of a polyline, for generator 3's visible meander and the review. */
export interface CourseShape {
  /** Largest distance of the course from the straight line between its ends (cells). */
  deviation: number;
  /** Length of that straight line. */
  chord: number;
  /** Turns of the course away from the chord, counting only swings of at least `hysteresis` cells. */
  bends: number;
}

/**
 * How far a centreline strays from the line between its ends, and how many times it swings from one side of that
 * line to the other way round (an arc is one bend, an S two). Swings smaller than `hysteresis` cells do not count.
 */
export function courseShape(centre: ReadonlyArray<readonly [number, number]>, hysteresis = 0.6): CourseShape {
  const a = centre[0];
  const b = centre[centre.length - 1];
  if (!a || !b || centre.length < 3) return { deviation: 0, chord: 0, bends: 0 };
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord < 1e-6) return { deviation: 0, chord, bends: 0 };
  const off = centre.map((p) => ((p[0] - a[0]) * -dy + (p[1] - a[1]) * dx) / chord);
  let deviation = 0;
  for (const o of off) deviation = Math.max(deviation, Math.abs(o));
  // turning points with hysteresis: a bend is a peak or a valley of the offset, swings under `hysteresis` ignored
  let bends = 0;
  let hi = off[0] as number;
  let lo = off[0] as number;
  let state: "up" | "down" | "none" = "none";
  for (const o of off) {
    if (o > hi) hi = o;
    if (o < lo) lo = o;
    if (state !== "down" && hi - o >= hysteresis) {
      if (state === "up") bends++;
      state = "down";
      lo = o;
    } else if (state !== "up" && o - lo >= hysteresis) {
      if (state === "down") bends++;
      state = "up";
      hi = o;
    }
  }
  return { deviation, chord, bends };
}

/** Smoothed triangle wave in [-1, 1] with period 1 (no trigonometry, so every engine agrees). */
function wave(t: number): number {
  const x = t - Math.floor(t);
  const tri = 4 * Math.abs(x - 0.5) - 1;
  return tri * (1.5 - 0.5 * tri * tri);
}

export function chasmGeometry(
  points: readonly Vec2[],
  width: number,
  meander: number,
  seed: number,
  clip: ChasmClip,
  opts: { wander?: number; avoid?: ReadonlySet<string> } = {},
): ChasmGeometry {
  const first = buildCourse(points, width, meander, seed, clip, opts.wander, 0);
  if (opts.wander === undefined || !opts.avoid || opts.avoid.size === 0) return first;
  // generator 3: the wander must not wash over what the plan placed by hand (a torch beside a bridge): try other
  // phases and the mirror image, and keep the first course that leaves those cells alone (else the one that hits least)
  const hits = (g: ChasmGeometry): number => g.cells.filter(([x, y]) => opts.avoid?.has(`${x},${y}`)).length;
  let best = first;
  let least = hits(first);
  for (let variant = 1; variant <= 9 && least > 0; variant++) {
    const g = buildCourse(points, width, meander, seed, clip, opts.wander, variant);
    const n = hits(g);
    if (n < least) {
      best = g;
      least = n;
    }
  }
  return best;
}

function buildCourse(
  points: readonly Vec2[],
  width: number,
  meander: number,
  seed: number,
  clip: ChasmClip,
  wander: number | undefined,
  variant: number,
): ChasmGeometry {
  const opts = { wander };
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
  // generator 3: a long course strays visibly from the line between its ends (about a fifth of its length, at least
  // two bends), and its width changes by a cell here and there
  if (opts.wander !== undefined && total > 8) {
    const a0 = pts[0] as [number, number];
    const z0 = pts[pts.length - 1] as [number, number];
    const cdx = z0[0] - a0[0];
    const cdy = z0[1] - a0[1];
    const chord = Math.sqrt(cdx * cdx + cdy * cdy);
    if (chord > 6) {
      const ux = cdx / chord;
      const uy = cdy / chord;
      const px = -uy;
      const py = ux;
      const phase =
        h32(`${seed}:wander:phase`) / 4294967296 + (variant >> 1) * 0.29 + (variant & 1 ? 0.5 : 0);
      const freq = 1.5 + (h32(`${seed}:wander:freq`) / 4294967296) * 0.75; // 1.5 .. 2.25 waves
      const grain = new ValueNoise(subSeed(seed, "wander"));
      const target = opts.wander * chord;
      const edge = 1.5;
      const place = (amplitude: number): Array<[number, number]> =>
        samples.map((c, k) => {
          const s = total > 0 ? (total * k) / n : 0;
          const u = total > 0 ? s / total : 0;
          const env = Math.sqrt(Math.max(0, 4 * u * (1 - u)));
          const e =
            amplitude *
            env *
            (0.78 * wave(freq * u + phase) + 0.22 * Math.max(-1, Math.min(1, (grain.sample(s / 3.5, 1.5) - 0.5) * 3.2)));
          // keep the interior of the course inside the board (the ends stay where the plan put them)
          const x = c.x + px * e;
          const y = c.y + py * e;
          return env > 0.2
            ? [
                Math.max(clip.x0 + edge, Math.min(clip.x1 + 1 - edge, x)),
                Math.max(clip.y0 + edge, Math.min(clip.y1 + 1 - edge, y)),
              ]
            : [x, y];
        });
      const strayOf = (q: Array<[number, number]>): number => {
        let m = 0;
        for (const p of q) m = Math.max(m, Math.abs((p[0] - a0[0]) * px + (p[1] - a0[1]) * py));
        return m;
      };
      let best = place(0);
      let bestStray = strayOf(best);
      for (let amplitude = 0.25; bestStray < target && amplitude <= 0.45 * chord; amplitude += 0.25) {
        const q = place(amplitude);
        const m = strayOf(q);
        if (m > bestStray) {
          best = q;
          bestStray = m;
        }
      }
      // re-sample the displaced line every half cell of its own length, with tangents from the line itself
      const cum = [0];
      for (let k = 1; k < best.length; k++) {
        const p = best[k - 1] as [number, number];
        const q = best[k] as [number, number];
        cum.push((cum[k - 1] as number) + Math.sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1])));
      }
      const len2 = cum[cum.length - 1] as number;
      const m2 = Math.max(1, Math.ceil(len2 / 0.5));
      const pos: Array<[number, number, number]> = [];
      let j = 0;
      for (let k = 0; k <= m2; k++) {
        const s = (len2 * k) / m2;
        while (j < cum.length - 2 && (cum[j + 1] as number) < s) j++;
        const p = best[j] as [number, number];
        const q = best[j + 1] as [number, number];
        const span = (cum[j + 1] as number) - (cum[j] as number);
        const f = span > 0 ? Math.min(1, Math.max(0, (s - (cum[j] as number)) / span)) : 0;
        pos.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, s]);
      }
      samples.length = 0;
      halfL.length = 0;
      halfR.length = 0;
      const mb = Math.max(meander, 0.5);
      for (let k = 0; k < pos.length; k++) {
        const p = pos[k] as [number, number, number];
        const prev = pos[Math.max(0, k - 2)] as [number, number, number];
        const next = pos[Math.min(pos.length - 1, k + 2)] as [number, number, number];
        const dx = next[0] - prev[0];
        const dy = next[1] - prev[1];
        const dl = Math.sqrt(dx * dx + dy * dy) || 1;
        samples.push({ x: p[0], y: p[1], tx: dx / dl, ty: dy / dl });
        const taper = Math.min(1, 0.45 + (0.55 * Math.min(p[2], len2 - p[2])) / 5);
        const bank = (v: number): number =>
          Math.min(
            width * 0.8,
            Math.max(0.5, (width / 2) * taper * (1 + Math.max(-0.8, Math.min(0.8, mb * 1.6 * (v - 0.5) * 2)))),
          );
        halfL.push(bank(left.sample(p[2] / 2.5, 2.5)));
        halfR.push(bank(right.sample(p[2] / 2.5, 4.5)));
      }
    }
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
  // generator 3: ragged edges. A diagonal course rasters to a regular staircase; chamfer some corner cells of the rim
  // and bump out a few single cells, from a hash of the cell, so the outline stops reading as square steps. Corner cells
  // only (two perpendicular cut neighbours), so no neck is ever cut and the channel stays one body.
  if (opts.wander !== undefined && total > 8) {
    const snap = new Set(cut);
    const inSnap = (x: number, y: number): boolean => snap.has(`${x},${y}`);
    const dropped: string[] = [];
    const bumped: string[] = [];
    for (const k of snap) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const e = inSnap(x + 1, y);
      const w = inSnap(x - 1, y);
      const s = inSnap(x, y + 1);
      const n = inSnap(x, y - 1);
      const count = +e + +w + +s + +n;
      const corner = count === 2 && (e || w) && (s || n);
      if (corner && h32(`${seed}:rag:d:${x}:${y}`) % 100 < 45) dropped.push(k);
    }
    const seen = new Set<string>();
    for (const k of snap) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        const nk = `${nx},${ny}`;
        if (snap.has(nk) || seen.has(nk) || nx < clip.x0 || nx > clip.x1 || ny < clip.y0 || ny > clip.y1) continue;
        seen.add(nk);
        const m = +inSnap(nx + 1, ny) + +inSnap(nx - 1, ny) + +inSnap(nx, ny + 1) + +inSnap(nx, ny - 1);
        if (m === 1 && h32(`${seed}:rag:b:${nx}:${ny}`) % 100 < 20) bumped.push(nk);
      }
    }
    for (const k of dropped) cut.delete(k);
    for (const k of bumped) cut.add(k);
    // the crack stays one body: keep the largest 4-connected piece (a chamfer at a one-cell neck can orphan cells)
    const left = new Set(cut);
    let keep: string[] = [];
    for (const start of left) {
      if (!left.has(start)) continue;
      left.delete(start);
      const comp = [start];
      for (let q = 0; q < comp.length; q++) {
        const [x, y] = (comp[q] as string).split(",").map(Number) as [number, number];
        for (const nk of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`])
          if (left.delete(nk)) comp.push(nk);
      }
      if (comp.length > keep.length) keep = comp;
    }
    cut.clear();
    for (const k of keep) cut.add(k);
  }
  const cells = [...cut]
    .map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { cells, samples, widths: halfL.map((l, k) => l + (halfR[k] as number)) };
}

/** Sample at fraction `at` (0..1) of the course. */
export function chasmSampleAt(g: ChasmGeometry, at: number): ChasmSample | null {
  if (g.samples.length === 0) return null;
  const k = Math.round(Math.min(1, Math.max(0, at)) * (g.samples.length - 1));
  return g.samples[k] ?? null;
}
