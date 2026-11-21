import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canonicalJson,
  canonicalEqual,
  createPrng,
  editDistance,
  elementSeed,
  fnv1a32Bytes,
  h32,
  h32Utf16,
  hashUnitUtf16,
  h64hex,
  latticeValue,
  nearest,
  parsePartialJson,
  splitmix32,
  subSeed,
  utf8Bytes,
  utf8Length,
} from "../../../src/util";

/** Independent BigInt reference for FNV-1a 64. */
function fnv64Ref(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

describe("hash", () => {
  it("matches published FNV-1a 32 vectors", () => {
    expect(h32("")).toBe(0x811c9dc5);
    expect(h32("a")).toBe(0xe40c292c);
    expect(h32("foobar")).toBe(0xbf9cf968);
  });
  it("h32Utf16 (the compiler's frozen hash) agrees with h32 on ASCII and differs on other characters", () => {
    for (const s of ["", "a", "foobar", "42:l1:walltops"]) expect(h32Utf16(s), s).toBe(h32(s));
    expect(h32Utf16("é")).not.toBe(h32("é"));
    // pinned: released slabs depend on these values
    expect(h32Utf16("é")).toBe(0x6c0b6c44);
    expect(hashUnitUtf16("a", 1)).toBeCloseTo(h32("a:1") / 2 ** 32, 12);
  });
  it("matches published FNV-1a 64 vectors", () => {
    expect(h64hex("")).toBe("cbf29ce484222325");
    expect(h64hex("a")).toBe("af63dc4c8601ec8c");
    expect(h64hex("foobar")).toBe("85944171f73967e8");
  });
  it("encodes UTF-8 like TextEncoder (incl. astral and lone surrogates)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const ref = new TextEncoder().encode(s);
        expect(Array.from(utf8Bytes(s))).toEqual(Array.from(ref));
        expect(utf8Length(s)).toBe(ref.length);
        expect(h32(s)).toBe(fnv1a32Bytes(ref));
        expect(h64hex(s)).toBe(fnv64Ref(s));
      }),
      { numRuns: 300 },
    );
    expect(utf8Bytes("\ud800")).toEqual(Uint8Array.from([0xef, 0xbf, 0xbd]));
  });
  it("derives seeds as §2.7 specifies (frozen values)", () => {
    expect(elementSeed(41177, "rocks")).toBe(h32("41177:rocks"));
    expect(elementSeed(41177, "rocks")).toBe(1466822355);
    expect(elementSeed(41177, "rocks", 7)).toBe(7);
    expect(subSeed(7, "fill")).toBe(h32("7:fill"));
    expect(latticeValue(7, 3, -2)).toBe(h32("7:3:-2") / 2 ** 32);
    expect(latticeValue(7, 3, -2)).toBe(0.7454181625507772);
    expect(h64hex("ünïcødé 🐉")).toBe("fc16183c1b26df9a");
  });
});

describe("prng (sfc32 via splitmix32)", () => {
  it("produces frozen output (generator v1)", () => {
    const p = createPrng(41177);
    expect([p.nextU32(), p.nextU32(), p.nextU32(), p.nextU32(), p.nextU32()]).toEqual([
      2800366517, 31032003, 2116973060, 2320397719, 2301776426,
    ]);
    const q = createPrng(0);
    expect([q.nextU32(), q.nextU32(), q.nextU32()]).toEqual([1101400650, 3019924254, 1223568846]);
    expect(createPrng(7).shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([3, 0, 8, 5, 4, 6, 1, 7, 9, 2]);
  });
  it("is deterministic and seeds differ", () => {
    const a = createPrng(123);
    const b = createPrng(123);
    const c = createPrng(124);
    const sa = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(sa);
  });
  it("stays in range and is roughly uniform", () => {
    const p = createPrng(99);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const k = Math.floor(v * 10);
      buckets[k] = (buckets[k] ?? 0) + 1;
    }
    for (const b of buckets) expect(Math.abs(b - 2000)).toBeLessThan(250);
    for (let i = 0; i < 1000; i++) {
      const r = p.range(-3, 3);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThanOrEqual(3);
    }
  });
  it("shuffle is a permutation and does not mutate input", () => {
    const src = [1, 2, 3, 4, 5];
    const out = createPrng(5).shuffle(src);
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(src);
    expect(() => createPrng(1).pick([])).toThrow(RangeError);
  });
  it("splitmix32 treats seeds as 32-bit", () => {
    expect(splitmix32(1)()).toBe(splitmix32(1 + 2 ** 32)());
  });
});

describe("canonical JSON", () => {
  it("sorts keys, drops undefined, normalizes -0, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: -0 }], e: "x" })).toBe(
      '{"a":[1,{"c":0}],"b":1,"e":"x"}',
    );
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(canonicalEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonicalJson(Uint8Array.from([1, 2]))).toBe("[1,2]");
  });
  it("throws on non-JSON values", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
  it("round-trips through JSON.parse to an equal value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(canonicalJson(JSON.parse(canonicalJson(v)))).toBe(canonicalJson(v));
      }),
      { numRuns: 200 },
    );
  });
});

describe("partial JSON: nesting limit", () => {
  it("very deep input takes the bad-input path instead of overflowing the stack", () => {
    const deep = "[".repeat(100_000);
    const r = parsePartialJson(deep);
    expect(r.complete).toBe(false);
    expect(r.error?.message).toMatch(/nesting deeper than 256/);
    const objs = '{"a":'.repeat(100_000);
    expect(() => parsePartialJson(objs)).not.toThrow();
    expect(parsePartialJson(objs).error).toBeDefined();
  });
  it("nesting up to the limit still parses", () => {
    const ok = "[".repeat(256) + "]".repeat(256);
    expect(parsePartialJson(ok).complete).toBe(true);
    expect(parsePartialJson("[".repeat(257) + "]".repeat(257)).error).toBeDefined();
  });
});

describe("partial JSON", () => {
  it('keeps a "__proto__" key as an own property (never sets the prototype)', () => {
    const v = parsePartialJson('{"__proto__":{"x":1}}').value as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(["__proto__"]);
  });
  it("parses complete documents", () => {
    expect(parsePartialJson('{"a":[1,2,{"b":"c"}],"d":true}')).toEqual({
      value: { a: [1, 2, { b: "c" }], d: true },
      complete: true,
    });
  });
  it("closes open structures and keeps partial strings", () => {
    expect(parsePartialJson('{"ops":[{"op":"add","element":{"kind":"ar').value).toEqual({
      ops: [{ op: "add", element: { kind: "ar" } }],
    });
    expect(parsePartialJson('{"a":12.').value).toEqual({ a: 12 });
    expect(parsePartialJson('{"a":tr').value).toEqual({});
    expect(parsePartialJson('{"a"').value).toEqual({});
    expect(parsePartialJson('["x\\').value).toEqual(["x"]);
    expect(parsePartialJson('["\\u00').value).toEqual([""]);
    expect(parsePartialJson("").value).toBeUndefined();
  });
  it("reports errors without throwing", () => {
    const r = parsePartialJson('{"a":1,}');
    expect(r.complete).toBe(false);
    expect(r.error?.offset).toBe(7);
    expect(parsePartialJson("[1] x").error?.message).toMatch(/trailing/);
  });
  it("every prefix of valid JSON parses without error and the full text is complete", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const text = JSON.stringify(v, null, 1);
        for (let k = 0; k < text.length; k += Math.max(1, Math.floor(text.length / 25))) {
          expect(parsePartialJson(text.slice(0, k)).error).toBeUndefined();
        }
        const full = parsePartialJson(text);
        expect(full.error).toBeUndefined();
        if (typeof v !== "number") {
          expect(full.complete).toBe(true);
          expect(canonicalJson(full.value)).toBe(canonicalJson(JSON.parse(text)));
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("strings", () => {
  it("edit distance and nearest", () => {
    expect(editDistance("hal", "hall")).toBe(1);
    expect(nearest("hal", ["entry", "hall", "guard"])).toBe("hall");
    expect(nearest("zzzzzz", ["entry", "hall"])).toBeUndefined();
    expect(nearest("floorheight", ["floor", "floorHeight"])).toBe("floorHeight");
  });
});
