/**
 * Seeded PRNG (architecture §2.7): sfc32 whose four state words come from splitmix32(seed).
 *
 * Exact algorithm (frozen with generator version 1; golden tests pin the output):
 *  1. sm = splitmix32(seed >>> 0); a = sm(), b = sm(), c = sm(), d = sm().
 *  2. sfc32(a, b, c, d); the first 12 outputs are discarded to mix the state.
 *  3. `nextU32()` returns sfc32's 32-bit output; `next()` = nextU32() / 2^32 ∈ [0, 1).
 *
 * Only 32-bit integer arithmetic (Math.imul, |0, >>>) — bit-identical on every JS engine.
 * Never use Math.random or Date in core.
 */

const TWO_32 = 4294967296;

/** splitmix32 step generator (32-bit variant, constants from Mulberry/splitmix32). */
export function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

export interface Prng {
  /** Unsigned 32-bit integer. */
  nextU32(): number;
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, n) for integer n ≥ 1 (floor(next()·n)). */
  int(n: number): number;
  /** Integer in [min, max] inclusive. */
  range(min: number, max: number): number;
  /** true with probability p (next() < p). */
  chance(p: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle into a NEW array (i from n−1 down to 1, j = int(i+1)). */
  shuffle<T>(items: readonly T[]): T[];
  /** Copy of the internal state (for tests / forking). */
  state(): [number, number, number, number];
}

/** Creates an sfc32 generator seeded through splitmix32. */
export function createPrng(seed: number): Prng {
  const sm = splitmix32(seed >>> 0);
  let a = sm() | 0;
  let b = sm() | 0;
  let c = sm() | 0;
  let d = sm() | 0;

  const nextU32 = (): number => {
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) nextU32();

  const next = (): number => nextU32() / TWO_32;
  const int = (n: number): number => Math.floor(next() * n);

  return {
    nextU32,
    next,
    int,
    range: (min, max) => min + int(max - min + 1),
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("Prng.pick: empty array");
      return items[int(items.length)] as T;
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
}
