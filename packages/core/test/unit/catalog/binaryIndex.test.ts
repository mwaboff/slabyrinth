import { describe, expect, it } from "vitest";
import {
  IndexFormatError,
  binaryIndexSource,
  indexJsonSource,
  readBinaryIndex,
  readBinaryIndexParts,
  readIndexJson,
  round4,
} from "../../../src/catalog";
import { FIXTURE_ASSETS, buildIndexFixture } from "./indexFixture";

const pack = {
  packId: "d71427a1-5535-4fa7-82d7-4ca1e75edbfd",
  dirName: "d71427a1-5535-4fa7-82d7-4ca1e75edbfd",
};

describe("binary index reader (v5 byte fixtures)", () => {
  const bytes = buildIndexFixture(FIXTURE_ASSETS);

  it("parses header, search table and board objects", () => {
    const r = readBinaryIndex(bytes);
    expect(r.version).toBe(5);
    expect(r.schemaId).toBe("2061c3a8-4467-113e-1ab5-705888f6959f");
    expect(r.packName).toBe("Fixture Pack");
    expect(r.rows.map((x) => x.kind)).toEqual(["tile", "tile", "prop", "creature"]);
    expect(r.boardObjectCount).toBe(3);
    expect(r.warnings).toEqual([]);
    expect(r.rows[0]?.tags).toEqual(["1x1", "dungeon", "wall"]);
    expect(r.rows[3]?.category).toBe("CREATURE Humanoid");
  });

  it("builds catalog records like Extract-AssetCatalog.ps1", () => {
    const res = binaryIndexSource.read(bytes, pack);
    expect(res.packName).toBe("Fixture Pack");
    expect(res.assets).toHaveLength(3); // creatures skipped
    const [wall, floor, chest] = res.assets;
    expect(wall).toMatchObject({
      uuid: "63270c8a-9484-4ae8-926e-22e3de9048a1",
      name: "Dungeon Wall 01",
      kind: "tile",
      pack: "Fixture Pack",
      packId: pack.packId,
      folder: "Dungeon Cellar",
      groupTag: "wall",
      deprecated: false,
      interactable: false,
      size: { x: 1, y: 2, z: 0.5 },
      footprintCells: { x: 1, z: 1 },
      boundsCenter: { x: 0.5, y: 1, z: 0.25 },
      boundsMin: { x: 0, y: 0, z: 0 },
      originAt: "minCorner",
      sizeTag: "1x1",
      meshParts: 1,
    });
    expect(floor?.deprecated).toBe(true);
    expect(floor?.sizeTag).toBe("2x2");
    expect(chest).toMatchObject({
      kind: "prop",
      interactable: true,
      originAt: "center",
      meshParts: 2,
      footprintCells: { x: 1, z: 1 },
    });
    expect(chest?.size.x).toBe(0.85);
    expect(chest?.sizeTag).toBeUndefined();
  });

  it("canRead checks the file name and magic", () => {
    expect(binaryIndexSource.canRead("index", bytes.subarray(0, 16))).toBe(true);
    expect(binaryIndexSource.canRead("index.json", bytes.subarray(0, 16))).toBe(false);
    expect(binaryIndexSource.canRead("index", new Uint8Array(16))).toBe(false);
  });

  describe("hard checks throw IndexFormatError", () => {
    const cases: Array<[string, () => Uint8Array]> = [
      ["too short", () => bytes.subarray(0, 0x20)],
      [
        "bad magic",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv) => {
              dv.setUint32(0, 0x12345678, true);
            },
          }),
      ],
      [
        "root out of range",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (b, dv) => {
              dv.setUint32(8, b.length + 10, true);
            },
          }),
      ],
      ["truncated file", () => bytes.subarray(0, bytes.length - 100)],
      [
        "column count mismatch",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv, at) => {
              dv.setUint32(at.table + 8 * 3 + 4, 7, true);
            },
          }),
      ],
      [
        "pointer outside file",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv, at) => {
              dv.setInt32(at.root + 8, 0x7fffff00, true);
            },
          }),
      ],
      [
        "implausible string length",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv, at) => {
              dv.setUint32(at.root + 4, 200000, true);
            },
          }),
      ],
      [
        "board name mismatch",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            boardNameOverride: { "63270c8a-9484-4ae8-926e-22e3de9048a1": "Other" },
          }),
      ],
      [
        "board count != tile+prop rows",
        () => buildIndexFixture(FIXTURE_ASSETS, { omitBoard: ["e62c6746-cecf-46bf-8b20-f81738f1d220"] }),
      ],
      [
        "board id missing from search table",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (b, _dv, at) => b.fill(0x11, at.boards + 8, at.boards + 24),
          }),
      ],
      [
        "non-finite extent",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv, at) => {
              dv.setFloat32(at.boards + 72, Number.NaN, true);
            },
          }),
      ],
      [
        "huge extent",
        () =>
          buildIndexFixture(FIXTURE_ASSETS, {
            corrupt: (_b, dv, at) => {
              dv.setFloat32(at.boards + 76, 5000, true);
            },
          }),
      ],
    ];
    for (const [name, make] of cases) {
      it(name, () => {
        expect(() => readBinaryIndex(make())).toThrow(IndexFormatError);
      });
    }
  });

  describe("soft checks warn and continue", () => {
    it("unknown version", () => {
      const r = readBinaryIndex(buildIndexFixture(FIXTURE_ASSETS, { version: 6 }));
      expect(r.warnings.join()).toMatch(/unknown index version 6/);
      expect(r.boardObjectCount).toBe(3);
    });
    it("unknown schema id", () => {
      const r = readBinaryIndex(
        buildIndexFixture(FIXTURE_ASSETS, { schema: "00000000-0000-0000-0000-000000000001" }),
      );
      expect(r.warnings.join()).toMatch(/unknown schema id/);
    });
    it("unknown flag bits and kind codes", () => {
      const assets = FIXTURE_ASSETS.map((a, i) => (i === 0 ? { ...a, flags: 8 } : a));
      assets.push({ id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Odd", kind: 4 });
      const r = readBinaryIndex(
        buildIndexFixture(assets, {
          corrupt: (_b, dv, at) => {
            // set the last row's kind code to 9 (column 9 starts after the other columns)
            const n = assets.length;
            const col9 = at.table + 80 + (16 + 8 + 8 + 8 + 12 + 8 + 8 + 4 + 64) * n;
            dv.setUint32(col9 + 4 * (n - 1), 9, true);
          },
        }),
      );
      expect(r.warnings.join()).toMatch(/unknown flag bits 0x8/);
      expect(r.warnings.join()).toMatch(/unknown kind code 9/);
    });
  });
});

describe("index.json fallback reader", () => {
  const json = JSON.stringify({
    Name: "Medieval Fantasy",
    Tiles: [
      {
        Id: "63270C8A-9484-4AE8-926E-22E3DE9048A1",
        Name: "Dungeon Wall 01",
        IsDeprecated: false,
        GroupTag: "wall",
        Tags: ["1x1"],
        Folder: "Dungeon Cellar",
        Assets: [{}],
        IsInteractable: false,
        ColliderBoundsBound: { m_Center: { x: 0.5, y: 1, z: 0.25 }, m_Extent: { x: 0.5, y: 1, z: 0.25 } },
      },
      { Id: "bad", Name: "Broken" },
    ],
    Props: [
      {
        Id: "3da5dbe8-132e-4cab-b539-cedc04b22099",
        Name: "Torch",
        IsDeprecated: true,
        GroupTag: "",
        Tags: [],
        Folder: "Lights",
        Assets: [{}, {}],
        IsInteractable: true,
        ColliderBoundsBound: {
          m_Center: { x: -0.0016, y: 0.1673, z: 0.1663 },
          m_Extent: { x: 0.093, y: 0.378, z: 0.166 },
        },
      },
    ],
    Creatures: [],
  });
  it("reads tiles and props with derived fields", () => {
    const r = readIndexJson("﻿" + json, { packId: "p" });
    expect(r.packName).toBe("Medieval Fantasy");
    expect(r.assets.map((a) => [a.uuid, a.kind, a.originAt, a.deprecated, a.meshParts])).toEqual([
      ["63270c8a-9484-4ae8-926e-22e3de9048a1", "tile", "minCorner", false, 1],
      ["3da5dbe8-132e-4cab-b539-cedc04b22099", "prop", "other", true, 2],
    ]);
    expect(r.warnings.join()).toMatch(/invalid Id/);
  });
  it("canRead sniffs JSON", () => {
    expect(indexJsonSource.canRead("index.json", new TextEncoder().encode('  {"Name"'))).toBe(true);
    expect(indexJsonSource.canRead("index", new TextEncoder().encode("{"))).toBe(false);
  });
  it("throws on non-JSON", () => {
    expect(() => readIndexJson("nope", { packId: "p" })).toThrow();
  });
});

describe("round4", () => {
  it("rounds half to even like .NET Math.Round", () => {
    expect(round4(0.12345)).toBeCloseTo(0.1234, 10);
    expect(round4(0.12355)).toBeCloseTo(0.1236, 10);
    expect(round4(2.028 + 1e-13)).toBe(2.028);
    expect(round4(-0.00001)).toBe(0);
  });
});

describe("binary index mesh parts (loader table)", () => {
  const [wall, floor, chest] = FIXTURE_ASSETS;
  const beam = "65ae64bc-8d63-4fce-92ca-a0496f157e19";
  const lid = "11111111-2222-4333-8444-555555555555";
  const bytes = buildIndexFixture(FIXTURE_ASSETS, {
    parts: {
      [wall?.id ?? ""]: [
        { bundleId: "tileset_walls_1", assetName: "wall_a", contentId: beam, position: [0.5, 0, 0.25] },
      ],
      [chest?.id ?? ""]: [
        {
          bundleId: "props_1",
          assetName: "chest_body",
          contentId: "99999999-2222-4333-8444-555555555555",
          rotation: [0, 0.7071, 0, 0.7071],
          scale: [2, 2, 2],
        },
        { bundleId: "props_1", assetName: "chest_lid", contentId: lid, unlisted: true },
      ],
    },
  });

  it("names each part's prefab and bundle through the content id, with its transform", () => {
    const r = readBinaryIndexParts(bytes);
    expect(r.parts.get(wall?.id ?? "")).toEqual([
      {
        bundleId: "tileset_walls_1",
        assetName: "wall_a",
        position: { x: 0.5, y: 0, z: 0.25 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ]);
    const c = r.parts.get(chest?.id ?? "") ?? [];
    expect(c.map((p) => p.assetName)).toEqual(["chest_body"]);
    expect(c[0]?.rotation.y).toBeCloseTo(0.7071, 4);
    expect(c[0]?.scale).toEqual({ x: 2, y: 2, z: 2 });
    expect(r.parts.get(floor?.id ?? "")).toEqual([]);
    // the lid's content id is not in the loader table
    expect(r.unresolved).toBe(1);
    // the catalog reader still reads the same file
    expect(readBinaryIndex(bytes).rows).toHaveLength(4);
  });

  it("refuses a file that is not a binary index", () => {
    expect(() => readBinaryIndexParts(new Uint8Array(64))).toThrow(IndexFormatError);
  });
});
