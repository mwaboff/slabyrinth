/** LZ4 block decompressor (no frame header), as UnityFS LZ4 and LZ4HC blocks use it. */
import { DecodeError } from "./errors";

export function lz4BlockDecompress(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  let s = 0;
  let d = 0;
  const byte = (): number => {
    if (s >= src.length) throw new DecodeError("lz4: input ends inside a sequence");
    return src[s++] ?? 0;
  };
  while (s < src.length) {
    const token = byte();
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = byte();
        lit += b;
      } while (b === 255);
    }
    if (s + lit > src.length || d + lit > outSize) throw new DecodeError("lz4: literals run past the end");
    out.set(src.subarray(s, s + lit), d);
    s += lit;
    d += lit;
    if (s >= src.length) break; // the last sequence has literals only
    const offset = byte() | (byte() << 8);
    if (offset === 0 || offset > d) throw new DecodeError(`lz4: bad offset ${offset} at output ${d}`);
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        b = byte();
        len += b;
      } while (b === 255);
    }
    len += 4;
    if (d + len > outSize) throw new DecodeError("lz4: match runs past the end");
    let from = d - offset;
    if (offset >= len) {
      out.copyWithin(d, from, from + len);
      d += len;
    } else for (let i = 0; i < len; i++) out[d++] = out[from++] ?? 0;
  }
  if (d !== outSize) throw new DecodeError(`lz4: produced ${d} bytes, expected ${outSize}`);
  return out;
}
