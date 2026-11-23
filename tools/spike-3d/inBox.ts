/**
 * Research: lists the pieces stored inside a plan box and height band, with each piece's mesh height range there.
 * Usage: inBox <slab.txt> <cacheDir> x0,z0,x1,z1 y0,y1
 */
import { readFileSync } from "node:fs";
import { loadCatalog, PieceLibrary } from "./pieces";
import { slabScene } from "./scene";

const [file, cacheDir, boxArg, yArg] = process.argv.slice(2);
if (!file || !cacheDir || !boxArg || !yArg) throw new Error("usage: inBox <slab> <cache> x0,z0,x1,z1 y0,y1");
const [x0, z0, x1, z1] = boxArg.split(",").map(Number) as [number, number, number, number];
const [y0, y1] = yArg.split(",").map(Number) as [number, number];
const lib = new PieceLibrary(loadCatalog(), cacheDir);
const { placed } = slabScene(readFileSync(file, "utf8"), lib);
const rows = new Map<string, { n: number; lo: number; hi: number; ex: string }>();
for (const p of placed) {
  const [x, y, z] = p.pos;
  if (x < x0 || x > x1 || z < z0 || z > z1 || y < y0 || y > y1) continue;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < p.mesh.positions.length; i += 3) {
    lo = Math.min(lo, p.mesh.positions[i]!);
    hi = Math.max(hi, p.mesh.positions[i]!);
  }
  const k = `${p.name} rot ${p.rot} stored y ${y}`;
  const r = rows.get(k) ?? { n: 0, lo, hi, ex: `(${x},${z})` };
  r.n++;
  rows.set(k, r);
}
for (const [k, r] of [...rows].sort()) console.log(`${k}: ${r.n}×, mesh y ${r.lo.toFixed(2)}..${r.hi.toFixed(2)} e.g. ${r.ex}`);
