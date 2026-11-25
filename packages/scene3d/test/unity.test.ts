/** The game-file readers on synthetic files built in test code (no game bytes): containers, LZMA, LZ4, type trees. */
import { describe, expect, it } from "vitest";
import { DecodeError, UnsupportedFormat, meshBox } from "../src/index";
import { lz4BlockDecompress } from "../src/unity/lz4";
import { lzmaDecompress } from "../src/unity/lzma";
import { LoadedBundle, findPrefabRoot, prefabGeometry } from "../src/unity/prefab";
import { readBundle } from "../src/unity/unityfs";
import {
  cratePrefab,
  lz4Literals,
  lzmaEncodeLiterals,
  serializedFile,
  unityFsBundle,
} from "./synthetic/unity";

/** Bytes that are not too regular: a short xorshift run. */
function noise(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = (i % 3 === 0 ? s : i) & 0xff;
  }
  return out;
}

describe("LZMA decoder", () => {
  it.each([0, 1, 5, 300, 70_000])("decodes a literal stream of %i bytes encoded in the test", (n) => {
    const data = noise(n);
    expect(lzmaDecompress(lzmaEncodeLiterals(data), n)).toEqual(data);
  });

  it("refuses a corrupt stream and a short one", () => {
    const enc = lzmaEncodeLiterals(noise(1000));
    const bad = enc.slice();
    bad[5] = 1; // the range coder's first byte must be 0
    expect(() => lzmaDecompress(bad, 1000)).toThrow(DecodeError);
    expect(() => lzmaDecompress(enc.subarray(0, 200), 1000)).toThrow(DecodeError);
  });
});

describe("LZ4 decoder", () => {
  it("decodes literal runs and back-references", () => {
    const data = noise(400);
    expect(lz4BlockDecompress(lz4Literals(data), 400)).toEqual(data);
    // "abc" then a match of 9 at offset 3 → "abcabcabcabc"
    const block = Uint8Array.from([0x35, 97, 98, 99, 3, 0]);
    expect(String.fromCharCode(...lz4BlockDecompress(block, 12))).toBe("abcabcabcabc");
    expect(() => lz4BlockDecompress(Uint8Array.from([0x10, 97, 9, 0]), 5)).toThrow(DecodeError);
  });
});

describe("UnityFS + serialized file + prefab", () => {
  const sf = serializedFile([...cratePrefab("crate", [2, 0, 3]), ...cratePrefab("barrel", [0, 0, 0], 2n)]);

  it.each([0, 1, 2] as const)("reads the container's files (block compression %i)", (c) => {
    const b = readBundle(unityFsBundle([{ path: "CAB-x", data: sf }], c));
    expect(b.formatVersion).toBe(8);
    expect(b.nodes.map((n) => n.path)).toEqual(["CAB-x"]);
    expect(b.nodes[0]?.data).toEqual(sf);
  });

  it("finds a prefab by name and reads its meshes through the transform hierarchy", () => {
    const lb = new LoadedBundle(unityFsBundle([{ path: "CAB-x", data: sf }]));
    const root = findPrefabRoot(lb, "CRATE");
    expect(root).toBe(101n);
    const g = prefabGeometry(lb, root ?? 0n);
    // the root cube at (2,0,3) and the child cube, scaled 2x, one up from the root
    expect(g.indices.length).toBe(72);
    const b = meshBox(g);
    expect(b.min).toEqual({ x: 2, y: 0, z: 3 });
    expect(b.max).toEqual({ x: 4, y: 3, z: 5 });
    expect(findPrefabRoot(lb, "missing")).toBeUndefined();
  });

  it("refuses formats it was not written for (the source turns this into boxes)", () => {
    expect(() => readBundle(unityFsBundle([{ path: "CAB-x", data: sf }], 0, 9))).toThrow(UnsupportedFormat);
    expect(
      () =>
        new LoadedBundle(
          unityFsBundle([{ path: "CAB-x", data: serializedFile(cratePrefab("c", [0, 0, 0]), 21) }]),
        ),
    ).toThrow(UnsupportedFormat);
    expect(() => readBundle(new Uint8Array(64))).toThrow(UnsupportedFormat);
  });
});
