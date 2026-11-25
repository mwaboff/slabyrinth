/** Command-line arguments: positionals and `--flag value` / `--flag=value` / boolean flags. */

export class UsageError extends Error {}

/** Flags that take no value. */
const BOOLEAN = new Set(["boxes", "persp", "ortho", "no-roofs", "json", "sheet", "help", "check"]);

export interface Args {
  _: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (!t.startsWith("--")) {
      a._.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const k = eq >= 0 ? t.slice(2, eq) : t.slice(2);
    if (eq >= 0) a.flags.set(k, t.slice(eq + 1));
    else if (BOOLEAN.has(k)) a.flags.set(k, true);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${k} needs a value`);
      a.flags.set(k, next);
      i++;
    }
  }
  return a;
}

export const flag = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === "string" ? v : undefined;
};

export const has = (a: Args, k: string): boolean => a.flags.has(k);

/** "x,y,z" → numbers (usage error otherwise). */
export function numbers(s: string, count: number, what: string): number[] {
  const v = s.split(",").map((x) => Number(x.trim()));
  if (v.length !== count || v.some((x) => !Number.isFinite(x)))
    throw new UsageError(`${what}: expected ${count} numbers separated by commas, got "${s}"`);
  return v;
}

/** "3", "1..4" or "1,5,9" → seeds. */
export function seedList(s: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(s.trim());
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from || to - from > 999) throw new UsageError(`--seeds ${s}: a range of at most 1000`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const v = s.split(",").map((x) => Number(x.trim()));
  if (v.some((x) => !Number.isInteger(x) || x < 0)) throw new UsageError(`--seeds ${s}: whole numbers`);
  return v;
}
