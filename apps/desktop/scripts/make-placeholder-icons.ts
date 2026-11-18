/**
 * Generates PLACEHOLDER app icons (a simple maze-like geometric mark) with no dependencies:
 *   build/icon.png            512x512 (electron-builder fallback / Linux)
 *   build/icon.ico            16, 24, 32, 48, 64, 128, 256 (PNG-compressed ICO entries)
 *   build/icons/<n>x<n>.png   16 … 512 (Linux AppImage)
 * Run: npm run icons -w @slabyrinth/desktop. Real icon design comes later (WP5/WP6).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

type Rgba = readonly [number, number, number, number];

// Placeholder palette for the icon only (the app UI takes colours from theme tokens).
const BG: Rgba = [20, 22, 26, 255];
const FG: Rgba = [217, 181, 108, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** Colour of the mark at normalised coordinates (u, v) in [0, 1). */
function sample(u: number, v: number): Rgba {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  // Rounded-square tile.
  const r = 0.22;
  const qx = Math.max(Math.abs(x) - (1 - r), 0);
  const qy = Math.max(Math.abs(y) - (1 - r), 0);
  if (qx * qx + qy * qy > r * r) return CLEAR;
  // Three concentric square rings, each with one gap, rotating like a labyrinth.
  const d = Math.max(Math.abs(x), Math.abs(y));
  const rings = [0.72, 0.5, 0.28];
  const half = 0.055;
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i] ?? 0;
    if (Math.abs(d - ring) < half) {
      const gapAlongX = i % 2 === 0;
      const gapSign = i === 1 ? -1 : 1;
      const onGapSide = gapAlongX
        ? Math.sign(y) === gapSign && Math.abs(y) > Math.abs(x)
        : Math.sign(x) === gapSign && Math.abs(x) > Math.abs(y);
      const along = gapAlongX ? x : y;
      if (onGapSide && Math.abs(along) < 0.12) return BG;
      return FG;
    }
  }
  if (d < 0.1) return FG; // centre stone
  return BG;
}

function renderRgba(size: number): Uint8Array {
  const ss = 4; // supersampling for anti-aliasing
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (ss * ss));
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number): Buffer {
  const rgba = renderRgba(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function encodeIco(sizes: number[]): Buffer {
  const images = sizes.map((s) => encodePng(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const img = images[i] ?? Buffer.alloc(0);
    const o = i * 16;
    dir[o] = s >= 256 ? 0 : s;
    dir[o + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(img.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.length;
  });
  return Buffer.concat([header, dir, ...images]);
}

const buildDir = fileURLToPath(new URL("../build/", import.meta.url));
mkdirSync(`${buildDir}icons`, { recursive: true });
writeFileSync(`${buildDir}icon.png`, encodePng(512));
writeFileSync(`${buildDir}icon.ico`, encodeIco([16, 24, 32, 48, 64, 128, 256]));
for (const s of [16, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(`${buildDir}icons/${String(s)}x${String(s)}.png`, encodePng(s));
}
process.stdout.write(`Placeholder icons written to ${buildDir}\n`);
