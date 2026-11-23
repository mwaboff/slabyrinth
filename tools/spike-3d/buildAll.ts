/**
 * Research: extracts every tile and prop of both official packs into a mesh cache, bundle by bundle, and reports
 * timings, sizes, triangle counts and failures. READ-ONLY on the install; writes only into <cacheDir>.
 * Usage: buildAll <cacheDir> [limitBundles]
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, PieceLibrary, type CatalogEntry } from "./pieces";

const [cacheDir, limitArg] = process.argv.slice(2);
if (!cacheDir) throw new Error("usage: buildAll <cacheDir> [limitBundles]");
const cat = loadCatalog();
const lib = new PieceLibrary(cat, cacheDir);
const byBundle = new Map<string, CatalogEntry[]>();
for (const e of cat.values()) {
  const b = e.parts[0]?.bundle ?? "(none)";
  const l = byBundle.get(b) ?? [];
  l.push(e);
  byBundle.set(b, l);
}
const groups = [...byBundle].slice(0, limitArg ? Number(limitArg) : undefined);
const t0 = performance.now();
let ok = 0;
let tris = 0;
let unpacked = 0;
let packed = 0;
let peakRss = 0;
const failures: string[] = [];
const triCounts: number[] = [];
groups.forEach(([bundle, entries], gi) => {
  for (const e of entries) {
    try {
      const g = lib.piece(e.id);
      if (!g) throw new Error("no geometry");
      if (g.missing.length) failures.push(`${e.name}: missing ${g.missing.join(";")}`);
      if (g.indices.length === 0) failures.push(`${e.name}: no triangles`);
      ok++;
      tris += g.indices.length / 3;
      triCounts.push(g.indices.length / 3);
    } catch (err) {
      failures.push(`${e.name} (${bundle}): ${(err as Error).message}`);
    }
  }
  for (const b of lib.bundles.values()) {
    unpacked += b.stats.unpackedBytes;
    packed += b.stats.fileBytes;
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  lib.releaseBundles();
  lib.pieces.clear();
  if (gi % 25 === 0)
    console.log(`${gi + 1}/${groups.length} bundles, ${((performance.now() - t0) / 1000).toFixed(0)} s, ${ok} pieces`);
});
const secs = (performance.now() - t0) / 1000;
let cacheBytes = 0;
for (const f of readdirSync(cacheDir)) cacheBytes += statSync(join(cacheDir, f)).size;
triCounts.sort((a, b) => a - b);
const pct = (p: number): number => triCounts[Math.floor((triCounts.length - 1) * p)] ?? 0;
const report = [
  `bundles ${groups.length}, pieces ok ${ok} of ${[...groups].reduce((n, [, l]) => n + l.length, 0)}, failures ${failures.length}`,
  `time ${secs.toFixed(0)} s; bundle unpack ${(lib.bundleMs / 1000).toFixed(0)} s; mesh read ${(lib.meshMs / 1000).toFixed(1)} s`,
  `bytes read ${(packed / 1e6).toFixed(0)} MB, unpacked ${(unpacked / 1e6).toFixed(0)} MB => ${(unpacked / 1e6 / (lib.bundleMs / 1000)).toFixed(1)} MB/s of output`,
  `triangles total ${tris}; per piece median ${pct(0.5)}, p90 ${pct(0.9)}, p99 ${pct(0.99)}, max ${pct(1)}`,
  `mesh cache ${(cacheBytes / 1e6).toFixed(1)} MB in ${readdirSync(cacheDir).length} files; peak rss ${(peakRss / 1e6).toFixed(0)} MB`,
  ...failures.slice(0, 40).map((f) => `  FAIL ${f}`),
];
writeFileSync(join(cacheDir, "..", "buildAll-report.txt"), report.join("\n"));
console.log(report.join("\n"));
