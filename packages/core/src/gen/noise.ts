/**
 * Integer-lattice value noise (architecture §2.5/§2.7). Arithmetic only (+ − × ÷, floor): no sin/cos/exp,
 * so the output is bit-identical on every engine. Lattice values are h32(seed:ix:iy)/2^32.
 */
import { latticeValue } from "../util/hash";

/** murmur3 fmix32: integer-only avalanche of a 32-bit value. */
export function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Value noise in [0,1): smoothstep-interpolated lattice values around (x, y). */
export class ValueNoise {
  private readonly cache = new Map<string, number>();
  constructor(readonly seed: number) {}

  /**
   * Lattice value: §2.7's h32(seed:ix:iy), passed through the murmur3 32-bit finalizer before scaling to [0,1).
   * Plain FNV-1a barely changes its high bits when only the last characters (iy) change, which made noise
   * fields form vertical stripes; the integer-only finalizer restores avalanche and stays bit-identical.
   */
  private lattice(ix: number, iy: number): number {
    const k = `${ix}:${iy}`;
    let v = this.cache.get(k);
    if (v === undefined) {
      v = fmix32(Math.round(latticeValue(this.seed, ix, iy) * 4294967296)) / 4294967296;
      this.cache.set(k, v);
    }
    return v;
  }

  sample(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = this.lattice(ix, iy);
    const v10 = this.lattice(ix + 1, iy);
    const v01 = this.lattice(ix, iy + 1);
    const v11 = this.lattice(ix + 1, iy + 1);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  }
}
