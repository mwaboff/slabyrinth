/** Research: the cannon's barrel band (local frame) and the side rail's open band, to see whether a barrel clears the rail. */
import { loadCatalog, PieceLibrary } from "./pieces";
const lib = new PieceLibrary(loadCatalog(), process.argv[2]);
const find = (n: string) => lib.piece([...lib.catalog.values()].find((e) => e.name === n)!.id)!;
const c = find("ship cannon static");
let lo = Infinity, hi = -Infinity, zmin = Infinity;
for (let i = 0; i < c.positions.length; i += 3) {
  if (c.positions[i + 2]! < -0.95) { lo = Math.min(lo, c.positions[i + 1]!); hi = Math.max(hi, c.positions[i + 1]!); }
  zmin = Math.min(zmin, c.positions[i + 2]!);
}
console.log(`cannon muzzle end (local z < -0.95): y ${lo.toFixed(2)}..${hi.toFixed(2)}, muzzle at z ${zmin.toFixed(2)}`);
// rail: fraction of the rail's x-extent that is solid at each height (seen from the south), 0.05 bands
const r = find("Ship fence side 2x1");
const P = r.positions, I = r.indices;
for (let y = 0; y < 1.5; y += 0.1) {
  const cover = new Uint8Array(200);
  for (let t = 0; t < I.length; t += 3) {
    const ys = [0, 1, 2].map((k) => P[I[t + k]! * 3 + 1]!);
    if (Math.min(...ys) > y + 0.05 || Math.max(...ys) < y + 0.05) continue;
    const xs = [0, 1, 2].map((k) => P[I[t + k]! * 3]!);
    for (let x = Math.max(0, Math.floor(Math.min(...xs) * 100)); x < Math.min(200, Math.ceil(Math.max(...xs) * 100)); x++) cover[x] = 1;
  }
  console.log(`rail y ${y.toFixed(1)}-${(y + 0.1).toFixed(1)}: ${Math.round(cover.reduce((a, b) => a + b, 0) / 2)}% solid`);
}
