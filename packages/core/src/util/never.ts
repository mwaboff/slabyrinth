/**
 * The default branch of a switch that does a different thing per word of a closed vocabulary (`default: return
 * exhaustive(x.kind, "link kind")`): the argument is `never` once every word has its case, so a new word fails to
 * compile until the switch handles it. The `slabyrinth/vocabulary` lint allows such a switch only with this default.
 */
export function exhaustive(value: never, what: string): never {
  throw new Error(`unhandled ${what}: ${String(value)}`);
}
