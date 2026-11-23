/** Research: lists a slab's distinct assets with their mesh bounds against their collider box. READ-ONLY. */
import { readFileSync } from "node:fs";
import { decode } from "../../packages/core/src/slab";
import { loadCatalog, PieceLibrary } from "./pieces";

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: probeSlab <slab.txt>");
const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
const counts = new Map<string, number>();
for (const l of lines) for (const a of decode(l.trim()).assets) counts.set(a.uuid, (counts.get(a.uuid) ?? 0) + 1);
const lib = new PieceLibrary(loadCatalog());
const t0 = performance.now();
for (const [id, n] of counts) {
  const g = lib.piece(id);
  if (!g) {
    console.log(`${id} x${n}: NOT IN CATALOG`);
    continue;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, g.positions[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, g.positions[i]!);
  }
  const e = g.entry;
  const f = (v: number[]): string => v.map((x) => x.toFixed(2)).join(",");
  console.log(
    `${e.name} [${e.kind}] x${n} tris ${g.indices.length / 3} mesh ${f(lo)}..${f(hi)} box ${f(e.center.map((c, k) => c - e.extent[k]!))}..${f(e.center.map((c, k) => c + e.extent[k]!))} parts ${e.parts.length}${g.missing.length ? " MISSING " + g.missing.join(";") : ""}`,
  );
}
console.log(`bundles ${lib.bundles.size}, bundle load ${lib.bundleMs.toFixed(0)} ms, mesh read ${lib.meshMs.toFixed(0)} ms, total ${(performance.now() - t0).toFixed(0)} ms`);
for (const b of lib.bundles.values())
  console.log(`  ${b.path.split(/[\\/]/).pop()} ${(b.stats.fileBytes / 1e6).toFixed(1)} MB -> ${(b.stats.unpackedBytes / 1e6).toFixed(1)} MB in ${b.stats.ms.toFixed(0)} ms`);
