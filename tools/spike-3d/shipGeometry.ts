/**
 * Research: per-piece geometry facts for the ship kit, at rot 0 in the asset's own frame (index part transforms
 * applied; +x east, +z north, +y up): mesh bounds against the collider box, area-weighted centroid, top and bottom
 * height maps as ASCII, and top + oblique PNGs. Writes into an output folder (git-ignored). READ-ONLY on the install.
 *
 * Usage: shipGeometry <outDir> <slab files...>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "../../packages/core/src/slab";
import { loadCatalog, PieceLibrary, type PieceGeometry } from "./pieces";
import { encodePng, oblique, render, TOP, type Camera } from "./raster";
import { hashColor } from "./scene";

const [outDir, ...slabs] = process.argv.slice(2);
if (!outDir || !slabs.length) throw new Error("usage: shipGeometry <outDir> <slab files...>");
const SHIP = /ship|boat|sail|mast|bowsprit|rope ladder|cannon/i;
const lib = new PieceLibrary(loadCatalog(), join(outDir, "cache"));
const ids = new Set<string>();
for (const f of slabs)
  for (const line of readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim()))
    for (const a of decode(line.trim()).assets) ids.add(a.uuid.toLowerCase());
const pieces: PieceGeometry[] = [];
for (const id of ids) {
  const e = lib.catalog.get(id);
  if (!e || !(e.folder === "Ship" || SHIP.test(e.name))) continue;
  const g = lib.piece(id);
  if (g) pieces.push(g);
}
pieces.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
const pngDir = join(outDir, "pieces");
mkdirSync(pngDir, { recursive: true });

const f2 = (v: number): string => (Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2));
const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

function bounds(g: PieceGeometry): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, g.positions[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, g.positions[i]!);
  }
  return { lo, hi };
}

/** Height map at `per` samples per tile: top (max y) or bottom (min y). */
function heightMap(g: PieceGeometry, lo: number[], hi: number[], per: number, fromBelow: boolean): string[] {
  const x0 = Math.floor(lo[0]! * 2) / 2;
  const x1 = Math.ceil(hi[0]! * 2) / 2;
  const z0 = Math.floor(lo[2]! * 2) / 2;
  const z1 = Math.ceil(hi[2]! * 2) / 2;
  const cam: Camera = fromBelow ? { right: [1, 0, 0], up: [0, 0, 1], toViewer: [0, -1, 0] } : TOP;
  const W = Math.round((x1 - x0) * per);
  const img = render([{ positions: g.positions, indices: g.indices, color: [1, 1, 1] }], cam, {
    width: W,
    window: { r0: x0, r1: x1, u0: z0, u1: z1 },
  });
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let s = "";
    for (let x = 0; x < W; x++) {
      const d = img.depth[y * W + x]!;
      if (d === -Infinity) s += ".";
      else {
        const h = fromBelow ? -d : d;
        s += Math.max(0, Math.min(35, Math.round(h * 2))).toString(36);
      }
    }
    rows.push(s);
  }
  return rows;
}

function centroid(g: PieceGeometry): number[] {
  const P = g.positions;
  const I = g.indices;
  let A = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const d = I[t + 2]! * 3;
    const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
    const e2 = [P[d]! - P[a]!, P[d + 1]! - P[a + 1]!, P[d + 2]! - P[a + 2]!];
    const area =
      0.5 *
      Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!);
    A += area;
    for (let k = 0; k < 3; k++) c[k]! += (area * (P[a + k]! + P[b + k]! + P[d + k]!)) / 3;
  }
  return c.map((v) => v / A);
}

const out: string[] = [];
for (const g of pieces) {
  const e = g.entry;
  const { lo, hi } = bounds(g);
  const box = { lo: e.center.map((c, k) => c - e.extent[k]!), hi: e.center.map((c, k) => c + e.extent[k]!) };
  const c = centroid(g);
  const bc = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
  const name = slug(e.name);
  const mesh = [{ positions: g.positions, indices: g.indices, color: hashColor(e.id) }];
  writeFileSync(join(pngDir, `${name}-top.png`), encodePng(render(mesh, TOP, { width: 256 })));
  writeFileSync(join(pngDir, `${name}-sw.png`), encodePng(render(mesh, oblique(225, 30), { width: 256 })));
  writeFileSync(join(pngDir, `${name}-ne.png`), encodePng(render(mesh, oblique(45, 30), { width: 256 })));
  out.push(`### ${e.name} (${e.kind}, ${e.parts.length} part${e.parts.length > 1 ? "s" : ""}, ${g.indices.length / 3} triangles)`);
  out.push("");
  out.push(`- id \`${e.id}\``);
  out.push(
    `- mesh bounds x ${f2(lo[0]!)}..${f2(hi[0]!)}, y ${f2(lo[1]!)}..${f2(hi[1]!)}, z ${f2(lo[2]!)}..${f2(hi[2]!)}; collider box x ${f2(box.lo[0]!)}..${f2(box.hi[0]!)}, y ${f2(box.lo[1]!)}..${f2(box.hi[1]!)}, z ${f2(box.lo[2]!)}..${f2(box.hi[2]!)}`,
  );
  out.push(
    `- surface centroid (${f2(c[0]!)}, ${f2(c[1]!)}, ${f2(c[2]!)}); offset from the mesh box centre: east ${f2(c[0]! - bc[0]!)}, up ${f2(c[1]! - bc[1]!)}, north ${f2(c[2]! - bc[2]!)}`,
  );
  out.push(
    `- part transforms: ${e.parts.map((p) => `${p.asset} pos(${p.pos.map(f2).join(",")}) quat(${p.rot.map(f2).join(",")})`).join("; ")}`,
  );
  out.push(`- PNGs: \`pieces/${name}-top.png\`, \`-sw.png\` (from the south-west, 30° up), \`-ne.png\``);
  const per = hi[0]! - lo[0]! > 3 || hi[2]! - lo[2]! > 3 ? 3 : 4;
  const top = heightMap(g, lo, hi, per, false);
  const bot = heightMap(g, lo, hi, per, true);
  out.push("");
  out.push(
    `Top-down, north up, ${per} samples per tile; each character is the TOP height in half tiles (0-9, a=5.0, b=5.5 …), '.' empty. Left: highest surface. Right: lowest surface (seen from below).`,
  );
  out.push("```");
  for (let i = 0; i < top.length; i++) out.push(`${top[i]}   ${bot[i] ?? ""}`);
  out.push("```");
  const fa = facingAreas(g);
  out.push(
    `Surface area facing each way (m², tiles²): W ${f2(fa.w)}, E ${f2(fa.e)}, S ${f2(fa.s)}, N ${f2(fa.n)}, up ${f2(fa.u)}, down ${f2(fa.d)}.`,
  );
  const ePer = Math.max(4, Math.min(8, Math.floor(40 / Math.max(hi[2]! - lo[2]!, hi[0]! - lo[0]!, hi[1]! - lo[1]!))));
  const fromEast = silhouette(g, { right: [0, 0, 1], up: [0, 1, 0], toViewer: [1, 0, 0] }, [lo[2]!, hi[2]!], [lo[1]!, hi[1]!], ePer);
  const fromSouth = silhouette(g, { right: [1, 0, 0], up: [0, 1, 0], toViewer: [0, 0, -1] }, [lo[0]!, hi[0]!], [lo[1]!, hi[1]!], ePer);
  out.push(
    `Elevations, ${ePer} samples per tile, '#' solid: left seen FROM THE EAST (north to the right); right seen FROM THE SOUTH (east to the right).`,
  );
  out.push("```");
  for (let i = 0; i < Math.max(fromEast.length, fromSouth.length); i++)
    out.push(`${(fromEast[i] ?? "").padEnd(fromEast[0]!.length)}   ${fromSouth[i] ?? ""}`);
  out.push("```");
  out.push("");
}

function silhouette(g: PieceGeometry, cam: Camera, r: [number, number], u: [number, number], per: number): string[] {
  const W = Math.max(1, Math.round((r[1] - r[0]) * per));
  const img = render([{ positions: g.positions, indices: g.indices, color: [1, 1, 1] }], cam, {
    width: W,
    window: { r0: r[0], r1: r[1], u0: u[0], u1: u[1] },
  });
  const rows: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let s = "";
    for (let x = 0; x < W; x++) s += img.depth[y * W + x] === -Infinity ? "." : "#";
    rows.push(s);
  }
  return rows;
}

function facingAreas(g: PieceGeometry): { w: number; e: number; s: number; n: number; u: number; d: number } {
  const P = g.positions;
  const I = g.indices;
  const r = { w: 0, e: 0, s: 0, n: 0, u: 0, d: 0 };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const c = I[t + 2]! * 3;
    const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
    const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
    // Unity front faces wind clockwise seen from the front in its left-handed frame; the plain numeric
    // e1 x e2 then points out of the front face (checked: floor tops face up).
    const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const area = len / 2;
    const [x, y, z] = [nx / len, ny / len, nz / len];
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (m === Math.abs(x)) r[x > 0 ? "e" : "w"] += area;
    else if (m === Math.abs(y)) r[y > 0 ? "u" : "d"] += area;
    else r[z > 0 ? "n" : "s"] += area;
  }
  return r;
}
writeFileSync(join(outDir, "ship-kit-geometry.generated.md"), out.join("\n"));
console.log(`${pieces.length} pieces; bundles ${lib.bundles.size} in ${lib.bundleMs.toFixed(0)} ms; cache hits ${lib.cacheHits}`);
