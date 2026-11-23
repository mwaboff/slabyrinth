/**
 * Research: which rotations of the ship kit's bow and stern halves close a hull. Places hull sides for a ship whose
 * bow points NORTH (port side rot 6, starboard rot 18; both verified to put the planked outer face outboard) and
 * scores every candidate (piece, rotation) in the bow and stern slots by how well its cross-section at the shared
 * seam plane matches its neighbour's (mean nearest distance between the two section curves, in tiles; 0 = identical).
 * Usage: closure <cacheDir>
 */
import { loadCatalog, PieceLibrary, type PieceGeometry } from "./pieces";
import { placePositions } from "./scene";

const [cacheDir] = process.argv.slice(2);
if (!cacheDir) throw new Error("usage: closure <cacheDir>");
const lib = new PieceLibrary(loadCatalog(), cacheDir);
const byName = (n: string): PieceGeometry => {
  for (const e of lib.catalog.values()) if (e.name === n) return lib.piece(e.id)!;
  throw new Error(`no ${n}`);
};
const SIDE = byName("Ship bottom side 4x2_Port and Starboard");
const PIECES: Record<string, PieceGeometry> = {
  L_Bow: byName("Ship bottom front L_Bow"),
  R_Bow: byName("Ship bottom front R_Bow"),
  L_Stern: byName("Ship bottom back L_Stern"),
  R_Stern: byName("Ship bottom back R_Stern"),
  Filler: byName("Ship bottom front filler 4x2_Bow"),
  Fin: byName("Ship bottom back Fin 4x2_Rudder"),
};

type Pts = Array<[number, number]>;
/** Points (h, y) of the mesh's section by the plane axis = v (axis 0 = x, 2 = z); h is the other horizontal axis. */
function section(P: Float32Array, I: Uint32Array, axis: 0 | 2, v: number): Pts {
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
      for (let i = 0; i <= n; i++) out.push([h0 + ((h1 - h0) * i) / n, y0 + ((y1 - y0) * i) / n]);
    }
  }
  return out;
}
function meanNearest(a: Pts, b: Pts): number {
  if (!a.length || !b.length) return Infinity;
  const cell = 0.1;
  const grid = new Map<string, Pts>();
  for (const p of b) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(p);
  }
  let sum = 0;
  for (const p of a) {
    let best = Infinity;
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let r = 0; r < 30 && best > r * cell; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
        }
    sum += Math.min(best, 3);
  }
  return sum / a.length;
}
const seam = (a: Pts, b: Pts): number => (meanNearest(a, b) + meanNearest(b, a)) / 2;
const place = (g: PieceGeometry, rot: number, x: number, z: number): Float32Array => placePositions(g, rot, [x, 0, z]);
const EPS = 0.03;

// Sides: port x 0..4, starboard x 4..8 (beam 8), z 0..2.
const sideP = place(SIDE, 6, 0, 0);
const sideS = place(SIDE, 18, 4, 0);
const sideNorthP = section(sideP, SIDE.indices, 2, 2 - EPS);
const sideNorthS = section(sideS, SIDE.indices, 2, 2 - EPS);
const sideSouthP = section(sideP, SIDE.indices, 2, EPS);
const sideSouthS = section(sideS, SIDE.indices, 2, EPS);
console.log("Sanity: the two sides against each other at the keel seam x=4:", seam(section(sideP, SIDE.indices, 0, 4 - EPS), section(sideS, SIDE.indices, 0, 4 + EPS)).toFixed(3));
console.log("Sanity: port side against a copy one slot north (z=2):", seam(sideNorthP, section(place(SIDE, 6, 0, 2), SIDE.indices, 2, 2 + EPS)).toFixed(3));

const rots = [0, 6, 12, 18];
const rows: Array<{ slot: string; piece: string; rot: number; score: number }> = [];
const slots = [
  { slot: "bow port (x0-4, z2-6)", x: 0, z: 2, plane: 2 + EPS, ref: sideNorthP, names: ["L_Bow", "R_Bow"] },
  { slot: "bow stbd (x4-8, z2-6)", x: 4, z: 2, plane: 2 + EPS, ref: sideNorthS, names: ["L_Bow", "R_Bow"] },
  { slot: "stern port (x0-4, z-4-0)", x: 0, z: -4, plane: -EPS, ref: sideSouthP, names: ["L_Stern", "R_Stern"] },
  { slot: "stern stbd (x4-8, z-4-0)", x: 4, z: -4, plane: -EPS, ref: sideSouthS, names: ["L_Stern", "R_Stern"] },
];
const best = new Map<string, { piece: string; rot: number; P: Float32Array; g: PieceGeometry }>();
for (const s of slots) {
  for (const n of s.names)
    for (const r of rots) {
      const g = PIECES[n]!;
      const P = place(g, r, s.x, s.z);
      const score = seam(s.ref, section(P, g.indices, 2, s.plane));
      rows.push({ slot: s.slot, piece: n, rot: r, score });
      const cur = best.get(s.slot);
      if (!cur || score < rows.find((x) => x.slot === s.slot && x.piece === cur.piece && x.rot === cur.rot)!.score)
        best.set(s.slot, { piece: n, rot: r, P, g });
    }
}
for (const s of slots) {
  console.log(`\n${s.slot}: seam against the hull side (lower is better)`);
  for (const r of rows.filter((x) => x.slot === s.slot).sort((a, b) => a.score - b.score))
    console.log(`  ${r.piece.padEnd(8)} rot ${String(r.rot).padStart(2)}: ${r.score.toFixed(3)}`);
}
// centreline seams of the best pairs
const bp = best.get(slots[0]!.slot)!;
const bs = best.get(slots[1]!.slot)!;
const sp = best.get(slots[2]!.slot)!;
const ss = best.get(slots[3]!.slot)!;
console.log(
  `\nBest bow: port ${bp.piece} rot ${bp.rot}, starboard ${bs.piece} rot ${bs.rot}; their centreline seam x=4: ${seam(section(bp.P, bp.g.indices, 0, 4 - EPS), section(bs.P, bs.g.indices, 0, 4 + EPS)).toFixed(3)}`,
);
console.log(
  `Best stern: port ${sp.piece} rot ${sp.rot}, starboard ${ss.piece} rot ${ss.rot}; their centreline seam x=4: ${seam(section(sp.P, sp.g.indices, 0, 4 - EPS), section(ss.P, ss.g.indices, 0, 4 + EPS)).toFixed(3)}`,
);

// Beam 10: filler (bow) and fin (stern) in the middle (x 4..6), starboard halves moved to x 6..10.
console.log("\nBeam 10 (centre strip x4-6): filler/fin seams with the best halves");
for (const [name, z, half, halfS] of [
  ["Filler", 2, bp, bs],
  ["Fin", -4, sp, ss],
] as const) {
  const g = PIECES[name]!;
  const Ps = place(halfS.g, halfS.rot, 6, z);
  for (const r of [0, 6, 12, 18]) {
    const P = place(g, r, 4, z);
    const w = seam(section(half.P, half.g.indices, 0, 4 - EPS), section(P, g.indices, 0, 4 + EPS));
    const e = seam(section(P, g.indices, 0, 6 - EPS), section(Ps, halfS.g.indices, 0, 6 + EPS));
    console.log(`  ${name} rot ${String(r).padStart(2)}: west seam ${w.toFixed(3)}, east seam ${e.toFixed(3)}`);
  }
}

// Runner-up pairs (the diagonal-symmetric alternatives): centreline seams.
console.log("\nRunner-up pairs, centreline seam x=4:");
for (const [a, ra, b, rb, z] of [
  ["R_Bow", 6, "L_Bow", 18, 2],
  ["L_Bow", 12, "L_Bow", 18, 2],
  ["R_Bow", 6, "R_Bow", 12, 2],
  ["R_Stern", 18, "L_Stern", 6, -4],
  ["L_Stern", 12, "L_Stern", 6, -4],
] as const) {
  const ga = PIECES[a]!;
  const gb = PIECES[b]!;
  const Pa = place(ga, ra, 0, z);
  const Pb = place(gb, rb, 4, z);
  console.log(
    `  port ${a} rot ${ra} + stbd ${b} rot ${rb}: ${seam(section(Pa, ga.indices, 0, 4 - EPS), section(Pb, gb.indices, 0, 4 + EPS)).toFixed(3)}`,
  );
}

// Tie-breaker: the centre strips (filler, fin) against the runner-up (diagonal-mirror) halves.
console.log("\nCentre strips against the runner-up halves (beam 10):");
for (const [name, z, a, ra, b, rb] of [
  ["Filler", 2, "R_Bow", 6, "L_Bow", 18],
  ["Fin", -4, "R_Stern", 18, "L_Stern", 6],
] as const) {
  const g = PIECES[name]!;
  const Pa = place(PIECES[a]!, ra, 0, z);
  const Pb = place(PIECES[b]!, rb, 6, z);
  for (const r of [0, 6, 12, 18]) {
    const P = place(g, r, 4, z);
    const w = seam(section(Pa, PIECES[a]!.indices, 0, 4 - EPS), section(P, g.indices, 0, 4 + EPS));
    const e = seam(section(P, g.indices, 0, 6 - EPS), section(Pb, PIECES[b]!.indices, 0, 6 + EPS));
    console.log(`  ${name} rot ${String(r).padStart(2)} between ${a} ${ra} / ${b} ${rb}: west ${w.toFixed(3)}, east ${e.toFixed(3)}`);
  }
}

// Rails on the gunwale: how well each rail rotation's foot sits on the hull's rim top (plan distance, tiles).
const curved = byName("Ship fence bow curved");
const sideRail = byName("Ship fence side 2x1");
function footprint(P: Float32Array, yLo: number, yHi: number): Pts {
  const out: Pts = [];
  for (let i = 0; i < P.length; i += 3) if (P[i + 1]! >= yLo && P[i + 1]! <= yHi) out.push([P[i]!, P[i + 2]!]);
  return out;
}
console.log("\nRails: rail foot (y<0.15) against the hull rim top (y>4.85), mean plan distance (lower = sits on it)");
for (const [label, base, br, rail, rails] of [
  ["port bow L_Bow rot 12", PIECES.L_Bow!, 12, curved, [0, 6, 12, 18]],
  ["stbd bow R_Bow rot 12", PIECES.R_Bow!, 12, curved, [0, 6, 12, 18]],
] as const) {
  const rim = footprint(place(base, br, 0, 0), 4.85, 9);
  for (const r of rails) {
    const P = placePositions(rail, r, [0, 5, 0]);
    console.log(`  ${label}: curved fence rot ${String(r).padStart(2)}: ${meanNearest(footprint(P, 5, 5.15), rim).toFixed(3)}`);
  }
}
{
  const rim = footprint(place(SIDE, 6, 0, 0), 4.85, 9);
  for (const [rx, rz, r] of [
    [0, 0, 6],
    [0, 0, 18],
    [3.5, 0, 6],
    [3.5, 0, 18],
  ] as const) {
    const P = placePositions(sideRail, r, [rx, 5, rz]);
    console.log(`  port side rot 6: side rail rot ${r} at x ${rx}: ${meanNearest(footprint(P, 5, 5.15), rim).toFixed(3)}`);
  }
}
