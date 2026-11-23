/**
 * Research prototype of a mesh-based check: in a slab, every pair of "Ship bottom" hull tiles whose boxes touch along
 * a face is scored by how well their cross-sections match at that face (mean nearest distance, tiles; about 0.0-0.15
 * = closed, above 0.3 = a visible step or gap). Usage: hullCheck <slab.txt> <cacheDir>
 */
import { readFileSync } from "node:fs";
import { decode } from "../../packages/core/src/slab";
import { loadCatalog, PieceLibrary } from "./pieces";
import { placePositions, rotY } from "./scene";

const [file, cacheDir] = process.argv.slice(2);
if (!file || !cacheDir) throw new Error("usage: hullCheck <slab.txt> <cacheDir>");
const lib = new PieceLibrary(loadCatalog(), cacheDir);
interface Hull {
  name: string;
  rot: number;
  box: [number, number, number, number]; // x0, z0, x1, z1
  P: Float32Array;
  I: Uint32Array;
}
const hulls: Hull[] = [];
for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()))
  for (const a of decode(line.trim()).assets) {
    const g = lib.piece(a.uuid);
    if (!g || !/^Ship bottom/.test(g.entry.name)) continue;
    const e = g.entry;
    const r = rotY(a.rot);
    const [wx, wz] = r(e.extent[0] * 2, e.extent[2] * 2).map(Math.abs) as [number, number];
    const x0 = a.sx / 100;
    const z0 = a.sz / 100;
    hulls.push({
      name: e.name.replace("Ship bottom ", "").replace("_Port and Starboard", ""),
      rot: a.rot,
      box: [x0, z0, x0 + wx, z0 + wz],
      P: placePositions(g, a.rot, [x0, a.sy / 100, z0]),
      I: g.indices,
    });
  }

type Pts = Array<[number, number]>;
function section(P: Float32Array, I: Uint32Array, axis: 0 | 2, v: number, lo: number, hi: number): Pts {
  const b = axis === 0 ? 2 : 0;
  const out: Pts = [];
  for (let t = 0; t < I.length; t += 3) {
    const pts: Pts = [];
    for (let k = 0; k < 3; k++) {
      const i0 = I[t + k]! * 3;
      const i1 = I[t + ((k + 1) % 3)]! * 3;
      const d0 = P[i0 + axis]! - v;
      const d1 = P[i1 + axis]! - v;
      if ((d0 <= 0 && d1 > 0) || (d0 > 0 && d1 <= 0)) {
        const s = d0 / (d0 - d1);
        pts.push([P[i0 + b]! + s * (P[i1 + b]! - P[i0 + b]!), P[i0 + 1]! + s * (P[i1 + 1]! - P[i0 + 1]!)]);
      }
    }
    if (pts.length === 2) {
      const [[h0, y0], [h1, y1]] = pts as [[number, number], [number, number]];
      const n = Math.ceil(Math.hypot(h1 - h0, y1 - y0) * 20) + 1;
      for (let i = 0; i <= n; i++) {
        const h = h0 + ((h1 - h0) * i) / n;
        if (h >= lo && h <= hi) out.push([h, y0 + ((y1 - y0) * i) / n]);
      }
    }
  }
  return out;
}
function meanNearest(a: Pts, b: Pts): number {
  if (!a.length || !b.length) return a.length || b.length ? 3 : 0;
  let s = 0;
  for (const p of a) {
    let best = 3;
    for (const q of b) {
      const d = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
      if (d < best) best = d;
    }
    s += best;
  }
  return s / a.length;
}
const EPS = 0.03;
const results: Array<{ a: Hull; b: Hull; plane: string; score: number }> = [];
for (let i = 0; i < hulls.length; i++)
  for (let j = 0; j < hulls.length; j++) {
    if (i === j) continue;
    const A = hulls[i]!;
    const B = hulls[j]!;
    // A's east face against B's west face, or A's north face against B's south face
    if (Math.abs(A.box[2] - B.box[0]) < 0.02) {
      const lo = Math.max(A.box[1], B.box[1]);
      const hi = Math.min(A.box[3], B.box[3]);
      if (hi - lo < 0.5) continue;
      const v = A.box[2];
      const sa = section(A.P, A.I, 0, v - EPS, lo, hi);
      const sb = section(B.P, B.I, 0, v + EPS, lo, hi);
      results.push({ a: A, b: B, plane: `x=${v}`, score: (meanNearest(sa, sb) + meanNearest(sb, sa)) / 2 });
    }
    if (Math.abs(A.box[3] - B.box[1]) < 0.02) {
      const lo = Math.max(A.box[0], B.box[0]);
      const hi = Math.min(A.box[2], B.box[2]);
      if (hi - lo < 0.5) continue;
      const v = A.box[3];
      const sa = section(A.P, A.I, 2, v - EPS, lo, hi);
      const sb = section(B.P, B.I, 2, v + EPS, lo, hi);
      results.push({ a: A, b: B, plane: `z=${v}`, score: (meanNearest(sa, sb) + meanNearest(sb, sa)) / 2 });
    }
  }
const interesting = results.filter((r) => !(/^side/.test(r.a.name) && /^side/.test(r.b.name)));
const sideSide = results.filter((r) => /^side/.test(r.a.name) && /^side/.test(r.b.name));
console.log(
  `${hulls.length} hull tiles; ${sideSide.length} side-to-side seams, worst ${Math.max(0, ...sideSide.map((r) => r.score)).toFixed(3)}`,
);
for (const r of interesting.sort((x, y) => y.score - x.score))
  console.log(
    `  ${r.score >= 0.3 ? "OPEN  " : r.score >= 0.16 ? "rough " : "closed"} ${r.score.toFixed(3)}  ${r.a.name} rot ${r.a.rot} [${r.a.box.join(",")}] | ${r.b.name} rot ${r.b.rot} [${r.b.box.join(",")}] at ${r.plane}`,
  );
