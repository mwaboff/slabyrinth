/** Research: finds a 16-byte content id in a pack's `assetIndex` and prints the surrounding record. READ-ONLY. */
import { readFileSync } from "node:fs";

const [file, hex] = process.argv.slice(2);
if (!file || !hex) throw new Error("usage: peekAssetIndex <assetIndex> <32-hex content id bytes>");
const b = new Uint8Array(readFileSync(file));
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
const needle = Buffer.from(hex, "hex");
const at = Buffer.from(b).indexOf(needle);
console.log(`size ${b.length} magic ${dv.getUint32(0, true).toString(16)} v${dv.getUint32(4, true)} root ${dv.getUint32(8, true)} found at ${at}`);
const str = (o: number): string => {
  const n = dv.getUint32(o + 4, true);
  const r = dv.getInt32(o, true);
  if (!r || n === 0 || n > 512 || o + r + 2 * n > b.length || o + r < 0) return "";
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(o + r + 2 * i, true));
  return /^[\x20-\x7e]+$/.test(s) ? s : "";
};
if (at >= 0) {
  for (let o = at - 32; o < at + 64; o += 4) {
    const s = str(o);
    console.log(o - at, Buffer.from(b.subarray(o, o + 4)).toString("hex"), s ? `str "${s}"` : "");
  }
}
