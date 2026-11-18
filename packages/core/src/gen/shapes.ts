/**
 * Shape rasterizers (architecture §2.4 "Rasterization rule") and the organic generators blob and cave (§2.5).
 * A cell is inside a shape iff its centre (x+0.5, y+0.5) is inside, unless stated. Results are UNCLIPPED
 * masks in global cell coordinates; the resolver clips them to level bounds. `route` is not a free shape
 * (it needs area anchors) and is rasterized by the resolver with `routeCenterline` + `stampSquare`.
 */
import type { Shape, Vec2 } from "../contracts/plan";
import { canonicalJson } from "../util/canonical";
import { h32, subSeed } from "../util/hash";
import { createPrng } from "../util/prng";
import { type CellMask, emptyMask, keepComponent, maskFromPredicate, maskSet } from "./mask";
import { ValueNoise } from "./noise";

/**
 * Seed for a seeded shape (blob, cave). Explicit `shape.seed` wins; otherwise the seed is derived from the
 * plan seed and the shape's own canonical parameters, so two identical shape specs (e.g. a zone's blob and a
 * scatter `exclude` blob with the same numbers) always rasterize to the same cells.
 */
export function shapeSeed(planSeed: number, shape: Shape): number {
  if ((shape.type === "blob" || shape.type === "cave") && shape.seed !== undefined) return shape.seed >>> 0;
  return h32(`${planSeed}:shape:${canonicalJson(shape)}`);
}

export interface RasterContext {
  planSeed: number;
  /** Only cells inside this box (global, inclusive) are evaluated — keeps huge shapes cheap. */
  clip?: ClipBox;
}

/** Inclusive cell box. */
export interface ClipBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Intersects a cell box with an optional clip box. */
export function clipBox(x0: number, y0: number, x1: number, y1: number, clip?: ClipBox): ClipBox {
  return clip
    ? {
        x0: Math.max(x0, clip.x0),
        y0: Math.max(y0, clip.y0),
        x1: Math.min(x1, clip.x1),
        y1: Math.min(y1, clip.y1),
      }
    : { x0, y0, x1, y1 };
}

function maskIn(b: ClipBox, inside: (gx: number, gy: number) => boolean): CellMask {
  if (b.x1 < b.x0 || b.y1 < b.y0) return emptyMask(b.x0, b.y0, 0, 0);
  return maskFromPredicate(b.x0, b.y0, b.x1, b.y1, inside);
}

export function rasterizeShape(shape: Shape, ctx: RasterContext): CellMask {
  switch (shape.type) {
    case "rect":
      return rasterRect(shape.x, shape.y, shape.w, shape.h, ctx.clip);
    case "polygon":
      return rasterPolygon(shape.points, ctx.clip);
    case "circle":
      return rasterEllipse(shape.cx, shape.cy, shape.r, shape.r, ctx.clip);
    case "ellipse":
      return rasterEllipse(shape.cx, shape.cy, shape.rx, shape.ry, ctx.clip);
    case "blob":
      return generateBlob(
        shape.cx,
        shape.cy,
        shape.r,
        shape.roughness ?? 0.35,
        shapeSeed(ctx.planSeed, shape),
        ctx.clip,
      );
    case "cave":
      return generateCave(
        shape.x,
        shape.y,
        shape.w,
        shape.h,
        shape.fill ?? 0.45,
        shape.steps ?? 4,
        shapeSeed(ctx.planSeed, shape),
      );
    case "cells":
      return rasterCells(shape.x, shape.y, shape.rows);
    case "path":
      return rasterPolyline(shape.points, shape.width ?? 1, ctx.clip);
    case "route":
      return emptyMask(0, 0, 0, 0);
  }
}

export function rasterRect(x: number, y: number, w: number, h: number, clip?: ClipBox): CellMask {
  // centre rule: cell cx inside iff x <= cx + 0.5 < x + w
  const x0 = Math.ceil(x - 0.5);
  const y0 = Math.ceil(y - 0.5);
  const b = clipBox(x0, y0, Math.ceil(x + w - 0.5) - 1, Math.ceil(y + h - 0.5) - 1, clip);
  if (b.x1 < b.x0 || b.y1 < b.y0) return emptyMask(b.x0, b.y0, 0, 0);
  const m = emptyMask(b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
  m.bits.fill(1);
  return m;
}

/** Even-odd point-in-polygon at cell centres. Points are vertex coordinates. */
export function rasterPolygon(points: readonly Vec2[], clip?: ClipBox): CellMask {
  if (points.length < 3) return emptyMask(0, 0, 0, 0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  const n = points.length;
  return maskIn(
    clipBox(Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY), clip),
    (gx, gy) => {
      const tx = gx + 0.5;
      const ty = gy + 0.5;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = points[i] as Vec2;
        const [xj, yj] = points[j] as Vec2;
        if (yi > ty !== yj > ty) {
          const xCross = ((xj - xi) * (ty - yi)) / (yj - yi) + xi;
          if (tx < xCross) inside = !inside;
        }
      }
      return inside;
    },
  );
}

/** Circle when rx == ry: (dx/rx)² + (dy/ry)² ≤ 1 at cell centres; centre in continuous cell units. */
export function rasterEllipse(cx: number, cy: number, rx: number, ry: number, clip?: ClipBox): CellMask {
  if (rx <= 0 || ry <= 0) return emptyMask(0, 0, 0, 0);
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  return maskIn(
    clipBox(
      Math.floor(cx - rx) - 1,
      Math.floor(cy - ry) - 1,
      Math.ceil(cx + rx) + 1,
      Math.ceil(cy + ry) + 1,
      clip,
    ),
    (gx, gy) => {
      const dx = gx + 0.5 - cx;
      const dy = gy + 0.5 - cy;
      return dx * dx * ry2 + dy * dy * rx2 <= rx2 * ry2;
    },
  );
}

export function rasterCells(x: number, y: number, rows: readonly string[]): CellMask {
  const w = rows.reduce((a, r) => Math.max(a, r.length), 0);
  const m = emptyMask(x, y, w, rows.length);
  rows.forEach((row, ly) => {
    for (let lx = 0; lx < row.length; lx++) if (row[lx] === "#") m.bits[ly * w + lx] = 1;
  });
  return m;
}

/**
 * blob (§2.5): inside iff d² ≤ (r·(1 + roughness·(n − 0.5)))², n = value noise at scale max(2, r/2)
 * sampled at the cell centre relative to the blob centre (so moving a blob translates it intact).
 * Only the component containing the centre cell is kept.
 */
export function generateBlob(
  cx: number,
  cy: number,
  r: number,
  roughness: number,
  seed: number,
  clip?: ClipBox,
): CellMask {
  if (r <= 0) return emptyMask(0, 0, 0, 0);
  const noise = new ValueNoise(subSeed(seed, "blob"));
  const scale = Math.max(2, r / 2);
  const reach = r * (1 + roughness * 0.5) + 1;
  const m = maskIn(
    clipBox(
      Math.floor(cx - reach),
      Math.floor(cy - reach),
      Math.ceil(cx + reach),
      Math.ceil(cy + reach),
      clip,
    ),
    (gx, gy) => {
      const dx = gx + 0.5 - cx;
      const dy = gy + 0.5 - cy;
      const n = noise.sample(dx / scale, dy / scale);
      const rr = r * (1 + roughness * (n - 0.5));
      return dx * dx + dy * dy <= rr * rr;
    },
  );
  return keepComponent(m, [Math.floor(cx), Math.floor(cy)]);
}

/**
 * cave (§2.5): fill the rect with wall probability `fill` (row-major draws), run `steps` iterations of
 * B5678/S45678 on walls (Moore neighbourhood; outside the rect counts as wall), then keep the largest
 * 4-connected open region (ties: first in row-major order).
 */
export function generateCave(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: number,
  steps: number,
  seed: number,
): CellMask {
  const W = Math.max(0, Math.floor(w));
  const H = Math.max(0, Math.floor(h));
  const rng = createPrng(subSeed(seed, "cave"));
  let wall = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) wall[i] = rng.next() < fill ? 1 : 0;
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(W * H);
    for (let ly = 0; ly < H; ly++) {
      for (let lx = 0; lx < W; lx++) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = lx + dx;
            const ny = ly + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) count++;
            else count += wall[ny * W + nx] ?? 0;
          }
        }
        const i = ly * W + lx;
        next[i] = wall[i] === 1 ? (count >= 4 ? 1 : 0) : count >= 5 ? 1 : 0;
      }
    }
    wall = next;
  }
  const m = emptyMask(x, y, W, H);
  for (let i = 0; i < W * H; i++) m.bits[i] = wall[i] === 1 ? 0 : 1;
  return keepComponent(m);
}

/** Perpendicular offsets of a centred band of `width` cells: extra cell goes east/south for even widths. */
export function bandOffsets(width: number): [lo: number, hi: number] {
  const w = Math.max(1, Math.floor(width));
  const lo = -Math.floor((w - 1) / 2);
  return [lo, lo + w - 1];
}

/** 4-connected cell walk from a to b inclusive (ties step in x first). */
export function walkLine4(a: Vec2, b: Vec2): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x = a[0];
  let y = a[1];
  const dx = Math.abs(b[0] - x);
  const dy = Math.abs(b[1] - y);
  const sx = b[0] > x ? 1 : -1;
  const sy = b[1] > y ? 1 : -1;
  out.push([x, y]);
  let ix = 0;
  let iy = 0;
  while (ix < dx || iy < dy) {
    // compare (0.5+ix)/dx with (0.5+iy)/dy without division
    if (iy >= dy || (ix < dx && (1 + 2 * ix) * dy <= (1 + 2 * iy) * dx)) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    out.push([x, y]);
  }
  return out;
}

export function stampSquare(m: CellMask, cx: number, cy: number, lo: number, hi: number): void {
  for (let y = cy + lo; y <= cy + hi; y++) for (let x = cx + lo; x <= cx + hi; x++) maskSet(m, x, y);
}

/**
 * Thick polyline through cell centres (path shapes and terrain paths). Axis-aligned segments use the exact
 * rule (union of `width`-wide rectangles centred on the segment, extra cell east/south); interior joints get a
 * width×width square so corners are solid. Non-axis-aligned segments (allowed for terrain paths) walk a
 * 4-connected line with a width×width square brush, so the result stays 4-connected.
 */
export function rasterPolyline(points: readonly Vec2[], width: number, clip?: ClipBox): CellMask {
  if (points.length === 0) return emptyMask(0, 0, 0, 0);
  const [lo, hi] = bandOffsets(width);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  const box = clipBox(minX + lo, minY + lo, maxX + hi, maxY + hi, clip);
  const m = emptyMask(box.x0, box.y0, Math.max(0, box.x1 - box.x0 + 1), Math.max(0, box.y1 - box.y0 + 1));
  if (points.length === 1) {
    const p = points[0] as Vec2;
    stampSquare(m, p[0], p[1], lo, hi);
    return m;
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[i + 1] as Vec2;
    if (a[1] === b[1]) {
      for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++)
        for (let y = a[1] + lo; y <= a[1] + hi; y++) maskSet(m, x, y);
    } else if (a[0] === b[0]) {
      for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++)
        for (let x = a[0] + lo; x <= a[0] + hi; x++) maskSet(m, x, y);
    } else {
      for (const [x, y] of walkLine4(a, b)) stampSquare(m, x, y, lo, hi);
    }
    if (i > 0) stampSquare(m, a[0], a[1], lo, hi);
  }
  return m;
}

/**
 * path jitter (§2.5): subdivide each segment every ~3 cells and offset the interior subdivision points
 * perpendicular by round((n − 0.5)·2·jitter·width) cells, n = lattice noise per point. Endpoints stay put.
 */
export function jitterPolyline(points: readonly Vec2[], width: number, jitter: number, seed: number): Vec2[] {
  if (jitter <= 0 || points.length < 2) return points.map((p) => [p[0], p[1]] as const);
  const noise = new ValueNoise(subSeed(seed, "jitter"));
  const out: Vec2[] = [];
  const first = points[0] as Vec2;
  out.push([first[0], first[1]]);
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s] as Vec2;
    const b = points[s + 1] as Vec2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const pieces = Math.max(1, Math.round(len / 3));
    for (let k = 1; k < pieces; k++) {
      const n = noise.sample(s * 64 + k + 0.5, 0.5);
      const off = Math.round((n - 0.5) * 2 * jitter * width);
      const px = a[0] + (dx * k) / pieces + (len > 0 ? (-dy / len) * off : 0);
      const py = a[1] + (dy * k) / pieces + (len > 0 ? (dx / len) * off : 0);
      out.push([Math.round(px), Math.round(py)]);
    }
    out.push([b[0], b[1]]);
  }
  return out;
}

/** Route centerline: an L path of cells from a to b; bend "hv" walks the horizontal leg first. */
export function routeCenterline(a: Vec2, b: Vec2, bend: "hv" | "vh"): Array<[number, number]> {
  const corner: Vec2 = bend === "hv" ? [b[0], a[1]] : [a[0], b[1]];
  const leg1 = walkLine4(a, corner);
  const leg2 = walkLine4(corner, b);
  return [...leg1, ...leg2.slice(1)];
}
