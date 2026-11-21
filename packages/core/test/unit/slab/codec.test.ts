import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SlabAsset } from "../../../src/contracts/compiler";
import {
  MAX_SLAB_BASE64_CHARS,
  SlabFormatError,
  base64Decode,
  base64Encode,
  bytesToGuid,
  decode,
  degreesToRot,
  encode,
  encodeRaw,
  fenceSlab,
  guidToBytes,
  packInstance,
  rotToDegrees,
  sha256Hex,
  toHex,
  toScaled,
  unpackInstance,
} from "../../../src/slab";

const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("primitives", () => {
  it("guid byte order matches .NET Guid.ToByteArray()", () => {
    const b = guidToBytes("e62c6746-cecf-46bf-8b20-f81738f1d220");
    expect(toHex(b).toUpperCase()).toBe("46672CE6CFCEBF468B20F81738F1D220");
    expect(bytesToGuid(b)).toBe("e62c6746-cecf-46bf-8b20-f81738f1d220");
    expect(() => guidToBytes("nope")).toThrow();
  });

  it("base64 matches RFC 4648 test vectors", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, b64] of cases) {
      expect(base64Encode(enc(plain))).toBe(b64);
      expect(toHex(base64Decode(b64))).toBe(toHex(enc(plain)));
    }
    expect(toHex(base64Decode("Zm9v\nYmFy"))).toBe(toHex(enc("foobar")));
    expect(() => base64Decode("Zm9v-_")).toThrow();
  });

  it("sha256 matches FIPS test vectors", () => {
    expect(sha256Hex(enc(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("u64 packing straddles bit 32 correctly", () => {
    expect(packInstance(300, 50, 200, 6).toString(16)).toBe("1800c8000c8012c");
    expect(unpackInstance(0x01800c8000c8012cn)).toEqual({ sx: 300, sy: 50, sz: 200, rot: 6, extra: 0 });
    expect(() => packInstance(262144, 0, 0, 0)).toThrow(SlabFormatError);
    expect(() => packInstance(0, -1, 0, 0)).toThrow(SlabFormatError);
    expect(() => packInstance(0, 0, 0, 24)).toThrow(SlabFormatError);
  });

  it("scaling and rotation helpers", () => {
    expect(toScaled(0.285)).toBe(29);
    expect(toScaled(2.5)).toBe(250);
    expect(toScaled(1.005)).toBe(101);
    expect(degreesToRot(90)).toBe(6);
    expect(degreesToRot(-90)).toBe(18);
    expect(degreesToRot(360)).toBe(0);
    expect(() => degreesToRot(10)).toThrow();
    expect(rotToDegrees(23)).toBe(345);
  });
});

describe("decode edge cases", () => {
  const one: SlabAsset[] = [{ uuid: "32cfd208-c363-4434-b817-8ba59faeed17", sx: 0, sy: 0, sz: 0, rot: 0 }];
  it("accepts fences and whitespace", () => {
    const { slab } = encode(one);
    expect(decode(`  \n${fenceSlab(slab)}\n `).assets).toEqual(one);
  });
  it("rejects junk with a SlabFormatError", () => {
    expect(() => decode("")).toThrow(SlabFormatError);
    expect(() => decode("!!!!")).toThrow(SlabFormatError);
    expect(() => decode(base64Encode(enc("not gzip")))).toThrow(SlabFormatError);
  });
  it("preserves unknown uuids verbatim", () => {
    const unknown = [{ uuid: "00000000-1111-2222-3333-444455556666", sx: 1, sy: 2, sz: 3, rot: 4 }];
    expect(decode(encode(unknown).slab).assets).toEqual(unknown);
  });
  it("sorts layouts by uuid and keeps instance order within a layout", () => {
    const a = "ffffffff-0000-0000-0000-000000000000";
    const b = "00000000-0000-0000-0000-000000000001";
    const out = decode(
      encode([
        { uuid: a, sx: 600, sy: 0, sz: 0, rot: 0 },
        { uuid: b, sx: 1, sy: 0, sz: 0, rot: 0 },
        { uuid: a, sx: 200, sy: 0, sz: 0, rot: 0 },
      ]).slab,
    ).assets;
    expect(out.map((x) => [x.uuid, x.sx])).toEqual([
      [b, 1],
      [a, 600],
      [a, 200],
    ]);
  });
  it("uppercase input uuids are normalised", () => {
    const raw1 = encodeRaw([{ uuid: "E62C6746-CECF-46BF-8B20-F81738F1D220", sx: 0, sy: 0, sz: 0, rot: 0 }]);
    const raw2 = encodeRaw([{ uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", sx: 0, sy: 0, sz: 0, rot: 0 }]);
    expect(toHex(raw1)).toBe(toHex(raw2));
  });
});

describe("property: decode(encode(x)) == x (grouped and sorted)", () => {
  const hex = (n: number): fc.Arbitrary<string> =>
    fc
      .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: n, maxLength: n })
      .map((a) => a.join(""));
  const guid = fc.tuple(hex(8), hex(4), hex(4), hex(4), hex(12)).map((p) => p.join("-"));
  const coord = fc.integer({ min: 0, max: 262143 });
  const asset = fc.record({
    uuid: guid,
    sx: coord,
    sy: coord,
    sz: coord,
    rot: fc.integer({ min: 0, max: 23 }),
  });

  it("round-trips arbitrary asset lists", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), asset), { maxLength: 60 }),
        fc.array(guid, { minLength: 5, maxLength: 5 }),
        (items, pool) => {
          // reuse a small uuid pool so layouts get several instances
          const assets = items.map(([k, a]) => ({ ...a, uuid: pool[k] ?? a.uuid }));
          const expected = [...new Set(assets.map((a) => a.uuid))]
            .sort()
            .flatMap((u) => assets.filter((a) => a.uuid === u));
          const r = encode(assets);
          expect(r.rawBytes).toBe(10 + 20 * new Set(assets.map((a) => a.uuid)).size + 8 * assets.length + 2);
          expect(decode(r.slab).assets).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("untrusted input bounds", () => {
  it("rejects a gzip whose declared size (ISIZE) is huge, before allocating", () => {
    const { slab } = encode([{ uuid: "32cfd208-c363-4434-b817-8ba59faeed17", sx: 0, sy: 0, sz: 0, rot: 0 }]);
    const gz = base64Decode(slab);
    new DataView(gz.buffer, gz.byteOffset, gz.byteLength).setUint32(gz.length - 4, 0xfffffff0, true);
    const t0 = Date.now();
    expect(() => decode(base64Encode(gz))).toThrow(/declared payload size .* exceeds the limit/);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("rejects a gzip whose declared size is smaller or larger than the real stream", () => {
    const { slab } = encode([{ uuid: "32cfd208-c363-4434-b817-8ba59faeed17", sx: 0, sy: 0, sz: 0, rot: 0 }]);
    for (const delta of [-8, 8]) {
      const gz = base64Decode(slab);
      const dv = new DataView(gz.buffer, gz.byteOffset, gz.byteLength);
      dv.setUint32(gz.length - 4, dv.getUint32(gz.length - 4, true) + delta, true);
      expect(() => decode(base64Encode(gz))).toThrow(SlabFormatError);
    }
  });
  it("rejects over-long input with a typed error", () => {
    expect(() => decode("A".repeat(MAX_SLAB_BASE64_CHARS + 4))).toThrow(/too long/);
    expect(() => decode(" ".repeat(10) + "A".repeat(3 * MAX_SLAB_BASE64_CHARS))).toThrow(SlabFormatError);
  });
  it("a tiny crafted string with a 4 GB ISIZE is refused", () => {
    const crafted = new Uint8Array([
      0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(() => decode(base64Encode(crafted))).toThrow(SlabFormatError);
  });
});
