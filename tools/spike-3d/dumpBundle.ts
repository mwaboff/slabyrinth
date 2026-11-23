/** Research: lists a bundle's nodes, object classes and the AssetBundle container (READ-ONLY on the install). */
import { readFileSync } from "node:fs";
import { readBundle } from "./unityfs";
import { CLASS, readObject, readSerializedFile } from "./serialized";

const [file, showClass] = process.argv.slice(2);
if (!file) throw new Error("usage: dumpBundle <bundle> [classId]");
const t0 = performance.now();
const b = readBundle(readFileSync(file));
console.log(
  `format ${b.formatVersion} ${b.unityVersion} ${b.unityRevision} infoComp ${b.infoCompression} blocks ${b.blockCount} comps ${b.blockCompressions.join(",")} (${(performance.now() - t0).toFixed(1)} ms)`,
);
for (const n of b.nodes) console.log(`  node ${n.path} ${n.data.length} bytes flags ${n.flags}`);
const sfNode = b.nodes.find((n) => !n.path.endsWith(".resS") && !n.path.endsWith(".resource"))!;
const sf = readSerializedFile(sfNode.data);
console.log(`serialized v${sf.version} unity ${sf.unityVersion} typetree ${sf.typeTreeEnabled} externals ${sf.externals.join(", ")}`);
const counts = new Map<number, number>();
for (const o of sf.objects) counts.set(o.classId, (counts.get(o.classId) ?? 0) + 1);
console.log("classes", [...counts].map(([k, v]) => `${k}:${v}`).join(" "));
const ab = sf.objects.find((o) => o.classId === CLASS.AssetBundle);
if (ab) {
  const v = readObject(sf, ab) as Record<string, unknown>;
  const cont = v.m_Container as Array<Record<string, unknown>>;
  console.log(`container ${cont.length}`);
  for (const e of cont.slice(0, 40)) console.log("  ", e.first, JSON.stringify((e.second as Record<string, unknown>).asset, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
if (showClass) {
  const o = sf.objects.find((x) => x.classId === Number(showClass));
  if (o) {
    const v = readObject(sf, o);
    console.log(
      JSON.stringify(
        v,
        (_k, x) =>
          typeof x === "bigint"
            ? x.toString()
            : x instanceof Uint8Array || x instanceof Float32Array
              ? `<${x.constructor.name} ${x.length}>`
              : x,
        1,
      ).slice(0, 6000),
    );
  }
  const t = sf.types.find((x) => x.classId === Number(showClass));
  if (t) console.log(t.nodes.map((n) => `${"  ".repeat(n.level)}${n.type} ${n.name} ${n.metaFlag & 0x4000 ? "A" : ""}`).join("\n").slice(0, 8000));
}
