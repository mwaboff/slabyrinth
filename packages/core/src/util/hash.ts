/**
 * Deterministic hashing (architecture §2.7).
 *
 *  - `h32(str)`  = FNV-1a 32 over the UTF-8 bytes of `str` → unsigned 32-bit integer.
 *  - `h64hex(str)` = FNV-1a 64 over UTF-8 → 16 lowercase hex digits (ResolvedPlan.hash, content hashes).
 *  - `elementSeed(planSeed, elementId, opSeed?)` = `opSeed ?? h32(planSeed + ":" + elementId)`.
 *  - `subSeed(seed, purpose)` = `h32(seed + ":" + purpose)` (independent sub-streams).
 *  - `latticeValue(seed, ix, iy)` = `h32(seed + ":" + ix + ":" + iy) / 2^32` ∈ [0, 1) (value-noise lattice).
 *
 * Integer arithmetic only (Math.imul, >>> 0, exact double products below 2^53): bit-identical on every
 * platform. No TextEncoder (core has no DOM/Node types): UTF-8 is encoded by hand from code points.
 */

/** Calls `sink` with every UTF-8 byte of `str`. Lone surrogates are encoded as U+FFFD (like TextEncoder). */
function forEachUtf8Byte(str: string, sink: (byte: number) => void): void {
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      sink(cp);
    } else if (cp < 0x800) {
      sink(0xc0 | (cp >> 6));
      sink(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      sink(0xe0 | (cp >> 12));
      sink(0x80 | ((cp >> 6) & 0x3f));
      sink(0x80 | (cp & 0x3f));
    } else {
      sink(0xf0 | (cp >> 18));
      sink(0x80 | ((cp >> 12) & 0x3f));
      sink(0x80 | ((cp >> 6) & 0x3f));
      sink(0x80 | (cp & 0x3f));
    }
  }
}

/** UTF-8 encoding of `str` as a byte array. */
export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  forEachUtf8Byte(str, (b) => out.push(b));
  return Uint8Array.from(out);
}

/** Number of UTF-8 bytes of `str` (used for the plan JSON size limit). */
export function utf8Length(str: string): number {
  let n = 0;
  forEachUtf8Byte(str, () => {
    n++;
  });
  return n;
}

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

/** FNV-1a 32 of raw bytes. */
export function fnv1a32Bytes(bytes: ArrayLike<number>): number {
  let h = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= (bytes[i] ?? 0) & 0xff;
    h = Math.imul(h, FNV32_PRIME);
  }
  return h >>> 0;
}

/** FNV-1a 32 over the UTF-8 bytes of `str`; unsigned 32-bit result. */
export function h32(str: string): number {
  let h = FNV32_OFFSET;
  forEachUtf8Byte(str, (b) => {
    h ^= b;
    h = Math.imul(h, FNV32_PRIME);
  });
  return h >>> 0;
}

const TWO_32 = 4294967296;

/**
 * FNV-1a 64 over the UTF-8 bytes of `str`, as 16 lowercase hex digits.
 * offset 0xcbf29ce484222325, prime 0x100000001b3 = 2^40 + 0x1b3; computed on two 32-bit halves.
 */
export function h64hex(str: string): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  forEachUtf8Byte(str, (b) => {
    lo = (lo ^ b) >>> 0;
    // (hi·2^32 + lo) · (2^40 + 0x1b3) mod 2^64
    const loP = lo * 0x1b3; // < 2^41, exact
    const carry = Math.floor(loP / TWO_32);
    const newLo = loP >>> 0;
    const hiP = hi * 0x1b3 + carry; // < 2^42, exact
    hi = (hiP + ((lo << 8) >>> 0)) >>> 0; // lo·2^40 contributes (lo << 8) to the high word
    lo = newLo;
  });
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/** Per-element seed (§2.7): explicit op/shape seed wins, else h32(planSeed + ":" + elementId). */
export function elementSeed(planSeed: number, elementId: string, explicitSeed?: number): number {
  return explicitSeed !== undefined ? explicitSeed >>> 0 : h32(`${planSeed}:${elementId}`);
}

/** Independent sub-stream seed: h32(seed + ":" + purpose). */
export function subSeed(seed: number, purpose: string): number {
  return h32(`${seed}:${purpose}`);
}

/** Value-noise lattice value in [0, 1): h32(seed + ":" + ix + ":" + iy) / 2^32. ix, iy are integers. */
export function latticeValue(seed: number, ix: number, iy: number): number {
  return h32(`${seed}:${ix}:${iy}`) / TWO_32;
}
