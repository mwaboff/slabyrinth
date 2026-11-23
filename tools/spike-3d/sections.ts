/**
 * Research: vertical cross-sections of a piece (rot 0, asset frame) at chosen planes, as ASCII, to tell which edge
 * of a hull piece mates with which. Usage: sections <cacheDir> <name regex> <x=… | z=…> [more planes]
 */
import { join } from "node:path";
import { loadCatalog, PieceLibrary } from "./pieces";

const [cacheDir, pattern, ...planes] = process.argv.slice(2);
if (!cacheDir || !pattern || !planes.length) throw new Error("usage: sections <cacheDir> <regex> x=0.05 z=3.95");
const lib = new PieceLibrary(loadCatalog(), join(cacheDir));
const re = new RegExp(pattern, "i");
const PER = 6;
for (const e of lib.catalog.values()) {
  if (!re.test(e.name) || !/ship|boat/i.test(e.name)) continue;
  const g = lib.piece(e.id)!;
  console.log(`## ${e.name}`);
  for (const spec of planes) {
    const [axis, vs] = spec.split("=");
    const v = Number(vs);
    const a = axis === "x" ? 0 : 2; // plane axis
    const b = axis === "x" ? 2 : 0; // horizontal axis drawn left->right
    const W = 6 * PER + 1;
    const H = 6 * PER + 1;
    const grid = Array.from({ length: H }, () => Array<string>(W).fill("."));
    const P = g.positions;
    const I = g.indices;
    const plot = (h: number, y: number): void => {
      const c = Math.round((h + 0.5) * PER);
      const r = H - 1 - Math.round((y + 0.5) * PER);
      if (c >= 0 && c < W && r >= 0 && r < H) grid[r]![c] = "#";
    };
    for (let t = 0; t < I.length; t += 3) {
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < 3; k++) {
        const i0 = I[t + k]! * 3;
        const i1 = I[t + ((k + 1) % 3)]! * 3;
        const d0 = P[i0 + a]! - v;
        const d1 = P[i1 + a]! - v;
        if ((d0 <= 0 && d1 > 0) || (d0 > 0 && d1 <= 0)) {
          const s = d0 / (d0 - d1);
          pts.push([P[i0 + b]! + s * (P[i1 + b]! - P[i0 + b]!), P[i0 + 1]! + s * (P[i1 + 1]! - P[i0 + 1]!)]);
        }
      }
      if (pts.length === 2) {
        const [[h0, y0], [h1, y1]] = pts as [[number, number], [number, number]];
        const n = Math.ceil(Math.hypot(h1 - h0, y1 - y0) * PER * 2) + 1;
        for (let i = 0; i <= n; i++) plot(h0 + ((h1 - h0) * i) / n, y0 + ((y1 - y0) * i) / n);
      }
    }
    const horiz = axis === "x" ? "z (south left, north right)" : "x (west left, east right)";
    console.log(`section ${spec}: ${horiz}, y up; ${PER}/tile, frame -0.5..5.5`);
    console.log(grid.map((r) => r.join("")).join("\n"));
  }
}
