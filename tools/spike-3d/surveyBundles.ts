/**
 * Research: for every bundle under the given folders, reads only the UnityFS header and the (LZ4) blocks-info table,
 * and tallies data-block compression, Unity versions and sizes. Decompresses no data block. READ-ONLY.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lz4BlockDecompress } from "./lz4";

const COMP = ["none", "LZMA", "LZ4", "LZ4HC"];
const tally = new Map<string, { n: number; bytes: number; ubytes: number }>();
const versions = new Map<string, number>();
const nodeKinds = new Map<string, number>();
let blocksTotal = 0;
let maxBlock = 0;
const examples: string[] = [];
for (const dir of process.argv.slice(2)) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) continue;
    const f = readFileSync(p);
    if (f.subarray(0, 7).toString("latin1") !== "UnityFS") continue;
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    let o = 8;
    const fmt = dv.getUint32(o, false);
    o += 4;
    const cs = (): string => {
      const e = f.indexOf(0, o);
      const s = f.subarray(o, e).toString("latin1");
      o = e + 1;
      return s;
    };
    cs();
    const rev = cs();
    o += 8;
    const ci = dv.getUint32(o, false);
    const ui = dv.getUint32(o + 4, false);
    const flags = dv.getUint32(o + 8, false);
    o += 12;
    if (fmt >= 7) o = (o + 15) & ~15;
    const at = flags & 0x80 ? f.length - ci : o;
    const ic = flags & 0x3f;
    const info = ic === 0 ? f.subarray(at, at + ui) : lz4BlockDecompress(f.subarray(at, at + ci), ui);
    const iv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    let q = 16;
    const nb = iv.getUint32(q, false);
    q += 4;
    let u = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < nb; i++) {
      const bu = iv.getUint32(q, false);
      const bflags = iv.getUint16(q + 8, false);
      q += 10;
      u += bu;
      maxBlock = Math.max(maxBlock, bu);
      kinds.add(COMP[bflags & 0x3f] ?? String(bflags & 0x3f));
    }
    blocksTotal += nb;
    const nn = iv.getUint32(q, false);
    q += 4;
    for (let i = 0; i < nn; i++) {
      q += 20;
      let e = q;
      while (info[e] !== 0) e++;
      const path = new TextDecoder().decode(info.subarray(q, e));
      q = e + 1;
      const k = path.endsWith(".resS") ? ".resS" : path.endsWith(".resource") ? ".resource" : path.startsWith("CAB-") ? "CAB" : "other";
      nodeKinds.set(k, (nodeKinds.get(k) ?? 0) + 1);
    }
    const key = [...kinds].sort().join("+") + ` (info ${COMP[ic]})`;
    const t = tally.get(key) ?? { n: 0, bytes: 0, ubytes: 0 };
    t.n++;
    t.bytes += f.length;
    t.ubytes += u;
    tally.set(key, t);
    versions.set(`${fmt} ${rev}`, (versions.get(`${fmt} ${rev}`) ?? 0) + 1);
    if (examples.length < 3 && /ship/.test(name)) examples.push(`${name}: ${nb} blocks, ${[...kinds]}`);
  }
}
for (const [k, v] of tally)
  console.log(`${k}: ${v.n} bundles, ${(v.bytes / 1e6).toFixed(0)} MB on disk, ${(v.ubytes / 1e6).toFixed(0)} MB unpacked`);
console.log("format/revision", [...versions]);
console.log("node kinds", [...nodeKinds]);
console.log(`blocks ${blocksTotal}, largest block ${maxBlock} bytes`);
console.log(examples.join("\n"));
