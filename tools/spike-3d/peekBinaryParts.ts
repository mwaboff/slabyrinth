/**
 * Research: decodes the binary index's sub-mesh `Assets` elements (BoardObject +36, 104-byte elements) for assets
 * whose names match a pattern, to see whether they carry the bundle id and asset name. READ-ONLY.
 */
import { readFileSync } from "node:fs";
import { readBinaryIndex } from "../../packages/core/src/catalog/binaryIndex";

const [file, pattern] = process.argv.slice(2);
if (!file || !pattern) throw new Error("usage: peekBinaryParts <index> <regex>");
const b = new Uint8Array(readFileSync(file));
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
const res = readBinaryIndex(b);
const root = dv.getUint32(8, true);
const ptr = (at: number): number => {
  const r = dv.getInt32(at, true);
  return r === 0 ? -1 : at + r;
};
const str = (at: number): string => {
  const n = dv.getUint32(at + 4, true);
  const p = ptr(at);
  if (n === 0 || p < 0 || n > 4096 || p + 2 * n > b.length) return "";
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + 2 * i, true));
  return s;
};
const boards = ptr(root + 16);
const count = dv.getUint32(root + 20, true);
const re = new RegExp(pattern, "i");
let shown = 0;
for (let i = 0; i < count && shown < 4; i++) {
  const rec = boards + 176 * i;
  const name = str(rec);
  if (!re.test(name)) continue;
  shown++;
  const partsAt = ptr(rec + 36);
  const n = dv.getUint32(rec + 40, true);
  console.log(`${name}: ${n} parts`);
  for (let k = 0; k < n; k++) {
    const e = partsAt + 104 * k;
    const hex = Buffer.from(b.subarray(e, e + 104)).toString("hex").replace(/(.{8})/g, "$1 ");
    console.log("  elem", hex);
    const f = (o: number): string => dv.getFloat32(e + o, true).toFixed(3);
    console.log("  floats@64..", [64, 68, 72, 76, 80, 84, 88, 92, 96, 100].map(f).join(" "));
    // try every 8-byte slot as a string field
    for (let o = 0; o < 64; o += 4) {
      const s = str(e + o);
      if (s) console.log(`   str@${o}: ${s}`);
    }
    const ref = ptr(e);
    if (ref > 0) {
      console.log("  ref->", Buffer.from(b.subarray(ref, ref + 64)).toString("hex").replace(/(.{8})/g, "$1 "));
      for (let o = 0; o < 64; o += 4) {
        const s = str(ref + o);
        if (s) console.log(`   ref str@${o}: ${s}`);
      }
    }
  }
}
console.log(`(${res.rows.length} rows)`);
