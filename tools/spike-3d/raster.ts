/**
 * Minimal software rasteriser: orthographic camera, z-buffer, flat two-sided Lambert shading, one colour per mesh.
 * Writes PNG through node:zlib. No GPU, no Electron.
 */
import { crc32, deflateSync } from "node:zlib";

export type V3 = [number, number, number];
export interface DrawMesh {
  /** World-space xyz triples (+x east, +y up, +z north). */
  positions: Float32Array;
  indices: Uint32Array;
  color: V3; // 0..1
}
export interface Camera {
  /** Unit vectors: screen right, screen up, and toward the viewer. */
  right: V3;
  up: V3;
  toViewer: V3;
}
export const TOP: Camera = { right: [1, 0, 0], up: [0, 0, 1], toViewer: [0, 1, 0] };

/** Camera on compass bearing `bearingDeg` from the scene (180 = from the south), `elevDeg` above the horizon. */
export function oblique(bearingDeg: number, elevDeg: number): Camera {
  const a = (bearingDeg * Math.PI) / 180;
  const e = (elevDeg * Math.PI) / 180;
  const d: V3 = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
  const r: V3 = [-Math.cos(a), 0, Math.sin(a)];
  // up = d x r ... computed as Y minus its projection on d, normalised
  const u: V3 = [-d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2]];
  const n = Math.hypot(...u);
  return { right: r, up: [u[0] / n, u[1] / n, u[2] / n], toViewer: d };
}

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** View depth per pixel (larger = nearer); -Infinity where empty. */
  depth: Float32Array;
  /** Index of the mesh drawn at each pixel, -1 where empty. */
  meshAt: Int32Array;
  /** World units per pixel. */
  unitsPerPx: number;
  /** World-space (right, up) of the image's top-left corner. */
  origin: [number, number];
}

export interface RenderOptions {
  width: number;
  /** Fixed world window (right/up extents) instead of fitting the scene. */
  window?: { r0: number; r1: number; u0: number; u1: number };
  background?: V3;
  light?: V3;
}

export function render(meshes: DrawMesh[], cam: Camera, opt: RenderOptions): Image {
  const { right: R, up: U, toViewer: F } = cam;
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  if (opt.window) ({ r0, r1, u0, u1 } = opt.window);
  else
    for (const m of meshes)
      for (let i = 0; i < m.positions.length; i += 3) {
        const x = m.positions[i]!;
        const y = m.positions[i + 1]!;
        const z = m.positions[i + 2]!;
        const sr = x * R[0] + y * R[1] + z * R[2];
        const su = x * U[0] + y * U[1] + z * U[2];
        if (sr < r0) r0 = sr;
        if (sr > r1) r1 = sr;
        if (su < u0) u0 = su;
        if (su > u1) u1 = su;
      }
  const pad = opt.window ? 0 : 0.02 * Math.max(r1 - r0, u1 - u0);
  r0 -= pad;
  r1 += pad;
  u0 -= pad;
  u1 += pad;
  const W = opt.width;
  const upp = (r1 - r0) / W;
  const H = Math.max(1, Math.ceil((u1 - u0) / upp));
  const rgba = new Uint8Array(W * H * 4);
  const bg = opt.background ?? [0.13, 0.13, 0.15];
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0] * 255;
    rgba[i * 4 + 1] = bg[1] * 255;
    rgba[i * 4 + 2] = bg[2] * 255;
    rgba[i * 4 + 3] = 255;
  }
  const depth = new Float32Array(W * H).fill(-Infinity);
  const meshAt = new Int32Array(W * H).fill(-1);
  const L0 = opt.light ?? [-0.45, 0.8, -0.35];
  const ln = Math.hypot(...L0);
  const L: V3 = [L0[0] / ln, L0[1] / ln, L0[2] / ln];
  const inv = 1 / upp;
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi]!;
    const P = m.positions;
    const nv = P.length / 3;
    const px = new Float32Array(nv);
    const py = new Float32Array(nv);
    const pz = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const x = P[i * 3]!;
      const y = P[i * 3 + 1]!;
      const z = P[i * 3 + 2]!;
      px[i] = (x * R[0] + y * R[1] + z * R[2] - r0) * inv;
      py[i] = (u1 - (x * U[0] + y * U[1] + z * U[2])) * inv;
      pz[i] = x * F[0] + y * F[1] + z * F[2];
    }
    const I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]!;
      const b = I[t + 1]!;
      const c = I[t + 2]!;
      // world normal for shading
      const ax = P[a * 3]!;
      const ay = P[a * 3 + 1]!;
      const az = P[a * 3 + 2]!;
      const e1x = P[b * 3]! - ax;
      const e1y = P[b * 3 + 1]! - ay;
      const e1z = P[b * 3 + 2]! - az;
      const e2x = P[c * 3]! - ax;
      const e2y = P[c * 3 + 1]! - ay;
      const e2z = P[c * 3 + 2]! - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz);
      if (nl === 0) continue;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const lit = 0.32 + 0.68 * Math.abs(nx * L[0] + ny * L[1] + nz * L[2]);
      const cr = Math.min(255, m.color[0] * lit * 255);
      const cg = Math.min(255, m.color[1] * lit * 255);
      const cb = Math.min(255, m.color[2] * lit * 255);
      const x0 = px[a]!;
      const y0 = py[a]!;
      const x1 = px[b]!;
      const y1 = py[b]!;
      const x2 = px[c]!;
      const y2 = py[c]!;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      const z0 = pz[a]!;
      const z1 = pz[b]!;
      const z2 = pz[c]!;
      const ia = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        const sy = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const sx = x + 0.5;
          const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) * ia;
          const w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) * ia;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * z0 + w1 * z1 + w2 * z2;
          const k = y * W + x;
          if (d <= depth[k]!) continue;
          depth[k] = d;
          meshAt[k] = mi;
          rgba[k * 4] = cr;
          rgba[k * 4 + 1] = cg;
          rgba[k * 4 + 2] = cb;
        }
      }
    }
  }
  return { width: W, height: H, rgba, depth, meshAt, unitsPerPx: upp, origin: [r0, u1] };
}

/** Draws a filled square marker (for labels) — tiny 3x5 digit font for bay numbers. */
const DIGITS = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
];
export function drawText(img: Image, text: string, x: number, y: number, scale: number, color: V3): void {
  let cx = x;
  for (const ch of text) {
    const g = DIGITS[Number(ch)] ?? (ch === "A" ? "010101111101101" : undefined);
    if (g) {
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++)
          if (g[r * 3 + c] === "1")
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++) {
                const px = cx + c * scale + dx;
                const py = y + r * scale + dy;
                if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
                const k = (py * img.width + px) * 4;
                img.rgba[k] = color[0] * 255;
                img.rgba[k + 1] = color[1] * 255;
                img.rgba[k + 2] = color[2] * 255;
              }
    }
    cx += 4 * scale;
  }
}

export function encodePng(img: { width: number; height: number; rgba: Uint8Array }): Buffer {
  const { width: W, height: H, rgba } = img;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
