/**
 * Tolerant parser for a PREFIX of a JSON document (streamed tool input, architecture §3.9 progress).
 *
 * `parsePartialJson(text)` never throws. It returns the best value that the prefix describes:
 *  - an unterminated string yields the characters read so far (an incomplete escape is dropped);
 *  - an unterminated number yields its valid prefix ("12." → 12, "-" → dropped);
 *  - an incomplete literal (`tru`) and an object key without a value are dropped;
 *  - open arrays/objects are closed.
 * `complete` is true only when the whole text is one well-formed JSON value (plus whitespace).
 * `error` is set when the text is not a prefix of valid JSON; `value` then holds what was read before it.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PartialJsonResult {
  /** Best-effort value; undefined when nothing usable was read. */
  value: JsonValue | undefined;
  complete: boolean;
  error?: { offset: number; message: string };
}

class Bad extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
  }
}

/** Maximum array/object nesting; deeper input is "not valid JSON" instead of a stack overflow. */
export const MAX_PARTIAL_JSON_DEPTH = 256;

export function parsePartialJson(text: string): PartialJsonResult {
  let i = 0;
  const n = text.length;
  let depth = 0;
  const enter = (): void => {
    if (++depth > MAX_PARTIAL_JSON_DEPTH)
      throw new Bad(i, `nesting deeper than ${MAX_PARTIAL_JSON_DEPTH} levels`);
  };
  // Value of the outermost container being built, so a Bad can still report progress.
  let root: JsonValue | undefined;

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  /** Returns [value, finished]. A partially read value is returned with finished=false. */
  const parseValue = (): [JsonValue | undefined, boolean] => {
    ws();
    if (i >= n) return [undefined, false];
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    for (const [lit, val] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return [val, true];
      }
      if (lit.startsWith(text.slice(i))) {
        i = n;
        return [undefined, false];
      }
    }
    throw new Bad(i, `unexpected character ${JSON.stringify(c)}`);
  };

  const parseString = (): [string, boolean] => {
    i++; // opening quote
    let s = "";
    while (i < n) {
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return [s, true];
      }
      if (c === "\\") {
        if (i + 1 >= n) {
          i = n;
          return [s, false];
        }
        const e = text[i + 1] as string;
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        const mapped = simple[e];
        if (mapped !== undefined) {
          s += mapped;
          i += 2;
          continue;
        }
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) {
            i = n;
            return [s, false];
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Bad(i, "invalid \\u escape");
          s += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        throw new Bad(i, `invalid escape \\${e}`);
      }
      s += c;
      i++;
    }
    return [s, false];
  };

  const parseNumber = (): [number | undefined, boolean] => {
    const m = /^-?(0|[1-9]\d*)?(\.\d*)?([eE][+-]?\d*)?/.exec(text.slice(i));
    const raw = m?.[0] ?? "";
    i += raw.length;
    const atEnd = i >= n;
    const full = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw);
    if (full) return [Number(raw), !atEnd];
    // Trim to the longest valid prefix.
    for (let k = raw.length - 1; k > 0; k--) {
      const p = raw.slice(0, k);
      if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(p)) {
        if (!atEnd) throw new Bad(i, `malformed number ${JSON.stringify(raw)}`);
        return [Number(p), false];
      }
    }
    if (!atEnd) throw new Bad(i, `malformed number ${JSON.stringify(raw)}`);
    return [undefined, false];
  };

  const parseArray = (): [JsonValue[], boolean] => {
    enter();
    try {
      return parseArrayBody();
    } finally {
      depth--;
    }
  };
  const parseArrayBody = (): [JsonValue[], boolean] => {
    i++;
    const arr: JsonValue[] = [];
    if (root === undefined) root = arr;
    ws();
    if (i < n && text[i] === "]") {
      i++;
      return [arr, true];
    }
    for (;;) {
      const [v, done] = parseValue();
      if (v !== undefined) arr.push(v);
      if (!done) return [arr, false];
      ws();
      if (i >= n) return [arr, false];
      const c = text[i];
      if (c === ",") {
        i++;
        continue;
      }
      if (c === "]") {
        i++;
        return [arr, true];
      }
      throw new Bad(i, `expected "," or "]" but found ${JSON.stringify(c)}`);
    }
  };

  const parseObject = (): [{ [key: string]: JsonValue }, boolean] => {
    enter();
    try {
      return parseObjectBody();
    } finally {
      depth--;
    }
  };
  const parseObjectBody = (): [{ [key: string]: JsonValue }, boolean] => {
    i++;
    const obj: { [key: string]: JsonValue } = {};
    if (root === undefined) root = obj;
    ws();
    if (i < n && text[i] === "}") {
      i++;
      return [obj, true];
    }
    for (;;) {
      ws();
      if (i >= n) return [obj, false];
      if (text[i] !== '"') throw new Bad(i, "expected a property name");
      const [key, keyDone] = parseString();
      if (!keyDone) return [obj, false];
      ws();
      if (i >= n) return [obj, false];
      if (text[i] !== ":") throw new Bad(i, 'expected ":"');
      i++;
      const [v, done] = parseValue();
      // defineProperty: a "__proto__" key must become an own property, never the prototype.
      if (v !== undefined)
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
      if (!done) return [obj, false];
      ws();
      if (i >= n) return [obj, false];
      const c = text[i];
      if (c === ",") {
        i++;
        continue;
      }
      if (c === "}") {
        i++;
        return [obj, true];
      }
      throw new Bad(i, `expected "," or "}" but found ${JSON.stringify(c)}`);
    }
  };

  try {
    const [value, done] = parseValue();
    if (done) {
      ws();
      if (i < n)
        return { value, complete: false, error: { offset: i, message: "unexpected trailing characters" } };
    }
    return { value, complete: done };
  } catch (e) {
    if (e instanceof Bad)
      return { value: root, complete: false, error: { offset: e.offset, message: e.message } };
    // "never throws": anything else (e.g. a RangeError from an engine limit) also takes the bad-input path
    return {
      value: root,
      complete: false,
      error: { offset: i, message: e instanceof Error ? e.message : String(e) },
    };
  }
}
