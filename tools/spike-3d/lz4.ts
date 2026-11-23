/** LZ4 block-format decompressor (no frame header), as used by UnityFS blocks (LZ4 and LZ4HC share it). */
export function lz4BlockDecompress(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++]!;
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = src[s++]!;
        lit += b;
      } while (b === 255);
    }
    out.set(src.subarray(s, s + lit), d);
    s += lit;
    d += lit;
    if (s >= src.length) break; // last sequence has literals only
    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error(`lz4: bad offset ${offset} at out ${d}`);
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        b = src[s++]!;
        len += b;
      } while (b === 255);
    }
    len += 4;
    let from = d - offset;
    if (offset >= len) {
      out.copyWithin(d, from, from + len);
      d += len;
    } else {
      for (let i = 0; i < len; i++) out[d++] = out[from++]!;
    }
  }
  if (d !== outSize) throw new Error(`lz4: produced ${d} bytes, expected ${outSize}`);
  return out;
}
