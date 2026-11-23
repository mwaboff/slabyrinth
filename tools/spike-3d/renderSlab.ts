/**
 * Renders a slab file (one chunk per line, all pasted at the same origin) to PNGs: top (north up) and obliques.
 * Usage: renderSlab <slab.txt> <outPrefix> [width=1024] [views=top,sw30,...] [--no-floor]
 * A view is "top" or "<bearing letters or degrees><elevation>", e.g. "ne35", "s30", "200x25".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCatalog, PieceLibrary } from "./pieces";
import { encodePng, oblique, render, TOP, type Camera } from "./raster";
import { slabScene } from "./scene";

const args = process.argv.slice(2);
const noFloor = args.includes("--no-floor");
const [file, prefix, widthArg, viewsArg] = args.filter((a) => !a.startsWith("--"));
if (!file || !prefix) throw new Error("usage: renderSlab <slab.txt> <outPrefix> [width] [views]");
const width = Number(widthArg ?? 1024);
const views = (viewsArg ?? "top,ne35").split(",");
const BEARING: Record<string, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
const camOf = (v: string): Camera => {
  if (v === "top") return TOP;
  const m = /^([a-z]+|\d+x)(\d+)$/.exec(v);
  if (!m) throw new Error(`bad view ${v}`);
  const b = m[1]!.endsWith("x") ? Number(m[1]!.slice(0, -1)) : BEARING[m[1]!];
  if (b === undefined) throw new Error(`bad bearing ${v}`);
  return oblique(b, Number(m[2]));
};

const mem0 = process.memoryUsage().rss;
const t0 = performance.now();
const lib = new PieceLibrary(loadCatalog(), join(dirname(prefix), "cache"));
const tCat = performance.now();
const scene = slabScene(readFileSync(file, "utf8"), lib);
const tScene = performance.now();
lib.releaseBundles();
let meshes = scene.placed.map((p) => p.mesh);
if (noFloor) meshes = scene.placed.filter((p) => !/^(Dungeon Floor)/.test(p.name)).map((p) => p.mesh);
const crop = args.find((a) => a.startsWith("--crop="));
if (crop) {
  // --crop=x0,z0,x1,z1 keeps the pieces whose stored position lies in that plan rectangle (tiles)
  const [x0, z0, x1, z1] = crop.slice(7).split(",").map(Number) as [number, number, number, number];
  meshes = scene.placed
    .filter((p) => p.pos[0] >= x0 && p.pos[0] <= x1 && p.pos[2] >= z0 && p.pos[2] <= z1)
    .filter((p) => !noFloor || !/^(Dungeon Floor)/.test(p.name))
    .map((p) => p.mesh);
}
const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
mkdirSync(dirname(prefix), { recursive: true });
const timings: string[] = [];
for (const v of views) {
  const t = performance.now();
  const img = render(meshes, camOf(v), { width });
  const tr = performance.now() - t;
  const t2 = performance.now();
  writeFileSync(`${prefix}-${v}-${width}.png`, encodePng(img));
  timings.push(`${v}: raster ${tr.toFixed(0)} ms, png ${(performance.now() - t2).toFixed(0)} ms (${img.width}x${img.height})`);
}
const distinct = new Set(scene.placed.map((p) => p.uuid)).size;
console.log(
  `assets ${scene.assets} (${distinct} distinct, ${scene.unknown} not in catalog), triangles drawn ${tris}; catalog ${(tCat - t0).toFixed(0)} ms, meshes ${(tScene - tCat).toFixed(0)} ms (bundles ${lib.bundles.size === 0 ? "released" : lib.bundles.size}, bundle unpack ${lib.bundleMs.toFixed(0)} ms, cache hits ${lib.cacheHits}); peak rss ~${((process.memoryUsage().rss - mem0) / 1e6).toFixed(0)} MB over start`,
);
for (const t of timings) console.log("  " + t);
