/** Research: walks `assetIndex` (v2) as {string name, 16-byte id, array} per bundle and prints matching ones. READ-ONLY. */
import { readFileSync } from "node:fs";

const [file, pattern] = process.argv.slice(2);
if (!file || !pattern) throw new Error("usage: peekAssetIndex2 <assetIndex> <regex>");
const b = new Uint8Array(readFileSync(file));
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
const ptr = (o: number): number => o + dv.getInt32(o, true);
const str = (o: number): string => {
  const n = dv.getUint32(o + 4, true);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(ptr(o) + 2 * i, true));
  return s;
};
const hex = (o: number, n: number): string => Buffer.from(b.subarray(o, o + n)).toString("hex");
const root = dv.getUint32(8, true);
const arr = ptr(root);
const count = dv.getUint32(root + 4, true);
const stride = 32;
const re = new RegExp(pattern, "i");
console.log(`bundles ${count}`);
for (let i = 0; i < count; i++) {
  const e = arr + stride * i;
  const name = str(e);
  if (!re.test(name)) continue;
  const subCount = dv.getUint32(e + 28, true);
  console.log(`${name} id ${hex(e + 8, 16)} sub ${subCount} raw ${hex(e, 32)}`);
  const sub = ptr(e + 24);
  for (let k = 0; k < Math.min(subCount, 8); k++) {
    console.log("   ", hex(sub + 24 * k, 24));
    // guess: {string name, 16 bytes}
    try {
      console.log("    name?", str(sub + 24 * k));
    } catch {
      /* not a string */
    }
  }
}
