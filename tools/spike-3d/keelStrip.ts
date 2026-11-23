/**
 * Research: can a beam-10 hull (bow filler and rudder fin in the middle) be closed along the midship keel gap
 * (x 4..6) by a flat kit floor laid at the keel? Scores the seams of each candidate strip with the hull sides
 * (x = 4 and x = 6) and with the filler (bow end) and fin (stern end). Bow north. Usage: keelStrip <cacheDir>
 */
import { loadCatalog, PieceLibrary, type PieceGeometry } from "./pieces";
import { placePositions } from "./scene";

const [cacheDir] = process.argv.slice(2);
if (!cacheDir) throw new Error("usage: keelStrip <cacheDir>");
const lib = new PieceLibrary(loadCatalog(), cacheDir);
const byName = (n: string): PieceGeometry => {
  for (const e of lib.catalog.values()) if (e.name === n) return lib.piece(e.id)!;
  throw new Error(n);
};
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
const ext = (p: Pts): string => {
  if (!p.length) return "nothing";
  const ys = p.map((q) => q[1]);
  return `y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`;
};
const side = byName("Ship bottom side 4x2_Port and Starboard");
const sideP = placePositions(side, 6, [0, 0, 0]);
const sideS = placePositions(side, 18, [6, 0, 0]);
const EPS = 0.03;
console.log("Keel edge of the port side (x=4-ε), z 0..2:", ext(section(sideP, side.indices, 0, 4 - EPS, 0, 2)));
console.log("Keel edge of the starboard side (x=6+ε):", ext(section(sideS, side.indices, 0, 6 + EPS, 0, 2)));
const filler = byName("Ship bottom front filler 4x2_Bow");
const fin = byName("Ship bottom back Fin 4x2_Rudder");
const fP = placePositions(filler, 12, [4, 0, 2]);
const nP = placePositions(fin, 0, [4, 0, -4]);
console.log("Filler's aft face (z=2+ε), x 4..6:", ext(section(fP, filler.indices, 2, 2 + EPS, 4, 6)));
console.log("Fin's forward face (z=0-ε), x 4..6:", ext(section(nP, fin.indices, 2, -EPS, 4, 6)));
for (const n of ["Ship base floor 2x2", "Ship floor 2x2", "Ship floor 1x1", "Ship base floor 1x1"]) {
  let g: PieceGeometry;
  try {
    g = byName(n);
  } catch {
    continue;
  }
  const P = placePositions(g, 0, [4, 0, 0]);
  console.log(
    `${n}: at its west edge (x=4+ε) ${ext(section(P, g.indices, 0, 4 + EPS, 0, 2))}; box height ${(g.entry.extent[1] * 2).toFixed(2)}`,
  );
}
