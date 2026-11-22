/**
 * Extremes and appends over lists of any length. A spread argument (`Math.max(...xs)`, `out.push(...xs)`) passes one
 * argument per entry and V8 throws `RangeError: Maximum call stack size exceeded` somewhere above 100,000 of them,
 * which a list with one entry per cell reaches at the large size tiers. These loop instead, with exactly the results
 * of the spread form (the `slabyrinth/spread-args` lint sends every such call here).
 */

/** The smallest number, as `Math.min(...xs)`: `Infinity` when there is none, `NaN` when any is `NaN`. */
export function minOf(xs: Iterable<number>): number {
  let m = Infinity;
  for (const x of xs) m = Math.min(m, x);
  return m;
}

/** The largest number, as `Math.max(...xs)`: `-Infinity` when there is none, `NaN` when any is `NaN`. */
export function maxOf(xs: Iterable<number>): number {
  let m = -Infinity;
  for (const x of xs) m = Math.max(m, x);
  return m;
}

/** Appends every item of every source to `target` in order, as `target.push(...a, ...b)`; returns the new length. */
export function pushAll<T>(target: T[], ...sources: Iterable<T>[]): number {
  for (const source of sources) for (const x of source) target.push(x);
  return target.length;
}
