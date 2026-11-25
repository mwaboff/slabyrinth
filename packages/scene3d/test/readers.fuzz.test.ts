/**
 * The game-file readers on damaged synthetic files (unity/bounded.ts: every size, count, offset and stride from a file
 * is a claim): truncated at every length, and every aligned 32-bit field set to negative, huge and zero values. Each
 * reader either reads the file or fails with a typed error (DecodeError or UnsupportedFormat), within bounded time and
 * without allocating what a field claims. No game bytes: the files are built in test code.
 */
import { describe, expect, it } from "vitest";
import { DecodeError, UnsupportedFormat, unityExtractor } from "../src/index";
import { READ_LIMITS } from "../src/unity/bounded";
import { lz4BlockDecompress } from "../src/unity/lz4";
import { lzmaDecompress } from "../src/unity/lzma";
import { meshGeometry, LoadedBundle } from "../src/unity/prefab";
import { readSerializedFile } from "../src/unity/serialized";
import { readBundle } from "../src/unity/unityfs";
import {
  cratePrefab,
  lz4Literals,
  lzmaEncodeLiterals,
  serializedFile,
  unityFsBundle,
} from "./synthetic/unity";

const typed = (e: unknown): boolean => e instanceof DecodeError || e instanceof UnsupportedFormat;

/** Runs the whole extractor on `bytes`: every failure, of the bundle or of a prefab, must be a typed error. */
function extractTyped(bytes: Uint8Array): string | null {
  try {
    const got = unityExtractor(bytes, ["crate"]);
    for (const v of got.values())
      if (v instanceof Error && !typed(v) && !/^no prefab/.test(v.message)) return `${v.name}: ${v.message}`;
    return null;
  } catch (e) {
    return typed(e) ? null : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

/** Every 4-byte-aligned field of `bytes` set to each of the values, both byte orders. */
function* mutations(bytes: Uint8Array): Generator<Uint8Array> {
  const values = [0xffffffff, 0x80000000, 0x7fffffff, 0x40000000, 0, 1];
  for (let at = 0; at + 4 <= bytes.length; at += 4)
    for (const v of values)
      for (const little of [true, false]) {
        const b = bytes.slice();
        new DataView(b.buffer).setUint32(at, v, little);
        yield b;
      }
}

const crate = serializedFile(cratePrefab("crate", [1, 0, 2]));

describe("bounded readers", () => {
  it.each([0, 2] as const)(
    "a bundle (compression %i) damaged in any field fails cleanly or reads",
    (compression) => {
      const bundle = unityFsBundle([{ path: "CAB-x", data: crate }], compression);
      const bad: string[] = [];
      const t0 = performance.now();
      for (const b of mutations(bundle)) {
        const r = extractTyped(b);
        if (r) bad.push(r);
      }
      expect(bad.slice(0, 5)).toEqual([]);
      // ~10k damaged bundles: a field that drove a loop or an allocation would take far longer
      expect(performance.now() - t0).toBeLessThan(20_000);
    },
  );

  it("a bundle truncated at any length fails cleanly", () => {
    for (const compression of [0, 1, 2] as const) {
      const bundle = unityFsBundle([{ path: "CAB-x", data: crate }], compression);
      for (let n = 0; n < bundle.length; n += 7) expect(extractTyped(bundle.subarray(0, n))).toBeNull();
    }
  });

  it("refuses a negative dependency count instead of rewinding (an endless loop before)", () => {
    // the synthetic writer's layout: a 48-byte header, the Unity version string, platform, type-tree flag, the type
    // count, then the first type: class id, stripped, script index, 16-byte hash, its tree, its dependency count
    const typeCountAt = 48 + "2021.3.45f2".length + 1 + 4 + 1;
    const typeAt = typeCountAt + 4;
    const dv0 = new DataView(crate.buffer, crate.byteOffset, crate.byteLength);
    const treeAt = typeAt + 4 + 1 + 2 + 16;
    const nodes = dv0.getInt32(treeAt, true);
    const strs = dv0.getInt32(treeAt + 4, true);
    const depsAt = treeAt + 8 + nodes * 32 + strs;
    expect(dv0.getInt32(depsAt, true)).toBe(0);
    // a dependency count that rewinds to the start of the type, under a huge type count: the old reader went round
    // that type for ever
    const b = crate.slice();
    const dv = new DataView(b.buffer);
    dv.setInt32(depsAt, -(depsAt + 4 - typeAt) / 4, true);
    dv.setInt32(typeCountAt, 0x7fffffff, true);
    expect(() => readSerializedFile(b)).toThrow(DecodeError);
    // and alone, under the real type count
    const c = crate.slice();
    new DataView(c.buffer).setInt32(depsAt, -1, true);
    expect(() => readSerializedFile(c)).toThrow(DecodeError);
  });

  it("refuses a size it would have to allocate before allocating it", () => {
    // 4 GiB asked of a block of 10 bytes, in each decoder
    expect(() => lz4BlockDecompress(lz4Literals(new Uint8Array(10)), 2 ** 32)).toThrow(DecodeError);
    expect(() => lzmaDecompress(lzmaEncodeLiterals(new Uint8Array(10)), 2 ** 32)).toThrow(DecodeError);
    expect(() => lz4BlockDecompress(new Uint8Array(4), READ_LIMITS.lz4Ratio * 10)).toThrow(DecodeError);
    expect(() => lz4BlockDecompress(new Uint8Array(4), -1)).toThrow(DecodeError);
    // a container whose blocks info claims 4 GiB unpacked
    const bundle = unityFsBundle([{ path: "CAB-x", data: crate }], 0);
    const huge = bundle.slice();
    const r = new DataView(huge.buffer);
    // header: "UnityFS\0" u32 format, "5.x.x\0", "2021.3.45f2\0", i64 size, u32 ci, u32 ui, u32 flags
    const uiAt = 8 + 4 + 6 + 12 + 8 + 4;
    r.setUint32(uiAt, 0xffffffff, false);
    r.setUint32(uiAt + 4, 2, false); // the blocks info "LZ4"-packed, so the claimed size is what is allocated
    expect(() => readBundle(huge)).toThrow(DecodeError);
  });

  it("refuses a node with a negative offset (it read the tail of the file before)", () => {
    const bundle = unityFsBundle([{ path: "CAB-x", data: crate }], 0);
    const b = bundle.slice();
    const dv = new DataView(b.buffer);
    // the node record: after the header (aligned to 16), the 16-byte hash, the block count and one 10-byte block
    let at = 8 + 4 + 6 + 12 + 8 + 12;
    at = (at + 15) & ~15;
    at += 16 + 4 + 10 + 4;
    dv.setBigInt64(at, -100n, false);
    expect(() => readBundle(b)).toThrow(DecodeError);
  });

  it("refuses a zero vertex stride with a huge vertex count (gigabytes allocated before)", () => {
    const objects = cratePrefab("crate", [0, 0, 0]);
    const mesh = objects.find((o) => o.type === "Mesh");
    const vd = mesh?.value["m_VertexData"];
    if (!mesh || typeof vd !== "object" || vd instanceof Uint8Array || Array.isArray(vd))
      throw new Error("fixture");
    const withChannel = (dimension: number, count: number): Uint8Array =>
      unityFsBundle([
        {
          path: "CAB-x",
          data: serializedFile(
            objects.map((o) =>
              o === mesh
                ? {
                    ...o,
                    value: {
                      ...o.value,
                      m_VertexData: {
                        ...vd,
                        m_VertexCount: count,
                        m_Channels: [{ stream: 0, offset: 0, format: 0, dimension }],
                      },
                    },
                  }
                : o,
            ),
          ),
        },
      ]);
    // dimension 0x30: the old check read it as 48 (>= 3) and the stride as 0
    const lb = new LoadedBundle(withChannel(0x30, 0x7fffffff));
    const meshObj = lb.get(105n);
    if (!meshObj) throw new Error("fixture mesh");
    expect(() => meshGeometry(lb, meshObj)).toThrow(DecodeError);
    const lb2 = new LoadedBundle(withChannel(3, 0x7fffffff));
    const meshObj2 = lb2.get(105n);
    if (!meshObj2) throw new Error("fixture mesh");
    expect(() => meshGeometry(lb2, meshObj2)).toThrow(DecodeError);
  });
});
