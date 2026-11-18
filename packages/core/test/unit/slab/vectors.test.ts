import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  base64Encode,
  decodeDetailed,
  encode,
  encodeLayoutsRaw,
  encodeRaw,
  guidToBytes,
  gzip,
  SLAB_MAGIC,
  sha256Hex,
  slabCodec,
  toHex,
} from "../../../src/slab";

interface VectorAsset {
  x?: number;
  y?: number;
  z?: number;
  rot: number;
  u64?: string;
  cx?: number;
}
interface Vector {
  id: string;
  slab: string;
  expected: {
    version: number;
    layoutCount: number;
    totalAssets: number;
    base64Length: number;
    compressedBytes: number;
    decompressedBytes: number;
    decompressedSha256: string;
    trailingBytesHex: string;
    decompressedHex?: string;
    reencodeRawMatches: boolean | null;
    layouts: Array<{ uuid: string; assetCount: number; assets: VectorAsset[]; assetsTruncatedTo?: number }>;
  };
}

const file = fileURLToPath(new URL("../../../../../data/slab-test-vectors.json", import.meta.url));
const vectors = (JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] }).vectors;

describe("slab test vectors (data/slab-test-vectors.json)", () => {
  it("has the 2 MIT-licensed external v2 vectors (data/THIRD-PARTY.md)", () => {
    expect(vectors.map((v) => v.id)).toEqual(["sb-custom-156", "sb-4-floors"]);
    expect(vectors.every((v) => v.expected.version === 2)).toBe(true);
  });

  for (const v of vectors) {
    describe(v.id, () => {
      const d = decodeDetailed(v.slab);
      const e = v.expected;

      it("decodes header, counts, sizes and payload hash", () => {
        expect(d.version).toBe(e.version);
        expect(d.layouts).toHaveLength(e.layoutCount);
        expect(d.assets).toHaveLength(e.totalAssets);
        expect(d.rawBytes).toBe(e.decompressedBytes);
        expect(d.compressedBytes).toBe(e.compressedBytes);
        expect(sha256Hex(d.raw)).toBe(e.decompressedSha256);
        if (e.decompressedHex) expect(toHex(d.raw).toUpperCase()).toBe(e.decompressedHex);
        if (e.version === 2) {
          expect(
            toHex(d.trailing)
              .toUpperCase()
              .replace(/(..)(?!$)/g, "$1 "),
          ).toBe(e.trailingBytesHex);
          expect(d.nonZeroExtraBits).toBe(0);
        }
      });

      it("decodes layouts and listed instances", () => {
        let offset = 0;
        e.layouts.forEach((l, i) => {
          const got = d.layouts[i];
          expect(got?.uuid).toBe(l.uuid);
          expect(got?.count).toBe(l.assetCount);
          if (e.version === 2) {
            l.assets.forEach((a, j) => {
              const g = d.assets[offset + j];
              expect(g).toMatchObject({ uuid: l.uuid, sx: a.x, sy: a.y, sz: a.z, rot: a.rot });
            });
          } else {
            l.assets.forEach((a, j) => {
              const g = d.v1?.instances[offset + j];
              expect(g?.center.x).toBeCloseTo(a.cx ?? NaN, 4);
              expect(g?.rot).toBe(a.rot);
            });
          }
          offset += l.assetCount;
        });
      });

      if (e.version === 2) {
        it("re-encodes to the identical raw payload", () => {
          const raw = encodeRaw(d.assets);
          expect(raw.length).toBe(e.decompressedBytes);
          expect(sha256Hex(raw)).toBe(e.decompressedSha256);
          expect(toHex(raw)).toBe(toHex(d.raw));
          // Layout order preserved explicitly also reproduces it (sorting matched the game's order).
          const byLayout = d.layouts.map((l) => ({
            uuid: l.uuid,
            assets: d.assets.filter((a) => a.uuid === l.uuid),
          }));
          expect(toHex(encodeLayoutsRaw(byLayout))).toBe(toHex(d.raw));
        });

        it("full encode round-trips through gzip/base64", () => {
          const r = encode(d.assets);
          expect(r.rawBytes).toBe(e.decompressedBytes);
          const back = decodeDetailed(r.slab);
          expect(toHex(back.raw)).toBe(toHex(d.raw));
          expect(r.compressedBytes).toBeLessThanOrEqual(slabCodec.limits.maxCompressedBytes);
        });
      }
    });
  }
});

// Self-generated slabs replace the third-party vectors that could not be redistributed. They cover what those
// covered beyond the two external vectors: several layouts, every rotation, props off the grid, large
// coordinates, a big slab, and a legacy v1 payload.
const UUIDS = [
  "e62c6746-cecf-46bf-8b20-f81738f1d220",
  "01a05c16-e23c-4d23-9b6e-c9ac81736ca2",
  "db607b82-e107-412c-a899-33afe30c6368",
  "eba101cd-f1c1-4568-b330-b66ab33bf325",
];

function syntheticAssets(
  n: number,
): Array<{ uuid: string; sx: number; sy: number; sz: number; rot: number }> {
  let seed = 12345;
  const rnd = (m: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % m;
  };
  return Array.from({ length: n }, (_, i) => ({
    uuid: UUIDS[i % UUIDS.length] ?? "",
    sx: rnd(250000),
    sy: rnd(1000) * 25,
    sz: rnd(250000),
    rot: i % 24,
  }));
}

describe("self-generated slabs (own encoder)", () => {
  for (const n of [1, 8, 25, 1500]) {
    it(`${n} assets in up to 4 layouts round-trip exactly`, () => {
      const assets = syntheticAssets(n);
      const r = encode(assets);
      const d = decodeDetailed(r.slab);
      expect(d.version).toBe(2);
      expect(d.layouts).toHaveLength(Math.min(n, UUIDS.length));
      expect(d.assets).toHaveLength(n);
      expect(toHex(d.trailing)).toBe("0000");
      expect(d.nonZeroExtraBits).toBe(0);
      const key = (a: { uuid: string; sx: number; sy: number; sz: number; rot: number }): string =>
        `${a.uuid}|${a.sx}|${a.sy}|${a.sz}|${a.rot}`;
      expect(d.assets.map(key).sort()).toEqual(assets.map(key).sort());
      expect(toHex(encodeRaw(d.assets))).toBe(toHex(d.raw));
    });
  }

  it("decodes a hand-built legacy v1 payload", () => {
    // header: magic, version 1, 2 layouts; layouts: guid + u16 count + u16 pad; 28-byte instances; bounds footer.
    const inst = [
      { uuid: UUIDS[0] ?? "", c: [3.5, 0.25, 2.5], h: [0.5, 0.25, 0.5], rot: 6 },
      { uuid: UUIDS[0] ?? "", c: [5.5, 0.25, 2.5], h: [0.5, 0.25, 0.5], rot: 0 },
      { uuid: UUIDS[1] ?? "", c: [4.5, 1.25, 3.5], h: [0.5, 0.5, 0.5], rot: 18 },
    ];
    const raw = new Uint8Array(8 + 2 * 20 + 3 * 28 + 24);
    const dv = new DataView(raw.buffer);
    dv.setUint32(0, SLAB_MAGIC, true);
    dv.setUint16(4, 1, true);
    dv.setUint16(6, 2, true);
    let p = 8;
    for (const [u, count] of [
      [UUIDS[0] ?? "", 2],
      [UUIDS[1] ?? "", 1],
    ] as const) {
      guidToBytes(u, raw, p);
      dv.setUint16(p + 16, count, true);
      p += 20;
    }
    for (const a of inst) {
      [...a.c, ...a.h].forEach((f, k) => {
        dv.setFloat32(p + 4 * k, f, true);
      });
      raw[p + 24] = a.rot;
      p += 28;
    }
    [4.5, 0.75, 3, 3, 1.5, 2].forEach((f, k) => {
      dv.setFloat32(p + 4 * k, f, true);
    });
    const d = decodeDetailed(base64Encode(gzip(raw)));
    expect(d.version).toBe(1);
    expect(d.layouts.map((l) => l.count)).toEqual([2, 1]);
    expect(d.v1?.instances.map((i) => i.center.x)).toEqual([3.5, 5.5, 4.5]);
    expect(d.v1?.bounds?.size).toEqual({ x: 3, y: 1.5, z: 2 });
    // v2 semantics: min corners, normalised so the smallest is at floor(min).
    expect(d.assets).toEqual([
      { uuid: UUIDS[0], sx: 0, sy: 0, sz: 0, rot: 6 },
      { uuid: UUIDS[0], sx: 200, sy: 0, sz: 0, rot: 0 },
      { uuid: UUIDS[1], sx: 100, sy: 75, sz: 100, rot: 18 },
    ]);
  });
});

describe("worked example (format doc §3)", () => {
  it("encodes one Tavern Floor 03 at (3, 0.5, 2) rot 6 to the documented 40 bytes", () => {
    const raw = encodeRaw([
      {
        uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220",
        sx: slabCodec.toScaled(3),
        sy: slabCodec.toScaled(0.5),
        sz: slabCodec.toScaled(2),
        rot: slabCodec.degreesToRot(90),
      },
    ]);
    expect(toHex(raw).toUpperCase()).toBe(
      "CEFACED1020001000000" + "46672CE6CFCEBF468B20F81738F1D220" + "01000000" + "2C01C800800C8001" + "0000",
    );
  });

  it("decodes the documented .NET GZipStream string", () => {
    const d = decodeDetailed(
      "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==",
    );
    expect(d.assets).toEqual([
      { uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", sx: 300, sy: 50, sz: 200, rot: 6 },
    ]);
  });

  it("gzip output is deterministic (mtime 0)", () => {
    const raw = encodeRaw([{ uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", sx: 0, sy: 0, sz: 0, rot: 0 }]);
    const a = base64Encode(gzip(raw));
    const b = base64Encode(gzip(raw));
    expect(a).toBe(b);
    expect(toHex(gzip(raw).subarray(4, 8))).toBe("00000000");
  });
});
