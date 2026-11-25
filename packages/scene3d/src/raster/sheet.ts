/**
 * Contact sheets: several pictures on one, each with a caption in a small built-in bitmap font (5×7 capitals, digits
 * and a little punctuation; lower case is drawn as capitals). Deterministic, no fonts or canvas needed.
 */
import type { Rgb } from "../types/index";

export interface Picture {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 5×7 glyphs, one 5-bit row each (top row first, leftmost pixel the high bit). */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ":": [0, 12, 12, 0, 12, 12, 0],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 4, 8],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  "/": [1, 1, 2, 4, 8, 16, 16],
  "°": [12, 18, 18, 12, 0, 0, 0],
  "%": [24, 25, 2, 4, 8, 19, 3],
  "'": [4, 4, 8, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  "#": [10, 10, 31, 10, 31, 10, 10],
  "?": [14, 17, 1, 2, 4, 0, 4],
};

/** Width of `text` in pixels at `scale` (6 columns per character). */
export const textWidth = (text: string, scale: number): number => text.length * 6 * scale;

/** Draws `text` with its top-left at (x, y). */
export function drawText(img: Picture, text: string, x: number, y: number, scale: number, rgb: Rgb): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = ch === " " ? undefined : (GLYPHS[ch] ?? GLYPHS["?"]);
    if (g)
      g.forEach((row, r) => {
        for (let c = 0; c < 5; c++) {
          if (((row >> (4 - c)) & 1) === 0) continue;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const px = cx + c * scale + dx;
              const py = y + r * scale + dy;
              if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
              const k = (py * img.width + px) * 4;
              img.rgba[k] = rgb[0];
              img.rgba[k + 1] = rgb[1];
              img.rgba[k + 2] = rgb[2];
              img.rgba[k + 3] = 255;
            }
        }
      });
    cx += 6 * scale;
  }
}

/** The picture made smaller by a whole factor (each output pixel the mean of a factor × factor block). */
export function downscale(img: Picture, factor: number): Picture {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const width = Math.max(1, Math.floor(img.width / f));
  const height = Math.max(1, Math.floor(img.height / f));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++)
          for (let dx = 0; dx < f; dx++)
            sum += img.rgba[((y * f + dy) * img.width + x * f + dx) * 4 + c] ?? 0;
        rgba[(y * width + x) * 4 + c] = Math.round(sum / (f * f));
      }
  return { width, height, rgba };
}

export interface SheetOptions {
  /** Each picture is made smaller (by a whole factor) until it is at most this wide (default 512). */
  tileWidth?: number;
  columns?: number;
  background?: Rgb;
  /** Caption scale (default 2: 14-pixel capitals). */
  textScale?: number;
}

const PAD = 8;

/** One picture of all `tiles`, in rows, each with its caption under it (cut to the tile's width). */
export function contactSheet(
  tiles: ReadonlyArray<{ picture: Picture; caption: string }>,
  o: SheetOptions = {},
): Picture {
  const maxW = o.tileWidth ?? 512;
  const scale = o.textScale ?? 2;
  const small = tiles.map((t) => ({
    picture: downscale(t.picture, Math.ceil(t.picture.width / maxW)),
    caption: t.caption,
  }));
  const columns = Math.max(1, o.columns ?? Math.ceil(Math.sqrt(small.length)));
  const cellW = small.reduce((m, t) => Math.max(m, t.picture.width), 1) + PAD;
  const captionH = 7 * scale + PAD;
  const cellH = small.reduce((m, t) => Math.max(m, t.picture.height), 1) + captionH + PAD;
  const rows = Math.max(1, Math.ceil(small.length / columns));
  const width = columns * cellW + PAD;
  const height = rows * cellH + PAD;
  const bg = o.background ?? [18, 19, 23];
  const rgba = new Uint8Array(width * height * 4);
  for (let k = 0; k < width * height; k++) {
    rgba[k * 4] = bg[0];
    rgba[k * 4 + 1] = bg[1];
    rgba[k * 4 + 2] = bg[2];
    rgba[k * 4 + 3] = 255;
  }
  const sheet: Picture = { width, height, rgba };
  small.forEach((t, i) => {
    const x0 = PAD + (i % columns) * cellW;
    const y0 = PAD + Math.floor(i / columns) * cellH;
    for (let y = 0; y < t.picture.height; y++)
      rgba.set(
        t.picture.rgba.subarray(y * t.picture.width * 4, (y + 1) * t.picture.width * 4),
        ((y0 + y) * width + x0) * 4,
      );
    const fits = Math.floor(t.picture.width / (6 * scale));
    const text = t.caption.length > fits ? `${t.caption.slice(0, Math.max(0, fits - 1))}.` : t.caption;
    drawText(sheet, text, x0, y0 + t.picture.height + PAD / 2, scale, [226, 226, 230]);
  });
  return sheet;
}
