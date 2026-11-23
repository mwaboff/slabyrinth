/** Research: the bowsprit spars' axis height at each end (mean of the end ring's vertices), local frame. */
import { loadCatalog, PieceLibrary } from "./pieces";
const lib = new PieceLibrary(loadCatalog(), process.argv[2]);
for (const n of ["Ship Bowsprit base", "Ship Bowsprit mid", "Ship Bowsprit top"]) {
  const g = lib.piece([...lib.catalog.values()].find((e) => e.name === n)!.id)!;
  const P = g.positions;
  let zlo = Infinity, zhi = -Infinity;
  for (let i = 0; i < P.length; i += 3) { zlo = Math.min(zlo, P[i + 2]!); zhi = Math.max(zhi, P[i + 2]!); }
  const ring = (z0: number, z1: number) => {
    let s = 0, n2 = 0, zs = 0;
    for (let i = 0; i < P.length; i += 3) if (P[i + 2]! >= z0 && P[i + 2]! <= z1 && Math.abs(P[i]!) < 0.4) { s += P[i + 1]!; zs += P[i + 2]!; n2++; }
    return n2 ? `axis y ${(s / n2).toFixed(2)} at z ${(zs / n2).toFixed(2)} (${n2} verts)` : "none";
  };
  console.log(`${n}: low end ${ring(zlo, zlo + 0.3)}; high end ${ring(zhi - 0.3, zhi)}`);
}
