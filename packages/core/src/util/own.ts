/**
 * Own-property lookups for dictionaries keyed by strings that come from plans or user files (theme ids, role names,
 * asset uuids). `obj[key]` would reach Object.prototype for keys like "constructor", "toString", "hasOwnProperty"
 * or "__proto__"; these helpers never do.
 */

/** obj[key] only when `key` is an own property of `obj`. */
export function own<T>(obj: Readonly<Record<string, T>> | undefined | null, key: string): T | undefined {
  return obj !== undefined && obj !== null && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** An empty dictionary without a prototype: assigning `d["__proto__"]` stores a value instead of re-parenting. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
