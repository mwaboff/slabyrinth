/**
 * JSON read from outside (a file, stdin), not yet checked. A reading helper returns `Unparsed`, not `unknown`: a cast
 * of an `Unparsed` to a domain type (`readJson(f) as MapPlan`) is a type error, because the two types do not overlap,
 * so the value has to go through a parser that takes `unknown` (core parsePlan, parseAssetCatalog, a zod schema).
 */
declare const UNPARSED: unique symbol;

export interface Unparsed {
  readonly [UNPARSED]: "parse me with a schema";
}

/** Parses JSON text (a leading byte-order mark is skipped) into a value that must be validated before use. */
export function parseJsonText(text: string): Unparsed {
  const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return value as Unparsed;
}
