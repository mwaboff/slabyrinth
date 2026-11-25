/**
 * LZMA1 decoder for UnityFS LZMA blocks: a 5-byte properties header (lc/lp/pb byte, u32 dictionary size) then the
 * range-coded stream; the unpacked size comes from the caller. Written from the public LZMA specification
 * (LzmaSpec); ported from the 3D spike. The whole output stays in memory, so no separate dictionary window is needed.
 */
import { DecodeError } from "./errors";

const PROB_INIT = 1024;
const TOP = 1 << 24;

interface LenModel {
  choice: Uint16Array;
  low: Uint16Array;
  mid: Uint16Array;
  high: Uint16Array;
}

export function lzmaDecompress(src: Uint8Array, outSize: number): Uint8Array {
  const props = src[0] ?? 0;
  if (props >= 9 * 5 * 5) throw new DecodeError(`lzma: bad properties byte ${props}`);
  const lc = props % 9;
  const lp = Math.floor(props / 9) % 5;
  const pb = Math.floor(props / 45);
  const out = new Uint8Array(outSize);
  let inPos = 5;
  // the range coder may normalise a few bytes beyond the last one (they read 0); further than that the input is short
  const next = (): number => {
    if (inPos >= src.length + 4) throw new DecodeError("lzma: input ends early");
    return src[inPos++] ?? 0;
  };

  // range decoder
  if (next() !== 0) throw new DecodeError("lzma: corrupt stream (first byte not 0)");
  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | next()) >>> 0;
  if (code === range) throw new DecodeError("lzma: corrupt stream");

  const bit = (probs: Uint16Array, i: number): number => {
    const p = probs[i] ?? PROB_INIT;
    const bound = (range >>> 11) * p;
    let b: number;
    if (code < bound) {
      range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      b = 0;
    } else {
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      b = 1;
    }
    if (range < TOP) {
      range = (range << 8) >>> 0;
      code = ((code << 8) | next()) >>> 0;
    }
    return b;
  };
  const direct = (n: number): number => {
    let res = 0;
    for (; n > 0; n--) {
      range >>>= 1;
      let b = 0;
      if (code >= range) {
        code = (code - range) >>> 0;
        b = 1;
      }
      res = ((res << 1) | b) >>> 0;
      if (range < TOP) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | next()) >>> 0;
      }
    }
    return res;
  };
  const tree = (probs: Uint16Array, off: number, numBits: number): number => {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + bit(probs, off + m);
    return m - (1 << numBits);
  };
  const reverse = (probs: Uint16Array, off: number, numBits: number): number => {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = bit(probs, off + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  };

  const p = (n: number): Uint16Array => new Uint16Array(n).fill(PROB_INIT);
  const literal = p(0x300 << (lc + lp));
  const isMatch = p(12 << 4);
  const isRep = p(12);
  const isRepG0 = p(12);
  const isRepG1 = p(12);
  const isRepG2 = p(12);
  const isRep0Long = p(12 << 4);
  const posSlot = p(4 << 6);
  const posDec = p(1 + 114);
  const align = p(1 << 4);
  const lenModel = (): LenModel => ({ choice: p(2), low: p(16 << 3), mid: p(16 << 3), high: p(256) });
  const lenDec = lenModel();
  const repLenDec = lenModel();
  const decodeLen = (m: LenModel, posState: number): number => {
    if (bit(m.choice, 0) === 0) return tree(m.low, posState << 3, 3);
    if (bit(m.choice, 1) === 0) return 8 + tree(m.mid, posState << 3, 3);
    return 16 + tree(m.high, 0, 8);
  };
  const decodeDistance = (len: number): number => {
    const lenState = len > 3 ? 3 : len;
    const slot = tree(posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirect = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
    if (slot < 14) dist = (dist + reverse(posDec, dist - slot, numDirect)) >>> 0;
    else {
      dist = (dist + ((direct(numDirect - 4) << 4) >>> 0)) >>> 0;
      dist = (dist + reverse(align, 0, 4)) >>> 0;
    }
    return dist;
  };

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let pos = 0;
  while (pos < outSize) {
    const posState = pos & pbMask;
    if (bit(isMatch, (state << 4) + posState) === 0) {
      const prev = pos > 0 ? (out[pos - 1] ?? 0) : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1] ?? 0;
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const b = bit(literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
      out[pos++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len: number;
    if (bit(isRep, state) !== 0) {
      if (pos === 0) throw new DecodeError("lzma: repeat match at the start");
      if (bit(isRepG0, state) === 0) {
        if (bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1] ?? 0;
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (bit(isRepG2, state) === 0) dist = rep2;
          else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = decodeLen(repLenDec, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = decodeLen(lenDec, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xffffffff) break; // end marker
      if (rep0 >= pos) throw new DecodeError(`lzma: distance ${rep0} beyond output ${pos}`);
    }
    len += 2;
    let from = pos - rep0 - 1;
    const end = Math.min(outSize, pos + len);
    if (rep0 + 1 >= len) {
      out.copyWithin(pos, from, from + (end - pos));
      pos = end;
    } else while (pos < end) out[pos++] = out[from++] ?? 0;
  }
  if (pos !== outSize) throw new DecodeError(`lzma: produced ${pos} bytes, expected ${outSize}`);
  return out;
}
