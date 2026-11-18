/**
 * Canonical JSON (architecture §2.7): object keys sorted by UTF-16 code unit order, no whitespace,
 * `undefined`-valued properties omitted, `-0` written as `0`. Used for content hashes and deep equality.
 * Non-finite numbers, functions, symbols and bigints are not JSON and throw a TypeError (programming error).
 */

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, "$");
  return out.join("");
}

function write(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      out.push(Object.is(value, -0) ? "0" : JSON.stringify(value));
      return;
    case "object": {
      if (ArrayBuffer.isView(value)) {
        // Typed arrays (resolved grids) serialize like plain number arrays.
        const view = value as unknown as ArrayLike<number>;
        out.push("[");
        for (let i = 0; i < view.length; i++) {
          if (i > 0) out.push(",");
          write(view[i], out, `${path}[${i}]`);
        }
        out.push("]");
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((item: unknown, i) => {
          if (i > 0) out.push(",");
          // JSON semantics: undefined in arrays becomes null.
          if (item === undefined) out.push("null");
          else write(item, out, `${path}[${i}]`);
        });
        out.push("]");
        return;
      }
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      out.push("{");
      let first = true;
      for (const k of keys) {
        const v = rec[k];
        if (v === undefined) continue;
        if (!first) out.push(",");
        first = false;
        out.push(JSON.stringify(k), ":");
        write(v, out, `${path}.${k}`);
      }
      out.push("}");
      return;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/** Structural equality through canonical JSON (key order and undefined properties ignored). */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Deep clone of a JSON value (drops undefined properties). Pure helper for immutable updates. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
